// scripts/install.sh, the rollback's restore of an original (#1901 ruling 4, O-R1):
// O-R4 stages the copy beside the path and switches it in. When the staging copy
// fails and the path is still there, the rollback falls back to a rename-aside:
// the path is moved to "<staged>.aside", the original is copied into place and
// checked with `diff -r`, then the aside is removed; if that copy also fails the
// aside is moved back and the path is reported by rollback_restore_failed. The
// aside name is in snapshot_fresh_target's known list. Fixtures: install-test-support.mjs.

import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { PROCESS_TEST_TIMEOUT_MS } from "./process-budget.mjs";
import {
  fakeDockerScript,
  fakeCurlScript,
  fakeCosignScript,
  targetEntries,
  runInstall,
  terminalFailure,
  recoveryFixture,
  committedCanned,
  onlyStamp,
  originalsIn,
  ownTree,
  treeSnapshot,
} from "./install-test-support.mjs";

vi.setConfig({ testTimeout: PROCESS_TEST_TIMEOUT_MS });

/** A bin directory ahead of the fake one: the same fakes, plus `tools` (name to shell body) that shadow real commands. */
function toolsPath(tools) {
  const dir = mkdtempSync(join(tmpdir(), "orbit-install-shadow-"));
  for (const [name, source] of [
    ["docker", fakeDockerScript],
    ["curl", fakeCurlScript],
    ["cosign", fakeCosignScript],
  ]) {
    writeFileSync(join(dir, name), source);
    chmodSync(join(dir, name), 0o755);
  }
  for (const [name, body] of Object.entries(tools)) {
    writeFileSync(join(dir, name), `#!/bin/sh\n${body}\n`);
    chmodSync(join(dir, name), 0o755);
  }
  return `${dir}:${process.env.PATH}`;
}

// The staging copy is the `cp -a` whose destination is the ".<name>.orbit-restore.<pid>" path beside the entry.
const failStagingCopy = 'for last; do :; done\ncase "$last" in *.orbit-restore.*) exit 1;; esac\nexec /bin/cp "$@"';
// Every copy out of originals/ fails: the staging copy and the fallback's copy into place.
// It logs each destination to $CP_LOG first, so a test can see that a copy straight into place was tried.
const failAnyRestoreCopy = 'for a; do source=$last; last=$a; done\necho "$last" >>"$CP_LOG"\ncase "$source" in */originals/*) exit 1;; esac\nexec /bin/cp "$@"';

const engineMade = ".orbit-secrets/engine-made";
const engineMadeContent = "written by the engine, not an original\n";

/** A failed install after the engine committed, with a file the engine added inside .orbit-secrets. */
function failedInstall(tools, extraEnvironment = {}) {
  const { targetDir, environment, before } = recoveryFixture();
  const canned = committedCanned();
  const leaves = { ...JSON.parse(canned.FAKE_ENGINE_LEAVES), [engineMade]: engineMadeContent };
  const result = runInstall(targetDir, {
    ...environment,
    ...canned,
    FAKE_ENGINE_LEAVES: JSON.stringify(leaves),
    FAKE_COMPOSE_UP_FAIL: "1",
    ...extraEnvironment,
    ...(tools ? { PATH: toolsPath(tools) } : {}),
  });
  return { targetDir, before, result };
}

const leftovers = (targetDir) => targetEntries(targetDir).filter((name) => /orbit-restore|\.aside$/u.test(name));

describe("install.sh: the rollback restore falls back to a rename-aside when the staging copy fails (#1901 O-R1)", () => {
  it("the staging copy fails: the original is copied into place over the moved-aside entry, and no aside is left", () => {
    const { targetDir, before, result } = failedInstall({ cp: failStagingCopy });
    expect(result.status).toBe(1);
    expect(terminalFailure(result.stdout)).toMatch(/ action=retry /u);
    expect(result.stderr).not.toContain("Could not put back");
    expect(originalsIn(ownTree(targetDir))).toEqual(originalsIn(before));
    expect(existsSync(join(targetDir, engineMade))).toBe(false);
    expect(leftovers(targetDir)).toEqual([]);
  });

  it("the second copy fails too: the aside is moved back, the engine's entry is intact, rollback_restore_failed names the path and keeps the copy", () => {
    const cpLog = join(mkdtempSync(join(tmpdir(), "orbit-install-cplog-")), "cp.log");
    const { targetDir, result } = failedInstall({ cp: failAnyRestoreCopy }, { CP_LOG: cpLog });
    // The fallback ran: after the staging copy failed, a copy straight into the path was tried.
    expect(readFileSync(cpLog, "utf8").split("\n")).toContain(join(targetDir, ".orbit-secrets"));
    expect(result.status).toBe(1);
    expect(terminalFailure(result.stdout)).toMatch(/ action=abort /u);
    expect(result.stderr).toContain("Could not put back");
    expect(result.stderr).toContain(join(targetDir, ".orbit-secrets"));
    expect(result.stderr).toContain("originals");
    // The aside went back to the path: what was there is still there, whole.
    expect(readFileSync(join(targetDir, engineMade), "utf8")).toBe(engineMadeContent);
    expect(leftovers(targetDir)).toEqual([]);
    // The copy of the original is kept.
    const stamp = onlyStamp(targetDir);
    expect(readFileSync(join(stamp, "originals", ".orbit-secrets", "oidc-client-secret"), "utf8")).toBe("preprovisioned-oidc-secret");
  });

  it("the ordinary path is unchanged: no shim, the folder is put back and nothing is left beside it", () => {
    const { targetDir, before, result } = failedInstall();
    expect(result.status).toBe(1);
    expect(terminalFailure(result.stdout)).toMatch(/ action=retry /u);
    expect(result.stderr).not.toContain("Could not put back");
    expect(originalsIn(ownTree(targetDir))).toEqual(originalsIn(before));
    expect(existsSync(join(targetDir, engineMade))).toBe(false);
    expect(leftovers(targetDir)).toEqual([]);
  });
});

describe("install.sh: snapshot_fresh_target knows the rollback's aside name (#1901 O-R1)", () => {
  it.each([
    [".env-orbit", "..env-orbit.orbit-restore.4242.aside"],
    [".orbit-secrets", "..orbit-secrets.orbit-restore.4242.aside"],
  ])("a folder holding only its originals and a leftover %s aside is still a fresh folder: it gets a start record", (_name, aside) => {
    const { targetDir, environment } = recoveryFixture();
    writeFileSync(join(targetDir, aside), "left by an interrupted restore\n");
    const result = runInstall(targetDir, { ...environment, ...committedCanned(), FAKE_COMPOSE_UP_FAIL: "1" });
    expect(result.status).toBe(1);
    const stamp = onlyStamp(targetDir);
    expect(existsSync(join(stamp, "originals", ".env-orbit"))).toBe(true);
    expect(treeSnapshot(join(stamp, "originals"))).toHaveProperty([".orbit-secrets/oidc-client-secret"]);
  });
});
