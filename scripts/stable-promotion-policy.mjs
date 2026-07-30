import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

function requireEvidence(value, message) {
  if (value !== true) throw new Error(message);
}

/**
 * Validates the immutable preview metadata and protected branch evidence needed
 * for stable promotion. The returned fields are safe release identifiers.
 */
export function validateStablePromotionCandidate(candidate, evidence) {
  if (!/^sha256:[0-9a-f]{64}$/u.test(candidate.digest ?? "")) {
    throw new Error("Stable promotion requires a valid immutable preview digest.");
  }
  if (!/^v[0-9]+\.[0-9]+\.[0-9]+$/u.test(candidate.version ?? "")) {
    throw new Error("Stable promotion requires a semantic version such as v1.2.3.");
  }
  if (candidate.releaseStage !== "preview") {
    throw new Error("Stable promotion accepts only an image labelled as a preview.");
  }
  if (!/^[0-9a-f]{40}$/u.test(candidate.revision ?? "")) {
    throw new Error("The preview requires a valid source revision.");
  }
  const expectedSourceBranch = `release/${candidate.version}`;
  if (candidate.sourceBranch !== expectedSourceBranch) {
    throw new Error(`The preview must come from ${expectedSourceBranch}.`);
  }
  requireEvidence(
    evidence.mergedIntoMain,
    "The preview revision must be merged into main before stable promotion.",
  );
  requireEvidence(
    evidence.mergedIntoDevelop,
    "The preview revision must be merged back into develop before stable promotion.",
  );
  requireEvidence(
    evidence.mainTreeMatchesRevision,
    "Main must contain the exact preview tree before stable promotion.",
  );
  return {
    digest: candidate.digest,
    version: candidate.version,
    revision: candidate.revision,
    sourceBranch: candidate.sourceBranch,
  };
}

function gitEvidence(revision) {
  const succeeds = (args) => spawnSync("git", args, { stdio: "ignore" }).status === 0;
  return {
    mergedIntoMain: succeeds(["merge-base", "--is-ancestor", revision, "origin/main"]),
    mergedIntoDevelop: succeeds(["merge-base", "--is-ancestor", revision, "origin/develop"]),
    mainTreeMatchesRevision: succeeds(["diff", "--quiet", `${revision}^{tree}`, "origin/main^{tree}"]),
  };
}

function runCli() {
  const candidate = {
    digest: process.env.ORBIT_PREVIEW_DIGEST,
    version: process.env.ORBIT_STABLE_VERSION,
    releaseStage: process.env.ORBIT_PREVIEW_STAGE,
    revision: process.env.ORBIT_PREVIEW_REVISION,
    sourceBranch: process.env.ORBIT_PREVIEW_SOURCE_BRANCH,
  };
  validateStablePromotionCandidate(candidate, gitEvidence(candidate.revision ?? ""));
  process.stdout.write("Stable promotion candidate validated against main and develop.\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    runCli();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : "Stable promotion validation failed."}\n`);
    process.exitCode = 1;
  }
}
