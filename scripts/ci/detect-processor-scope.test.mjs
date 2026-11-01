import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { PROCESS_TEST_TIMEOUT_MS, failOnProcessDeadline, processGuard } from "../process-budget.mjs";

/*
 * The gate that decides whether the minutes-long hostile-document processor
 * check runs (#801), and the gap #1607 found in it: it compared HEAD with HEAD^
 * only, so a merge request that weakened the processor's confinement in an
 * early commit and ended with an unrelated one had the check skipped.
 *
 * Run against a copy of the script inside a throwaway Git repository, because
 * it resolves its repository root from where it sits and asks Git about that
 * root. Each case builds the history it is about, with the variables the
 * `acceptance` job really has: CI_MERGE_REQUEST_DIFF_BASE_SHA on a merge
 * request pipeline (the merge base with the target branch), nothing on a push
 * to dev, where HEAD^ is the previous tip (or, for a merge commit, the first
 * parent).
 *
 * A skip when the check was needed ships an unchecked confinement change, so
 * every doubt must read as required.
 */
vi.setConfig({ testTimeout: PROCESS_TEST_TIMEOUT_MS });

const ZERO_SHA = "0".repeat(40);

let root;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "orbit-processor-scope-"));
  git("init", "--quiet", "--initial-branch=dev");
  mkdirSync(join(root, "scripts/ci"), { recursive: true });
  cpSync(new URL("./detect-processor-scope.sh", import.meta.url).pathname, join(root, "scripts/ci/detect-processor-scope.sh"));
  commit("base", { "README.md": "base\n" });
});

function run(command, args, env = {}) {
  const result = spawnSync(command, args, {
    ...processGuard(),
    cwd: root,
    encoding: "utf8",
    env: {
      PATH: process.env.PATH,
      HOME: root,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
      GIT_AUTHOR_NAME: "Test",
      GIT_AUTHOR_EMAIL: "test@example.invalid",
      GIT_COMMITTER_NAME: "Test",
      GIT_COMMITTER_EMAIL: "test@example.invalid",
      ...env,
    },
  });
  failOnProcessDeadline(result, { label: `${command} ${args[0]}` });
  if (result.status !== 0 && command === "git") {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  }
  return result;
}

const git = (...args) => run("git", args).stdout.trim();

function write(path, content) {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content);
}

/* Commits the given files and returns the new commit's SHA. */
function commit(message, files) {
  for (const [path, content] of Object.entries(files)) write(path, content);
  git("add", "--all");
  git("commit", "--quiet", "-m", message);
  return git("rev-parse", "HEAD");
}

/* What the acceptance job's `bash scripts/ci/detect-processor-scope.sh` prints. */
function scope(env = {}) {
  const result = run("bash", [join(root, "scripts/ci/detect-processor-scope.sh")], env);
  expect(result.status, result.stderr).toBe(0);
  const line = result.stdout.trim().split("\n").filter((l) => l.startsWith("required=")).at(-1);
  return line?.slice("required=".length);
}

// A path from each group the gate covers, so one entry dropped from the list
// is caught here rather than in review.
const COVERED = [
  ["config/tika-config.json", '{"weakened":true}\n'],
  ["docker-compose.yml", "services: {}\n"],
  ["src/server/documents/extract.ts", "export const x = 1;\n"],
  ["src/server/item-document-inspection.ts", "export const y = 1;\n"],
  ["scripts/test-tika-processor.mjs", "// changed\n"],
  ["scripts/ci/verify-tika-processor.sh", "# changed\n"],
  // The script has to keep working after the change, so it only gains a comment.
  ["scripts/ci/detect-processor-scope.sh", `${readFileSync(new URL("./detect-processor-scope.sh", import.meta.url), "utf8")}\n# changed\n`],
  [".gitlab-ci.yml", "# changed\n"],
];

describe("detect-processor-scope.sh on a merge request pipeline", () => {
  it.each(COVERED)("requires the check when an early commit touches %s and the last one is unrelated", (path, content) => {
    const base = git("rev-parse", "HEAD");
    commit("weaken the processor", { [path]: content });
    commit("tidy the docs", { "docs/notes.md": "unrelated\n" });
    expect(scope({ CI_MERGE_REQUEST_DIFF_BASE_SHA: base })).toBe("true");
  });

  it("requires the check when a middle commit of three touches the processor", () => {
    const base = git("rev-parse", "HEAD");
    commit("first, unrelated", { "docs/one.md": "1\n" });
    commit("weaken the processor", { "config/tika-config.json": '{"weakened":true}\n' });
    commit("last, unrelated", { "docs/two.md": "2\n" });
    expect(scope({ CI_MERGE_REQUEST_DIFF_BASE_SHA: base })).toBe("true");
  });

  it("requires the check when only the last commit touches the processor", () => {
    const base = git("rev-parse", "HEAD");
    commit("first, unrelated", { "docs/one.md": "1\n" });
    commit("weaken the processor", { "docker-compose.yml": "services: {}\n" });
    expect(scope({ CI_MERGE_REQUEST_DIFF_BASE_SHA: base })).toBe("true");
  });

  it("skips the check when no commit in the range touches anything it covers", () => {
    const base = git("rev-parse", "HEAD");
    commit("docs", { "docs/one.md": "1\n" });
    commit("more docs", { "docs/two.md": "2\n" });
    commit("a web change", { "web/src/app.ts": "export {};\n" });
    expect(scope({ CI_MERGE_REQUEST_DIFF_BASE_SHA: base })).toBe("false");
  });

  it("does not count a processor change that is already in the base", () => {
    commit("weaken the processor on dev", { "config/tika-config.json": '{"weakened":true}\n' });
    const base = git("rev-parse", "HEAD");
    commit("docs", { "docs/one.md": "1\n" });
    commit("more docs", { "docs/two.md": "2\n" });
    expect(scope({ CI_MERGE_REQUEST_DIFF_BASE_SHA: base })).toBe("false");
  });

  it("requires the check when the base cannot be found, never skips", () => {
    commit("docs", { "docs/one.md": "1\n" });
    commit("more docs", { "docs/two.md": "2\n" });
    expect(scope({ CI_MERGE_REQUEST_DIFF_BASE_SHA: "1".repeat(40) })).toBe("true");
  });

  it("prints the same line to $GITHUB_OUTPUT as it prints", () => {
    const base = git("rev-parse", "HEAD");
    commit("weaken the processor", { "config/tika-config.json": '{"weakened":true}\n' });
    commit("tidy the docs", { "docs/notes.md": "unrelated\n" });
    const output = join(root, "step-outputs");
    expect(scope({ CI_MERGE_REQUEST_DIFF_BASE_SHA: base, GITHUB_OUTPUT: output })).toBe("true");
    expect(readFileSync(output, "utf8")).toBe("required=true\n");
  });
});

describe("detect-processor-scope.sh on a push to dev", () => {
  // No merge request variables: the pushed commit is compared with its parent.
  const push = (env = {}) => scope({ CI_COMMIT_BRANCH: "dev", CI_PIPELINE_SOURCE: "push", ...env });

  it("requires the check when the pushed commit touches the processor", () => {
    commit("docs", { "docs/one.md": "1\n" });
    commit("weaken the processor", { "config/tika-config.json": '{"weakened":true}\n' });
    expect(push()).toBe("true");
  });

  it("skips the check when the pushed commit touches nothing it covers", () => {
    commit("weaken the processor", { "config/tika-config.json": '{"weakened":true}\n' });
    commit("docs", { "docs/one.md": "1\n" });
    expect(push()).toBe("false");
  });

  it("requires the check for a merge commit that brings the processor change in", () => {
    git("checkout", "--quiet", "-b", "feature");
    commit("weaken the processor", { "config/tika-config.json": '{"weakened":true}\n' });
    commit("tidy the docs", { "docs/notes.md": "unrelated\n" });
    git("checkout", "--quiet", "dev");
    commit("dev moves on", { "docs/dev.md": "dev\n" });
    git("merge", "--quiet", "--no-ff", "-m", "merge feature", "feature");
    expect(push({ CI_COMMIT_BEFORE_SHA: git("rev-parse", "HEAD^1") })).toBe("true");
  });

  it("requires the check when there is no parent to compare with", () => {
    expect(push({ CI_COMMIT_BEFORE_SHA: ZERO_SHA })).toBe("true");
  });
});
