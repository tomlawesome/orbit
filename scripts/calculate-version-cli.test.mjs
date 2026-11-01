import { spawnSync } from "node:child_process";
import { copyFileSync, cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

const scriptSource = join(dirname(fileURLToPath(import.meta.url)), "calculate-version.mjs");
const gitEnv = {
  ...process.env,
  // Only the system config is emptied (it holds git-lfs filters, no gates). The
  // global config is left alone so the host's commit gates run on the fixture's
  // commit instead of being sidestepped (#1526, the #1523 pattern).
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@example.invalid",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@example.invalid",
};

const roots = [];

function git(root, ...args) {
  const result = spawnSync("git", ["-c", "commit.gpgsign=false", "-c", "tag.gpgsign=false", ...args], {
    cwd: root,
    env: gitEnv,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  }
}

// The script reads its files from disk and only the tags from git, so the one
// commit is empty (Minimal Fixture) and the host's commit gates run on it as
// they do everywhere else: no empty global config, no --no-verify (#1526, the
// #1523 pattern). The gates take about ten seconds a commit on a busy host, so
// it is made once and each fixture gets a copy of its .git.
let gatedGitTemplate;
beforeAll(() => {
  const repo = mkdtempSync(join(tmpdir(), "orbit-calc-version-head-"));
  gatedGitTemplate = join(repo, ".git");
  git(repo, "init", "--quiet");
  git(repo, "commit", "--quiet", "--allow-empty", "-m", "fixture");
}, 120_000);
afterAll(() => {
  if (gatedGitTemplate !== undefined) rmSync(dirname(gatedGitTemplate), { recursive: true, force: true });
});

// Builds a throwaway repository laid out like orbit: scripts/, package.json,
// retracted-tags.json, and (optionally) release-line.json, with the given tags.
function makeRepo({ tags, releaseLine, packageVersion = "0.2.0", retractedTags = [] }) {
  const root = mkdtempSync(join(tmpdir(), "orbit-calc-version-"));
  roots.push(root);
  mkdirSync(join(root, "scripts"));
  copyFileSync(scriptSource, join(root, "scripts", "calculate-version.mjs"));
  writeFileSync(
    join(root, "package.json"),
    `${JSON.stringify({ name: "fixture", version: packageVersion, type: "module" })}\n`,
  );
  writeFileSync(
    join(root, "scripts", "retracted-tags.json"),
    `${JSON.stringify({ tags: retractedTags, reason: "fixture" })}\n`,
  );
  if (releaseLine !== undefined) {
    writeFileSync(join(root, "scripts", "release-line.json"), releaseLine);
  }
  cpSync(gatedGitTemplate, join(root, ".git"), { recursive: true });
  for (const tag of tags) {
    git(root, "tag", tag);
  }
  return root;
}

function runCli(root, channel = "preview") {
  return spawnSync(process.execPath, ["scripts/calculate-version.mjs", "--channel", channel], {
    cwd: root,
    env: gitEnv,
    encoding: "utf8",
  });
}

const line = (value) => `${JSON.stringify({ line: value, reason: "fixture" })}\n`;

afterEach(() => {
  while (roots.length > 0) {
    rmSync(roots.pop(), { recursive: true, force: true });
  }
});

describe("calculate-version CLI", () => {
  it("prints the next patch for a preview train on the declared line", () => {
    const root = makeRepo({ tags: ["v0.3.0"], releaseLine: line("v0.3") });
    const result = runCli(root);

    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("v0.3.1\n");
  });

  it("prints vX.Y.0 when the declared line is above the highest tag", () => {
    const root = makeRepo({ tags: ["v0.3.5"], releaseLine: line("v0.4") });
    const result = runCli(root);

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("v0.4.0\n");
  });

  it("ignores a higher declared line for a hotfix train", () => {
    const root = makeRepo({ tags: ["v0.3.5"], releaseLine: line("v0.4") });
    const result = runCli(root, "hotfix");

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("v0.3.6\n");
  });

  it("skips retracted tags read from retracted-tags.json", () => {
    const root = makeRepo({
      tags: ["v0.3.0", "v1.2.0"],
      retractedTags: ["v1.2.0"],
      releaseLine: line("v0.3"),
    });
    const result = runCli(root);

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("v0.3.1\n");
  });

  it("bootstraps from package.json when there are no stable tags", () => {
    const root = makeRepo({ tags: [], packageVersion: "0.2.0", releaseLine: line("v0.2") });
    const result = runCli(root);

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("v0.2.1\n");
  });

  it("fails with a message and no version when release-line.json is missing", () => {
    const root = makeRepo({ tags: ["v0.3.0"] });
    const result = runCli(root);

    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toMatch(/release-line/u);
  });

  it("fails when release-line.json has no line", () => {
    const root = makeRepo({
      tags: ["v0.3.0"],
      releaseLine: `${JSON.stringify({ reason: "no line here" })}\n`,
    });
    const result = runCli(root);

    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).not.toBe("");
  });

  it.each([
    ["no leading v", "0.3"],
    ["a third part", "v0.3.1"],
    ["a leading zero", "v0.03"],
    ["a major only", "v0"],
    ["an empty string", ""],
    ["a number", 0.3],
  ])("fails when the line has %s", (_label, value) => {
    const root = makeRepo({ tags: ["v0.3.0"], releaseLine: line(value) });
    const result = runCli(root);

    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).not.toBe("");
  });
});

// v0.3.2 audit D-F8. Fails on current code: runCli reads release-line.json for
// every channel, so a hotfix branch cut from a tag older than the file dies
// with "must exist" instead of printing a version.
describe("calculate-version CLI without release-line.json (D-F8)", () => {
  it("prints a hotfix version when release-line.json does not exist", () => {
    const root = makeRepo({ tags: ["v0.3.5"] });
    const result = runCli(root, "hotfix");

    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("v0.3.6\n");
  });

  it("still fails a preview train when release-line.json does not exist", () => {
    const root = makeRepo({ tags: ["v0.3.5"] });
    const result = runCli(root, "preview");

    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toMatch(/release-line/u);
  });
});
