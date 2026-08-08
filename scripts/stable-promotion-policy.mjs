import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

function requireEvidence(value, message) {
  if (value !== true) throw new Error(message);
}

function validateCandidateIdentity(candidate) {
  if (!/^sha256:[0-9a-f]{64}$/u.test(candidate.digest ?? "")) {
    throw new Error("Stable promotion requires a valid immutable preview digest.");
  }
  if (!/^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/u.test(candidate.version ?? "")) {
    throw new Error("Stable promotion requires an embedded semantic version such as v1.2.3.");
  }
  if (candidate.releaseStage !== "preview") {
    throw new Error("Stable promotion accepts only an image labelled as a preview.");
  }
  if (!/^[0-9a-f]{40}$/u.test(candidate.revision ?? "")) {
    throw new Error("The preview requires a valid source revision.");
  }
  if (candidate.sourceBranch !== "preview" && !/^hotfix\/[a-zA-Z0-9._-]+$/u.test(candidate.sourceBranch ?? "")) {
    throw new Error("The preview must come from the protected preview lane or a bounded hotfix branch.");
  }
}

export function validatePreviewMergeCandidate(candidate, expectedRevision) {
  validateCandidateIdentity(candidate);
  if (!/^[0-9a-f]{40}$/u.test(expectedRevision ?? "") || candidate.revision !== expectedRevision) {
    throw new Error("The preview image revision must exactly match the stable pull request head.");
  }
  return {
    digest: candidate.digest,
    version: candidate.version,
    revision: candidate.revision,
    sourceBranch: candidate.sourceBranch,
  };
}

/**
 * Validates the immutable preview metadata and protected branch evidence needed
 * for stable promotion. The returned fields are safe release identifiers.
 */
export function validateStablePromotionCandidate(candidate, evidence) {
  validateCandidateIdentity(candidate);
  requireEvidence(
    evidence.mergedIntoMain,
    "The preview revision must be merged into main before stable promotion.",
  );
  requireEvidence(
    evidence.presentInSource,
    "The preview revision must remain on its protected source branch during promotion.",
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

function gitEvidence(revision, sourceBranch) {
  const succeeds = (args) => spawnSync("git", args, { stdio: "ignore" }).status === 0;
  return {
    mergedIntoMain: succeeds(["merge-base", "--is-ancestor", revision, "origin/main"]),
    presentInSource: succeeds(["merge-base", "--is-ancestor", revision, `origin/${sourceBranch}`]),
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
  if (process.env.ORBIT_PROMOTION_PHASE === "merge") {
    validatePreviewMergeCandidate(candidate, process.env.ORBIT_EXPECTED_PREVIEW_REVISION);
    process.stdout.write("Preview identity validated for stable merge.\n");
    return;
  }
  if (process.env.ORBIT_PROMOTION_PHASE !== "promote") {
    throw new Error("Promotion phase must be merge or promote.");
  }
  validateStablePromotionCandidate(
    candidate,
    gitEvidence(candidate.revision ?? "", candidate.sourceBranch ?? ""),
  );
  process.stdout.write("Stable promotion candidate validated against main and its preview source.\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    runCli();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : "Stable promotion validation failed."}\n`);
    process.exitCode = 1;
  }
}
