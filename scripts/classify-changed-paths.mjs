import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));

/**
 * Paths that provably cannot alter runtime behaviour, the container image, or
 * any validated journey.
 *
 * This is deliberately an allowlist. Anything not matched here — including any
 * path added in future — is treated as executable and runs the full validation
 * set, so the failure mode of an incomplete list is wasted time, never skipped
 * validation.
 *
 * Workflow files are absent on purpose: a change to CI must validate itself.
 */
const nonExecutablePatterns = [
  /^docs\//u,
  /^\.github\/ISSUE_TEMPLATE\//u,
  /^\.github\/pull_request_template\.md$/u,
  /^[^/]+\.md$/u,
  /^\.gitignore$/u,
  /^LICENSE$/u,
];

export function isNonExecutablePath(path) {
  const normalized = String(path).replaceAll("\\", "/").trim();
  if (normalized.length === 0) return true;
  return nonExecutablePatterns.some((pattern) => pattern.test(normalized));
}

export function requiresExecutableValidation(changedPaths) {
  // An empty diff is treated as executable: it means the comparison produced
  // nothing usable, which is not evidence that the change is inert.
  if (!Array.isArray(changedPaths) || changedPaths.length === 0) return true;
  return changedPaths.some((path) => !isNonExecutablePath(path));
}

function changedFilesFromGit(base, head) {
  return execFileSync("git", ["diff", "--name-only", `${base}...${head}`], {
    cwd: repositoryRoot,
    encoding: "utf8",
  })
    .split(/\r?\n/u)
    .map((path) => path.trim())
    .filter(Boolean);
}

function main() {
  const base = process.env.ORBIT_BASE_SHA;
  const head = process.env.ORBIT_HEAD_SHA;

  let executable = true;
  let reason = "no pull-request comparison available";

  if (base && head) {
    try {
      const changedPaths = changedFilesFromGit(base, head);
      executable = requiresExecutableValidation(changedPaths);
      reason = executable
        ? "an executable path changed"
        : `only non-executable paths changed (${changedPaths.length})`;
      for (const path of changedPaths) {
        console.log(`${isNonExecutablePath(path) ? "skip" : "run "} ${path}`);
      }
    } catch (error) {
      // Fail safe: an unreadable comparison must never skip validation.
      executable = true;
      reason = "the change comparison could not be read";
      console.error(`Path classification fell back to full validation: ${String(error?.message ?? error)}`);
    }
  }

  console.log(`Path classification: executable=${executable} (${reason}).`);
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `executable=${executable}\n`);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
