// scripts/install.sh, the rollback's restore of an original (#1901 ruling 4, O-R1):
// O-R4 stages the copy beside the path and switches it in. When the staging copy
// fails and the path is still there, the rollback falls back to a rename-aside:
// the path is moved to "<staged>.aside", the original is copied into place and
// checked with `diff -r`, then the aside is removed; if that copy also fails the
// aside is moved back and the path is reported by rollback_restore_failed. The
// aside name is in snapshot_fresh_target's known list. Fixtures: install-test-support.mjs.

import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, writeFileSync } from "node:fs";
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
  filesNamed,
  backupsDir,
  privateStateFixture,
  r5DownFailedKnobs,
  r5DownCommand,
  recoveryCommands,
  runPasted,
  containersLeft,
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

// Branches of restore_original_aside beyond the plain fallback: the containers could not be stopped (the aside is
// <stamp>/engine/<name>), the aside that cannot be removed, and the aside that cannot be moved back.
const failAsideRemoval = 'for a; do case "$a" in *.aside) exit 1;; esac; done\nexec /bin/rm "$@"';
const moveBackShim = (pattern) => `for a; do case "$a" in -*) ;; *) first=$a; break;; esac; done\ncase "$first" in ${pattern}) exit 1;; esac\nexec /bin/mv "$@"`;
const failAsideMoveBackNormal = moveBackShim("*.aside");
const failAsideMoveBackEngine = moveBackShim("*/engine/*");

/** Guarantee 58: no "clear what is named above" line may follow a line naming orbit-install-backups. */
function expectNoClearAfterBackups(stderr) {
  const lines = stderr.split("\n");
  const named = lines.findIndex((line) => line.includes("orbit-install-backups"));
  const clear = lines.findIndex((line, index) => index > named && line.includes("Clear the entries this install could not remove, named above"));
  expect(named >= 0 && clear >= 0, `a "Clear the entries" line follows a line naming orbit-install-backups:\n${stderr}`).toBe(false);
}

describe("install.sh: restore_original_aside, the containers could not be stopped (#1901 O-R1)", () => {
  function downFailedInstall(tools, extraEnvironment = {}) {
    const fixture = privateStateFixture();
    const environment = {
      ...fixture.environment,
      ...r5DownFailedKnobs(),
      FAKE_COMPOSE_STRICT: "1",
      ...extraEnvironment,
      ...(tools ? { PATH: toolsPath(tools) } : {}),
    };
    return { ...fixture, result: runInstall(fixture.targetDir, environment) };
  }

  it("the fallback copy succeeds: the path is restored, the aside is the entry under <stamp>/engine, and the printed stop command still works", () => {
    const { targetDir, stateDir, before, result } = downFailedInstall({ cp: failStagingCopy });
    expect(result.status).toBe(1);
    expect(result.stderr).not.toContain("Could not put back");
    expect(ownTree(targetDir)).toEqual(before);
    const stamp = onlyStamp(targetDir);
    expect(existsSync(join(stamp, "originals"))).toBe(false);
    expect(readFileSync(join(stamp, "engine", ".env-orbit"), "utf8")).toContain("COMPOSE_PROJECT_NAME=");
    expect(existsSync(join(stamp, "engine", "docker-compose.yml"))).toBe(true);
    expect(leftovers(targetDir)).toEqual([]);
    const commands = recoveryCommands(result.stderr).map((entry) => entry.command);
    expect(commands).toHaveLength(1);
    expect(commands[0]).toMatch(r5DownCommand);
    const pasted = runPasted(commands[0], stateDir);
    expect(pasted.ran.status, pasted.ran.stderr).toBe(0);
    expect(pasted.loaded?.found).toBe(true);
    expect(containersLeft(stateDir)).toEqual([]);
  });

  it("engine/ variant: the copy fails and the aside under engine/ cannot be moved back: originals/ is kept, the path is named, and nothing tells the person to clear entries after a line naming the backups folder", () => {
    const { targetDir, result } = downFailedInstall({ cp: failAnyRestoreCopy, mv: failAsideMoveBackEngine }, { CP_LOG: join(mkdtempSync(join(tmpdir(), "orbit-cplog-")), "cp.log") });
    expect(result.status).toBe(1);
    expect(terminalFailure(result.stdout)).toMatch(/ action=abort /u);
    expect(result.stderr).toContain("Could not move");
    expect(result.stderr).toContain(join(targetDir, ".orbit-secrets"));
    const stamp = onlyStamp(targetDir);
    expect(readFileSync(join(stamp, "originals", ".orbit-secrets", "oidc-client-secret"), "utf8")).toBe("preprovisioned-oidc-secret");
    expectNoClearAfterBackups(result.stderr);
    // engine/ under the stamp is the installer's own: the person is never told to clear it.
    const lines = result.stderr.split("\n");
    const engineLine = lines.findIndex((line) => line.includes(`${stamp}/engine`));
    if (engineLine >= 0) expect(lines.slice(engineLine + 1).some((line) => line.includes("Clear the entries"))).toBe(false);
  });
});

describe("install.sh: restore_original_aside, the aside that cannot be removed or moved back (#1901 O-R1)", () => {
  it("the aside cannot be removed after a verified restore: the obstacle names the aside, the run aborts, and the original is still in originals/", () => {
    const { targetDir, before, result } = failedInstall({ cp: failStagingCopy, rm: failAsideRemoval });
    expect(result.status).toBe(1);
    expect(terminalFailure(result.stdout)).toMatch(/ action=abort /u);
    expect(result.stderr).toMatch(/Could not remove \S*\.orbit-restore\.\d+\.aside/u);
    // The original is back in place, and its copy is kept.
    expect(originalsIn(ownTree(targetDir))).toEqual(originalsIn(before));
    const stamp = onlyStamp(targetDir);
    expect(readFileSync(join(stamp, "originals", ".orbit-secrets", "oidc-client-secret"), "utf8")).toBe("preprovisioned-oidc-secret");
  });

  it("the copy fails and the aside cannot be moved back: originals/ is kept, the path is named, and nothing tells the person to clear entries after a line naming the backups folder", () => {
    const { targetDir, result } = failedInstall(
      { cp: failAnyRestoreCopy, mv: failAsideMoveBackNormal },
      { CP_LOG: join(mkdtempSync(join(tmpdir(), "orbit-cplog-")), "cp.log") },
    );
    expect(result.status).toBe(1);
    expect(terminalFailure(result.stdout)).toMatch(/ action=abort /u);
    expect(result.stderr).toMatch(/Could not move \S*\.orbit-restore\.\d+\.aside back/u);
    expect(result.stderr).toContain(join(targetDir, ".orbit-secrets"));
    const stamp = onlyStamp(targetDir);
    expect(readFileSync(join(stamp, "originals", ".orbit-secrets", "oidc-client-secret"), "utf8")).toBe("preprovisioned-oidc-secret");
    expectNoClearAfterBackups(result.stderr);
  });
});

describe("install.sh: snapshot_fresh_target knows the rollback's aside name (#1901 O-R1)", () => {
  // Guarantee 58: a leftover aside of either name does not stop a folder counting as fresh and is not copied into
  // originals/ (it is the installer's own); a verified restore then releases originals/, and the aside is moved
  // into moved/, never deleted.
  it.each([
    [".env-orbit", "..env-orbit.orbit-restore.4242.aside"],
    [".orbit-secrets", "..orbit-secrets.orbit-restore.4242.aside"],
  ])("a folder holding only its originals and a leftover %s aside is still a fresh folder: it gets a start record, the aside is not an original, and the folder ends restored", (_name, aside) => {
    const { targetDir, environment, before } = recoveryFixture();
    writeFileSync(join(targetDir, aside), "left by an interrupted restore\n");
    const result = runInstall(targetDir, { ...environment, ...committedCanned(), FAKE_COMPOSE_UP_FAIL: "1" });
    expect(result.status).toBe(1);
    // A start record was taken: the rollback ran (a non-fresh folder is an update and is never rolled back).
    expect(terminalFailure(result.stdout)).toMatch(/ action=retry /u);
    expect(result.stderr).toContain("rolled back");
    // Never copied into originals/; originals/ itself is released after the verified restore.
    expect(filesNamed(backupsDir(targetDir), [aside]).filter((path) => path.includes("/originals/"))).toEqual([]);
    expect(filesNamed(backupsDir(targetDir), ["originals"])).toEqual([]);
    // Not deleted: the rollback moved it into moved/.
    const kept = filesNamed(backupsDir(targetDir), [aside]);
    expect(kept).toHaveLength(1);
    expect(kept[0]).toContain("/moved/");
    expect(readFileSync(kept[0], "utf8")).toBe("left by an interrupted restore\n");
    expect(originalsIn(ownTree(targetDir))).toEqual(originalsIn(before));
  });
});

describe("install.sh: a lone rollback aside stops the run (#1943 O-S1)", () => {
  // Ruling note 68569: the aside may be ignored only when its original is in the folder. A lone aside (a restore
  // killed after the original was moved aside) stops the run before anything is written, naming the aside and every
  // orbit-install-backups/*/originals/<name> found, so "Nothing was changed" still holds.
  const aside = "..env-orbit.orbit-restore.4242.aside";
  const stamp = "20261101T120000Z";

  /** A pre-provisioned folder whose .env-orbit a killed restore left only as the aside and a backup's originals copy. */
  function killedRestoreFolder() {
    const fixture = recoveryFixture();
    const originals = join(fixture.targetDir, "orbit-install-backups", stamp, "originals");
    mkdirSync(originals, { recursive: true });
    writeFileSync(join(originals, ".env-orbit"), readFileSync(join(fixture.targetDir, ".env-orbit")), { mode: 0o600 });
    renameSync(join(fixture.targetDir, ".env-orbit"), join(fixture.targetDir, aside));
    return fixture;
  }

  it("a folder with the aside and a backup's originals copy but no .env-orbit exits non-zero, names both, and creates nothing", () => {
    const { targetDir, environment } = killedRestoreFolder();
    const before = treeSnapshot(targetDir);
    const result = runInstall(targetDir, { ...environment, ...committedCanned() });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(aside);
    expect(result.stderr).toContain(`orbit-install-backups/${stamp}/originals/.env-orbit`);
    expect(result.engineRuns).toEqual([]);
    expect(treeSnapshot(targetDir)).toEqual(before);
  });

  it("the same folder with .env-orbit present installs as before", () => {
    const { targetDir, environment } = killedRestoreFolder();
    writeFileSync(join(targetDir, ".env-orbit"), readFileSync(join(targetDir, "orbit-install-backups", stamp, "originals", ".env-orbit")), { mode: 0o600 });
    const result = runInstall(targetDir, { ...environment, ...committedCanned() });
    expect(result.status, result.stderr).toBe(0);
    expect(result.engineRuns.length).toBeGreaterThan(0);
  });
});
