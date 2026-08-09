import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const policy = JSON.parse(
  readFileSync(new URL("../.github/planning-governance.json", import.meta.url), "utf8"),
);

const observabilityDeclarationPrefix = "Observability-Impact:";
const observabilityChangedDeclaration = "Observability-Impact: changed";
const observabilityNoneDeclaration = /^Observability-Impact: none — (.+)$/u;
const unexplainedReasonPattern = /^(?:<[^>]+>|specific reason|tbd|todo|n\/?a|none|not applicable|no impact|no operational impact|(?:documentation|docs|test|tests|formatting) only|no runtime changes?|replace(?: this)?(?: with)? .*)\.?$/iu;
const observabilityEntries = [
  {
    label: "Operational event/state",
    pattern: /^(?:[-*]\s*)?Operational event\/state\s*:\s*(.*?)\s*$/iu,
  },
  {
    label: "Failure/recovery",
    pattern: /^(?:[-*]\s*)?Failure\/recovery\s*:\s*(.*?)\s*$/iu,
  },
  {
    label: "Privacy/redaction",
    pattern: /^(?:[-*]\s*)?Privacy\/redaction\s*:\s*(.*?)\s*$/iu,
  },
  {
    label: "Operator-documentation impact",
    pattern: /^(?:[-*]\s*)?Operator-documentation impact\s*:\s*(.*?)\s*$/iu,
  },
];

function isUnexplained(value) {
  const normalized = value.trim();
  return normalized.length === 0 || unexplainedReasonPattern.test(normalized);
}

function bodyLines(body) {
  return String(body ?? "")
    .split(/\r?\n/u)
    .map((line) => line.trim());
}

/** Validate the one PR-body observability declaration and its evidence fields. */
export function validateObservabilityDeclaration(body) {
  const lines = bodyLines(body);
  const declarations = lines.filter((line) => line.startsWith(observabilityDeclarationPrefix));

  if (declarations.length === 0) {
    throw new Error("an Observability-Impact declaration is required");
  }
  if (declarations.length !== 1) {
    throw new Error("exactly one Observability-Impact declaration is required");
  }

  const declaration = declarations[0];
  if (declaration === observabilityChangedDeclaration) {
    const missing = observabilityEntries
      .filter(({ pattern }) => {
        const matches = lines.filter((line) => pattern.test(line));
        return matches.length !== 1 || isUnexplained(matches[0]?.match(pattern)?.[1] ?? "");
      })
      .map(({ label }) => label);
    if (missing.length > 0) {
      throw new Error(
        `Observability-Impact: changed requires concise entries for: ${missing.join(", ")}`,
      );
    }
    return { impact: "changed", reason: null };
  }

  const noneMatch = declaration.match(observabilityNoneDeclaration);
  if (!noneMatch || isUnexplained(noneMatch[1])) {
    throw new Error(
      "the Observability-Impact declaration must be exactly changed or none with a specific reason",
    );
  }
  return { impact: "none", reason: noneMatch[1].trim() };
}

export function isProtectedPlanningPath(path, configuredPolicy = policy) {
  const normalized = path.replaceAll("\\", "/");
  return configuredPolicy.protectedFiles.includes(normalized)
    || configuredPolicy.protectedPrefixes.some((prefix) => normalized.startsWith(prefix));
}

/** Returns the accepted attestation present in the body, or null when none is. */
export function matchedPlanningAttestation(body, configuredPolicy = policy) {
  const lines = String(body ?? "")
    .split(/\r?\n/u)
    .map((line) => line.trim());
  return configuredPolicy.acceptedAttestations
    .find((attestation) => lines.includes(attestation)) ?? null;
}

export function hasPlanningAttestation(body, configuredPolicy = policy) {
  return matchedPlanningAttestation(body, configuredPolicy) !== null;
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
  if (Object.hasOwn(process.env, "ORBIT_PR_BODY")) {
    try {
      validateObservabilityDeclaration(process.env.ORBIT_PR_BODY);
    } catch (error) {
      console.error(`Observability governance: ${error.message}`);
      process.exitCode = 1;
      return;
    }
    console.log("Observability governance: accepted exactly one proportional declaration.");
  }

  const filesFlag = process.argv.indexOf("--files");
  const changedFiles = filesFlag >= 0
    ? process.argv.slice(filesFlag + 1)
    : changedFilesFromGit(process.env.ORBIT_BASE_SHA, process.env.ORBIT_HEAD_SHA);
  const protectedChanges = changedFiles.filter((path) => isProtectedPlanningPath(path));

  if (protectedChanges.length === 0) {
    console.log("Planning governance: no protected planning files changed.");
    return;
  }

  const attestation = matchedPlanningAttestation(process.env.ORBIT_PR_BODY);
  if (!attestation) {
    console.error("Planning governance: protected planning files changed:");
    for (const path of protectedChanges) console.error(`- ${path}`);
    console.error("Add exactly one of these PR-body attestation lines:");
    for (const accepted of policy.acceptedAttestations) console.error(`- ${accepted}`);
    process.exitCode = 1;
    return;
  }

  console.log(
    `Planning governance: accepted "${attestation}" for ${protectedChanges.length} protected file(s).`,
  );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
