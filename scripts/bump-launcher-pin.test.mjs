/**
 * scripts/bump-launcher-pin.sh (ADR-0031 #2): resolves a launcher tag to its
 * commit and writes launcher/pin.json. Exercised against a local git
 * repository standing in for the GitHub mirror, never the network -- the
 * same "no real remote" approach scripts/ci/repin-base-image.test.mjs takes
 * for its own push half.
 *
 * Uses node:test, not vitest globals, like the other script-driving suites
 * (scripts/compose-project-name-resolution.test.mjs, #921).
 * Run standalone: `node --test scripts/bump-launcher-pin.test.mjs`.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";

import { failOnProcessDeadline, processGuard } from "./process-budget.mjs";

const scriptSource = readFileSync(join(import.meta.dirname, "bump-launcher-pin.sh"), "utf8");

const scratchDirs = [];

afterEach(() => {
  while (scratchDirs.length > 0) {
    rmSync(scratchDirs.pop(), { recursive: true, force: true });
  }
});

function scratchDir(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  scratchDirs.push(dir);
  return dir;
}

function runGit(cwd, args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} in ${cwd} failed: ${result.stderr}`);
  }
  return result.stdout;
}

/**
 * A source git repository standing in for the launcher's GitHub mirror:
 * one commit tagged lightweight, a second commit tagged annotated, so the
 * two resolution paths in the script (peeled ^{} ref vs. the bare tag ref)
 * both have something real to resolve against.
 */
function deployLauncherRemote() {
  const dir = scratchDir("orbit-launcher-remote-");
  runGit(dir, ["init", "--quiet", "--initial-branch=dev"]);
  runGit(dir, ["config", "user.email", "test@example.invalid"]);
  runGit(dir, ["config", "user.name", "Test"]);

  writeFileSync(join(dir, "go.mod"), "module github.com/tomlawesome/orbit-launcher\n\ngo 1.27.1\n");
  runGit(dir, ["add", "-A"]);
  runGit(dir, ["commit", "--quiet", "-m", "v0.1.0"]);
  runGit(dir, ["tag", "v0.1.0"]); // lightweight: refs/tags/v0.1.0 IS the commit.
  const lightweightCommit = runGit(dir, ["rev-parse", "HEAD"]).trim();

  writeFileSync(join(dir, "go.mod"), "module github.com/tomlawesome/orbit-launcher\n\ngo 1.27.2\n");
  runGit(dir, ["add", "-A"]);
  runGit(dir, ["commit", "--quiet", "-m", "v0.2.0"]);
  runGit(dir, ["tag", "-a", "v0.2.0", "-m", "annotated"]); // refs/tags/v0.2.0^{} peels to the commit.
  const annotatedCommit = runGit(dir, ["rev-parse", "HEAD"]).trim();

  return { dir, lightweightCommit, annotatedCommit };
}

/**
 * A scratch repository laid out the way the script's own repo-root
 * resolution needs: it computes `repo_root` from its own `BASH_SOURCE`, one
 * directory up, so the script must live at `<repo>/scripts/bump-launcher-pin.sh`
 * for `launcher/pin.json` to land inside the scratch repo instead of this
 * checkout.
 */
function deployConsumerRepo() {
  const dir = scratchDir("orbit-consumer-repo-");
  mkdirSync(join(dir, "scripts"), { recursive: true });
  writeFileSync(join(dir, "scripts", "bump-launcher-pin.sh"), scriptSource);
  return dir;
}

function runBump(consumerDir, { tag, remote } = {}) {
  const env = {
    PATH: process.env.PATH,
    HOME: process.env.HOME ?? tmpdir(),
    ORBIT_LAUNCHER_REMOTE: remote,
  };
  return failOnProcessDeadline(
    spawnSync(
      "bash",
      [join(consumerDir, "scripts", "bump-launcher-pin.sh"), ...(tag !== undefined ? [tag] : [])],
      { cwd: consumerDir, encoding: "utf8", env, ...processGuard() },
    ),
    { label: "bump-launcher-pin.sh" },
  );
}

describe("bump-launcher-pin.sh", () => {
  it("resolves a lightweight tag to its own commit and writes launcher/pin.json", () => {
    const { dir: remote, lightweightCommit } = deployLauncherRemote();
    const consumerDir = deployConsumerRepo();

    const result = runBump(consumerDir, { tag: "v0.1.0", remote });

    assert.equal(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    assert.match(result.stdout, new RegExp(`v0\\.1\\.0 \\(${lightweightCommit}\\)`, "u"));
    const pin = JSON.parse(readFileSync(join(consumerDir, "launcher", "pin.json"), "utf8"));
    assert.deepEqual(pin, { tag: "v0.1.0", commit: lightweightCommit });
  });

  it("resolves an annotated tag to the commit it peels to, not the tag object", () => {
    const { dir: remote, annotatedCommit } = deployLauncherRemote();
    const consumerDir = deployConsumerRepo();

    const result = runBump(consumerDir, { tag: "v0.2.0", remote });

    assert.equal(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    const pin = JSON.parse(readFileSync(join(consumerDir, "launcher", "pin.json"), "utf8"));
    assert.deepEqual(pin, { tag: "v0.2.0", commit: annotatedCommit });
  });

  it("overwrites an existing pin.json", () => {
    const { dir: remote, lightweightCommit, annotatedCommit } = deployLauncherRemote();
    const consumerDir = deployConsumerRepo();
    mkdirSync(join(consumerDir, "launcher"), { recursive: true });
    writeFileSync(
      join(consumerDir, "launcher", "pin.json"),
      JSON.stringify({ tag: "v0.0.1", commit: "0".repeat(40) }),
    );

    const result = runBump(consumerDir, { tag: "v0.2.0", remote });

    assert.equal(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    const pin = JSON.parse(readFileSync(join(consumerDir, "launcher", "pin.json"), "utf8"));
    assert.deepEqual(pin, { tag: "v0.2.0", commit: annotatedCommit });
    assert.notEqual(pin.commit, lightweightCommit);
  });

  it("refuses a missing tag argument", () => {
    const consumerDir = deployConsumerRepo();
    const result = runBump(consumerDir, { remote: "unused" });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /a tag is required/u);
  });

  for (const bad of ["0.1.0", "latest", "v1", "V1.2.3", "v1.2.3-", "release-v1.2.3"]) {
    it(`refuses a tag not shaped like vX.Y.Z: ${bad}`, () => {
      const consumerDir = deployConsumerRepo();
      const result = runBump(consumerDir, { tag: bad, remote: "unused" });
      assert.equal(result.status, 1);
      assert.match(result.stderr, /not a plain vX\.Y\.Z tag/u);
    });
  }

  it("accepts a pre-release suffix", () => {
    const { dir: remote } = deployLauncherRemote();
    runGit(remote, ["tag", "v0.3.0-rc.1"]);
    const consumerDir = deployConsumerRepo();

    const result = runBump(consumerDir, { tag: "v0.3.0-rc.1", remote });

    assert.equal(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  });

  it("refuses a tag the remote does not have", () => {
    const { dir: remote } = deployLauncherRemote();
    const consumerDir = deployConsumerRepo();

    const result = runBump(consumerDir, { tag: "v9.9.9", remote });

    assert.equal(result.status, 1);
    assert.match(result.stderr, /has no tag v9\.9\.9/u);
    assert.equal(
      spawnSync("test", ["-f", join(consumerDir, "launcher", "pin.json")]).status,
      1,
      "pin.json must not be written when resolution fails",
    );
  });

  it("refuses an unreachable remote, naming it rather than writing a pin", () => {
    const consumerDir = deployConsumerRepo();

    const result = runBump(consumerDir, { tag: "v0.1.0", remote: join(consumerDir, "does-not-exist") });

    assert.equal(result.status, 1);
    assert.match(result.stderr, /could not read tags from/u);
  });
});
