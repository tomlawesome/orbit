import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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
 * request pipeline (the merge base with the target branch), and on a push to
 * dev CI_COMMIT_BEFORE_SHA, the tip before the push, so every commit the push
 * brought is compared (#1607), not the last one alone.
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
  // No merge request variables: the whole push is compared, from the tip
  // before it (CI_COMMIT_BEFORE_SHA) to HEAD. A before-tip that is missing,
  // empty, all zeros (a new branch) or not in the checkout cannot be compared,
  // so the check is required, never skipped.
  const push = (before, env = {}) =>
    scope({ CI_COMMIT_BRANCH: "dev", CI_PIPELINE_SOURCE: "push", ...(before === undefined ? {} : { CI_COMMIT_BEFORE_SHA: before }), ...env });

  /* A push of two commits: the processor is weakened in the first, the last is unrelated. */
  function weakenedEarlyPush() {
    const before = git("rev-parse", "HEAD");
    commit("weaken the processor", { "config/tika-config.json": '{"weakened":true}\n' });
    commit("tidy the docs", { "docs/notes.md": "unrelated\n" });
    return before;
  }

  it("requires the check when the pushed commit touches the processor", () => {
    commit("docs", { "docs/one.md": "1\n" });
    const before = git("rev-parse", "HEAD");
    commit("weaken the processor", { "config/tika-config.json": '{"weakened":true}\n' });
    expect(push(before)).toBe("true");
  });

  it("skips the check when the pushed commit touches nothing it covers", () => {
    commit("weaken the processor", { "config/tika-config.json": '{"weakened":true}\n' });
    const before = git("rev-parse", "HEAD");
    commit("docs", { "docs/one.md": "1\n" });
    expect(push(before)).toBe("false");
  });

  it.each(COVERED)("requires the check when an early commit of a multi-commit push touches %s", (path, content) => {
    const before = git("rev-parse", "HEAD");
    commit("weaken the processor", { [path]: content });
    commit("tidy the docs", { "docs/notes.md": "unrelated\n" });
    commit("more docs", { "docs/more.md": "unrelated\n" });
    expect(push(before)).toBe("true");
  });

  it("skips the check when no commit of a multi-commit push touches anything it covers", () => {
    commit("weaken the processor on dev", { "config/tika-config.json": '{"weakened":true}\n' });
    const before = git("rev-parse", "HEAD");
    commit("docs", { "docs/one.md": "1\n" });
    commit("more docs", { "docs/two.md": "2\n" });
    commit("a web change", { "web/src/app.ts": "export {};\n" });
    expect(push(before)).toBe("false");
  });

  it("requires the check for a merge commit that brings the processor change in", () => {
    git("checkout", "--quiet", "-b", "feature");
    commit("weaken the processor", { "config/tika-config.json": '{"weakened":true}\n' });
    commit("tidy the docs", { "docs/notes.md": "unrelated\n" });
    git("checkout", "--quiet", "dev");
    commit("dev moves on", { "docs/dev.md": "dev\n" });
    git("merge", "--quiet", "--no-ff", "-m", "merge feature", "feature");
    expect(push(git("rev-parse", "HEAD^1"))).toBe("true");
  });

  it("requires the check when the before-tip is all zeros, even if the last commit is unrelated", () => {
    weakenedEarlyPush();
    expect(push(ZERO_SHA)).toBe("true");
  });

  it("requires the check when there is no parent to compare with", () => {
    expect(push(ZERO_SHA)).toBe("true");
  });

  it("requires the check when the before-tip is not a commit this checkout has", () => {
    weakenedEarlyPush();
    expect(push("1".repeat(40))).toBe("true");
  });

  it("requires the check when CI_COMMIT_BEFORE_SHA is unset", () => {
    weakenedEarlyPush();
    expect(push(undefined)).toBe("true");
  });

  it("requires the check when CI_COMMIT_BEFORE_SHA is empty", () => {
    weakenedEarlyPush();
    expect(push("")).toBe("true");
  });
});

/*
 * The stanza the `acceptance` job runs just before detect-processor-scope.sh
 * (commits 20e259c3 and 9caae1cd, #1607): the job takes the project's default
 * clone depth, which can stop short of the merge base or the pre-push tip, so
 * it fetches that one commit. The script alone is tested above against a full
 * history; this covers the job's own wiring, which nothing else did. It is read
 * out of .gitlab-ci.yml (no YAML library in the repository) and run for real in
 * bash against a `git` that records its arguments.
 */
describe("the acceptance job's fetch of the comparison base", () => {
  const ci = readFileSync(new URL("../../.gitlab-ci.yml", import.meta.url), "utf8").split("\n");
  const jobStart = ci.findIndex((line) => line === "acceptance:");
  const jobEnd = ci.findIndex((line, i) => i > jobStart && /^[A-Za-z_.]/.test(line));
  const job = ci.slice(jobStart, jobEnd === -1 ? undefined : jobEnd).filter((line) => !/^\s*#/.test(line));

  // The script item (`    - |` block) holding the `git fetch`, de-indented, as GitLab hands it to the shell.
  const stanza = () => {
    const at = job.findIndex((line) => line.includes("git fetch"));
    expect(at, "the acceptance job has a git fetch").toBeGreaterThan(0);
    let from = at;
    while (from > 0 && !/^ {4}- /.test(job[from])) from -= 1;
    let to = at;
    while (to + 1 < job.length && !/^ {4}- /.test(job[to + 1]) && !/^ {0,3}\S/.test(job[to + 1])) to += 1;
    return job
      .slice(from + 1, to + 1)
      .map((line) => line.replace(/^ {6}/, ""))
      .join("\n");
  };

  // Runs the stanza with a `git` that logs its arguments one call a line and exits `gitExit`.
  function runStanza(env, gitExit = 0) {
    const bin = mkdtempSync(join(tmpdir(), "orbit-scope-git-"));
    const log = join(bin, "calls.log");
    writeFileSync(join(bin, "git"), `#!/bin/bash\nprintf '%s\\n' "$*" >> "${log}"\nexit ${gitExit}\n`);
    chmodSync(join(bin, "git"), 0o755);
    const result = run("bash", ["-c", stanza()], { PATH: `${bin}:${process.env.PATH}`, ...env });
    let calls = [];
    try {
      calls = readFileSync(log, "utf8").split("\n").filter(Boolean);
    } catch {
      // git was never called
    }
    return { result, calls };
  }

  const BASE = "a".repeat(40);
  const BEFORE = "b".repeat(40);

  it("exists in the acceptance job, before detect-processor-scope.sh", () => {
    const text = job.join("\n");
    expect(text).toContain("git fetch");
    expect(text.indexOf("git fetch")).toBeLessThan(text.indexOf("scripts/ci/detect-processor-scope.sh"));
  });

  it("on a merge request fetches CI_MERGE_REQUEST_DIFF_BASE_SHA, one commit deep, from origin", () => {
    const { result, calls } = runStanza({ CI_MERGE_REQUEST_DIFF_BASE_SHA: BASE });
    expect(result.status, result.stderr).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatch(new RegExp(`^fetch .*--depth=1 origin ${BASE}$`));
  });

  it("on a push fetches CI_COMMIT_BEFORE_SHA, one commit deep, from origin", () => {
    const { result, calls } = runStanza({ CI_COMMIT_BEFORE_SHA: BEFORE });
    expect(result.status, result.stderr).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatch(new RegExp(`^fetch .*--depth=1 origin ${BEFORE}$`));
  });

  it("on a merge request, the merge-request base wins over a before-SHA", () => {
    const { calls } = runStanza({ CI_MERGE_REQUEST_DIFF_BASE_SHA: BASE, CI_COMMIT_BEFORE_SHA: BEFORE });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain(BASE);
  });

  it.each([
    ["no SHA at all", {}],
    ["an empty before-SHA", { CI_COMMIT_BEFORE_SHA: "" }],
    ["an empty merge-request base and an empty before-SHA", { CI_MERGE_REQUEST_DIFF_BASE_SHA: "", CI_COMMIT_BEFORE_SHA: "" }],
    ["an all-zero before-SHA (a new branch)", { CI_COMMIT_BEFORE_SHA: ZERO_SHA }],
    ["a short all-zero before-SHA", { CI_COMMIT_BEFORE_SHA: "00000000" }],
  ])("skips the fetch for %s", (_what, env) => {
    const { result, calls } = runStanza(env);
    expect(result.status, result.stderr).toBe(0);
    expect(calls).toEqual([]);
  });

  it.each([
    ["merge request", { CI_MERGE_REQUEST_DIFF_BASE_SHA: BASE }],
    ["push", { CI_COMMIT_BEFORE_SHA: BEFORE }],
  ])("a failed fetch on a %s is not swallowed: the stanza fails, or says so, and no `|| true` hides it", (_what, env) => {
    const { result } = runStanza(env, 1);
    // The ruled design is to say so and let detect-processor-scope.sh answer "required", never to go quiet.
    expect(result.status !== 0 || /not fetched/i.test(`${result.stdout}${result.stderr}`)).toBe(true);
    for (const line of stanza().split("\n").filter((l) => l.includes("git fetch"))) {
      expect(line).not.toMatch(/\|\|\s*(true|:)(\s|$)/);
    }
  });
});
