/**
 * scripts/ci/checkout-launcher-source.sh: clones the launcher source for
 * launcher_install_compat's live tests and refuses unless launcher/pin.json's
 * tag resolves to its pinned commit.
 *
 * Exercised against a local fixture git repository standing in for the
 * GitHub mirror, never the network, the same shape build-launcher.test.mjs
 * uses.
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

import { describe, expect, it, vi } from "vitest";

import { PROCESS_TEST_TIMEOUT_MS, failOnProcessDeadline, processGuard } from "../process-budget.mjs";

vi.setConfig({ testTimeout: PROCESS_TEST_TIMEOUT_MS });

const script = new URL("./checkout-launcher-source.sh", import.meta.url).pathname;

function runGit(cwd, args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} in ${cwd} failed: ${result.stderr}`);
  }
  return result.stdout;
}

/** A one-commit repository tagged v0.1.0 (lightweight, like the real pin). */
function deployLauncherRemote() {
  const dir = mkdtempSync(join(tmpdir(), "orbit-launcher-fixture-"));
  runGit(dir, ["init", "--quiet", "--initial-branch=dev"]);
  runGit(dir, ["config", "user.email", "test@example.invalid"]);
  runGit(dir, ["config", "user.name", "Test"]);
  writeFileSync(join(dir, "go.mod"), "module example.invalid/orbit-launcher-fixture\n\ngo 1.27.1\n");
  runGit(dir, ["add", "-A"]);
  runGit(dir, ["commit", "--quiet", "-m", "v0.1.0"]);
  runGit(dir, ["tag", "v0.1.0"]);
  const commit = runGit(dir, ["rev-parse", "HEAD"]).trim();
  return { dir, commit };
}

function writePinFile({ tag = "v0.1.0", commit }) {
  const path = join(mkdtempSync(join(tmpdir(), "launcher-pin-")), "pin.json");
  writeFileSync(path, JSON.stringify({ tag, commit }));
  return path;
}

function runCheckout({ dest, pinFile, remote }) {
  return failOnProcessDeadline(
    spawnSync("bash", [script, dest], {
      encoding: "utf8",
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME ?? tmpdir(),
        ORBIT_LAUNCHER_REMOTE: remote,
        ORBIT_LAUNCHER_PIN_FILE: pinFile,
      },
      ...processGuard(),
    }),
    { label: "checkout-launcher-source" },
  );
}

function freshDest() {
  return join(mkdtempSync(join(tmpdir(), "checkout-launcher-out-")), ".orbit-launcher-src");
}

describe("checkout-launcher-source.sh", () => {
  it("checks out the tag when it resolves to the pinned commit", () => {
    const { dir: remote, commit } = deployLauncherRemote();
    const dest = freshDest();

    const result = runCheckout({ dest, pinFile: writePinFile({ commit }), remote });

    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`v0.1.0 at pinned commit ${commit}`);
    expect(runGit(dest, ["rev-parse", "HEAD"]).trim()).toBe(commit);
  });

  it("refuses a tag moved to a different commit, naming both", () => {
    const { dir: remote, commit: pinned } = deployLauncherRemote();
    writeFileSync(join(remote, "moved.txt"), "moved\n");
    runGit(remote, ["add", "-A"]);
    runGit(remote, ["commit", "--quiet", "-m", "moved"]);
    runGit(remote, ["tag", "-f", "v0.1.0"]);
    const moved = runGit(remote, ["rev-parse", "HEAD"]).trim();

    const result = runCheckout({ dest: freshDest(), pinFile: writePinFile({ commit: pinned }), remote });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("refusing to test an unpinned source");
    expect(result.stderr).toContain(`resolves to ${moved}`);
    expect(result.stderr).toContain(`pinned commit ${pinned}`);
  });

  it("refuses a tag the remote does not have", () => {
    const { dir: remote, commit } = deployLauncherRemote();

    const result = runCheckout({
      dest: freshDest(),
      pinFile: writePinFile({ tag: "v9.9.9", commit }),
      remote,
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("has no tag v9.9.9");
  });
});
