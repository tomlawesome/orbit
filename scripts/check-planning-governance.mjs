import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const policy = JSON.parse(
  readFileSync(new URL("../.github/planning-governance.json", import.meta.url), "utf8"),
);

export function isProtectedPlanningPath(path, configuredPolicy = policy) {
  const normalized = path.replaceAll("\\", "/");
  return configuredPolicy.protectedFiles.includes(normalized)
    || configuredPolicy.protectedPrefixes.some((prefix) => normalized.startsWith(prefix));
}

export function hasPlanningAttestation(body, configuredPolicy = policy) {
  return String(body ?? "")
    .split(/\r?\n/u)
    .some((line) => line.trim() === configuredPolicy.requiredAttestation);
}

function changedFilesFromGit(base, head) {
  if (!base || !head) {
    throw new Error("ORBIT_BASE_SHA and ORBIT_HEAD_SHA are required.");
  }
  return execFileSync(
    "git",
    ["diff", "--name-only", `${base}...${head}`],
    { cwd: repositoryRoot, encoding: "utf8" },
  )
    .split(/\r?\n/u)
    .map((path) => path.trim())
    .filter(Boolean);
}

function main() {
  const filesFlag = process.argv.indexOf("--files");
  const changedFiles = filesFlag >= 0
    ? process.argv.slice(filesFlag + 1)
    : changedFilesFromGit(process.env.ORBIT_BASE_SHA, process.env.ORBIT_HEAD_SHA);
  const protectedChanges = changedFiles.filter((path) => isProtectedPlanningPath(path));

  if (protectedChanges.length === 0) {
    console.log("Planning governance: no protected planning files changed.");
    return;
  }

  if (!hasPlanningAttestation(process.env.ORBIT_PR_BODY)) {
    console.error("Planning governance: protected planning files changed:");
    for (const path of protectedChanges) console.error(`- ${path}`);
    console.error(
      `Add the exact PR-body attestation: ${policy.requiredAttestation}`,
    );
    process.exitCode = 1;
    return;
  }

  console.log(
    `Planning governance: accepted ${policy.requiredPlanningModel} attestation for ${protectedChanges.length} protected file(s).`,
  );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
