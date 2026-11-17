import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { ACTIONS, IMAGE_COMPOSE, runOwner } from "./repair-owner-fixtures.mjs";
import { GID, UID, privShims } from "./repair-priv-shims.mjs";
import { composeUpCalls, scratchDir, treeSnapshot } from "./repair-test-harness.mjs";

// #1857 (spec: note 61725, S1-S5): run as root in a folder another user owns, start-services,
// recreate-services, restore-compose-file and the .env-orbit configuration-rollback restore make and replace
// everything in the folder as that owner (setpriv), or refuse with nothing changed. Written from the spec alone.
// Root is simulated with the PATH shims of the #1848 test (repair-priv-shims.mjs): `id -u` says 0, setpriv checks
// its arguments, sets ORBIT_TEST_PRIVDROP=1 and execs, and the file tools log whether it was set.

vi.setConfig({ testTimeout: 90_000 });

const REFUSALS = {
  "the owner can't be read": { shims: { ownerUnreadable: true }, words: /the deployment folder's owner could not be read/u },
  "setpriv is missing": { shims: { setpriv: false }, words: /through setpriv/u },
  "setsid --wait is missing": { shims: { setsid: "no-wait" }, words: /setsid --wait/u },
  "the owner has no user-database entry": { shims: { getent: "fail" }, words: new RegExp(`could not look up the deployment folder's owner \\(uid ${UID}\\) in the user database`, "u") },
};

const MUTATING = ["mktemp", "chmod", "mv", "rm", "rmdir", "mkdir"];
const EXTRA = ["cp", "install", "touch", "ln", "tee"];
const notOwnedByTestUser = (targetDir) =>
  spawnSync("find", [targetDir, "(", "-not", "-uid", String(UID), "-o", "-not", "-gid", String(GID), ")"], { encoding: "utf8" }).stdout.split("\n").filter(Boolean);

/** Tool calls that create, rename or remove something under the folder (cp and the like count by their destination). */
function writesUnderFolder(shims, targetDir) {
  return shims.toolCalls().filter((line) => {
    const tool = line.split(" ")[0];
    if (MUTATING.includes(tool)) return / under=1 /u.test(line);
    const cwd = /cwd=(\S*)/u.exec(line)?.[1] ?? "";
    const last = line.replace(/^.* args=/u, "").trim().split(/\s+/u).pop() ?? "";
    const dest = last.startsWith("/") ? last : join(cwd, last);
    return dest === targetDir || dest.startsWith(`${targetDir}/`);
  });
}

function expectOwnerWrites(shims, targetDir) {
  const writes = writesUnderFolder(shims, targetDir);
  expect(writes.length, `no file tool call named a path under the folder:\n${shims.toolCalls().join("\n")}`).toBeGreaterThan(0);
  expect(writes.filter((line) => !/ marker=1 /u.test(line)), "root created, renamed or removed something in the folder itself, outside setpriv").toEqual([]);
  expect(shims.setprivCalls().filter((line) => line.startsWith("BAD ")), "setpriv called without the required options").toEqual([]);
  for (const line of shims.setprivCalls()) {
    expect(line).toContain(`--reuid=${UID}`);
    expect(line).toContain(`--regid=${GID}`);
    expect(line).toContain("--no-new-privs");
  }
  expect(shims.chownCalls(), "root ran chown instead of making the file as its owner").toEqual([]);
  expect(notOwnedByTestUser(targetDir)).toEqual([]);
}

const shimsFor = (targetDir, options = {}) => privShims(targetDir, { extraTools: EXTRA, ...options });

describe("#1857 S1: one owner check; each refusal leaves the folder exactly as it was", () => {
  for (const [name, action] of Object.entries(ACTIONS)) {
    for (const [what, refusal] of Object.entries(REFUSALS)) {
      it(`${name}: ${what} refuses with the retire-smtp-lines words, nothing changed`, () => {
        const { targetDir, state, fakeBin } = action.make();
        const shims = shimsFor(targetDir, refusal.shims);
        if (refusal.shims.setpriv === false) expect(spawnSync("bash", ["-c", "command -v setpriv"], { env: shims.env, encoding: "utf8" }).stdout.trim(), "setpriv is still on PATH").toBe("");
        const before = treeSnapshot(targetDir);
        const result = runOwner(targetDir, { shims, state, fakeBin });
        expect(result.hung, result.stderr).toBe(false);
        expect(result.stderr, `no refusal naming the check:\n${result.stderr}`).toMatch(refusal.words);
        expect(result.stdout).not.toContain(action.done);
        expect(result.status).toBe(4);
        expect(composeUpCalls(result)).toEqual([]);
        expect(treeSnapshot(targetDir)).toBe(before);
      });
    }
  }

  it("not root: no owner check, no setpriv, the same results as today (start-services)", () => {
    const { targetDir, state } = ACTIONS["start-services"].make();
    const shims = shimsFor(targetDir, { root: false, setpriv: false, getent: "fail" });
    const result = runOwner(targetDir, { shims, state });
    expect(result.stdout, result.stderr).toContain(ACTIONS["start-services"].done);
    expect(shims.setprivCalls()).toEqual([]);
  });
});

describe("#1857 S2: start-services and recreate-services make the backups folder and lock as the owner", () => {
  for (const name of ["start-services", "recreate-services"]) {
    const action = ACTIONS[name];
    it(`${name}: a missing backups folder and lock file are made under setpriv, never by root`, () => {
      const { targetDir, state } = action.make();
      expect(existsSync(join(targetDir, "backups"))).toBe(false);
      const shims = shimsFor(targetDir);
      const result = runOwner(targetDir, { shims, state });
      expect(result.stdout, result.stderr).toContain(action.done);
      expect(existsSync(join(targetDir, "backups", ".orbit-backup-restore.lock"))).toBe(true);
      expect(shims.setprivCalls().some((line) => /backups/u.test(line)), `no setpriv call names backups:\n${shims.setprivCalls().join("\n")}`).toBe(true);
      expectOwnerWrites(shims, targetDir);
      expect(composeUpCalls(result).length).toBeGreaterThan(0);
    });

    it(`${name}: a backups link pointing outside the folder gets nothing created there by root`, () => {
      const { targetDir, state } = action.make();
      const outside = scratchDir("orbit-owner-outside-");
      symlinkSync(outside, join(targetDir, "backups"));
      const shims = shimsFor(targetDir);
      const result = runOwner(targetDir, { shims, state });
      expect(shims.setprivCalls().length, "the lock was not made through setpriv").toBeGreaterThan(0);
      const bare = shims.toolCalls().filter((line) => / marker=0 /u.test(line) && (line.includes(outside) || / under=1 /u.test(line)));
      expect(bare, `root made something through the backups link:\n${result.stderr}`).toEqual([]);
      expect(shims.chownCalls()).toEqual([]);
      expect(readdirSync(outside).every((entry) => entry.startsWith(".orbit-backup-restore"))).toBe(true);
    });

    it(`${name}: when the owner can't make the backups folder, the owner-specific refusal applies and root makes nothing`, () => {
      const { targetDir, state } = action.make();
      const shims = shimsFor(targetDir, { setprivFail: '*backups*' });
      const before = treeSnapshot(targetDir);
      const result = runOwner(targetDir, { shims, state });
      expect(result.stdout).not.toContain(action.done);
      expect(result.stderr).toMatch(new RegExp(`${name} refused, nothing was changed: .*deployment folder's owner .*can't create the backups folder`, "u"));
      expect(result.status).toBe(4);
      expect(composeUpCalls(result)).toEqual([]);
      expect(existsSync(join(targetDir, "backups")), "root made backups/ itself").toBe(false);
      expect(treeSnapshot(targetDir)).toBe(before);
    });
  }
});

describe("#1857 S3: restore-compose-file creates docker-compose.yml as the owner", () => {
  const action = ACTIONS["restore-compose-file"];

  it("the temporary file, its mode and the rename all run under setpriv; the file is the image's, mode 0644, nothing else is left", () => {
    const { targetDir, state, fakeBin } = action.make();
    const shims = shimsFor(targetDir);
    const result = runOwner(targetDir, { shims, state, fakeBin });
    expect(result.stdout, result.stderr).toContain(action.done);
    const calls = shims.toolCalls().filter((line) => / under=1 /u.test(line));
    for (const tool of ["mktemp", "chmod", "mv"]) {
      expect(calls.some((line) => line.startsWith(`${tool} `) && / marker=1 /u.test(line)), `no ${tool} ran under setpriv:\n${shims.toolCalls().join("\n")}`).toBe(true);
    }
    expect(calls.some((line) => /^mv .*-n/u.test(line) || /^mv .*docker-compose\.yml/u.test(line)), "the rename did not name docker-compose.yml").toBe(true);
    expectOwnerWrites(shims, targetDir);
    const restored = join(targetDir, "docker-compose.yml");
    expect(readFileSync(restored).equals(IMAGE_COMPOSE)).toBe(true);
    expect((statSync(restored).mode & 0o777).toString(8)).toBe("644");
    expect(readdirSync(targetDir).filter((name) => name.includes(".repair."))).toEqual([]);
  });

  it("when the owner's rename fails, the action reports failed and nothing is left behind", () => {
    const { targetDir, state, fakeBin } = action.make();
    const shims = shimsFor(targetDir, { setprivFail: '*" mv "*' });
    const before = treeSnapshot(targetDir);
    const result = runOwner(targetDir, { shims, state, fakeBin });
    expect(shims.setprivCalls().length, "the restore never used setpriv").toBeGreaterThan(0);
    expect(result.stdout).toContain("execute action=restore-compose-file resolves=compose-file-restorable result=failed");
    expect(existsSync(join(targetDir, "docker-compose.yml"))).toBe(false);
    expect(treeSnapshot(targetDir)).toBe(before);
  });

  it("when the owner can't make the temporary file, the action reports failed and root makes nothing in the folder", () => {
    const { targetDir, state, fakeBin } = action.make();
    const shims = shimsFor(targetDir, { setprivFail: '*mktemp*' });
    const before = treeSnapshot(targetDir);
    const result = runOwner(targetDir, { shims, state, fakeBin });
    expect(shims.setprivCalls().length, "the restore never used setpriv").toBeGreaterThan(0);
    expect(result.stdout).toContain("execute action=restore-compose-file resolves=compose-file-restorable result=failed");
    expect(writesUnderFolder(shims, targetDir).filter((line) => !/ marker=1 /u.test(line))).toEqual([]);
    expect(treeSnapshot(targetDir)).toBe(before);
  });

  it("a file that appears while the image is being read is not overwritten", () => {
    const { targetDir, state, fakeBin } = action.make();
    // The fake docker's `run` makes the file appear: wrap it.
    const wrapper = scratchDir("orbit-owner-race-");
    const body = `#!/usr/bin/env bash\nif [[ "$1" == run ]]; then printf 'written by someone else\\n' > '${join(targetDir, "docker-compose.yml")}'; fi\nexec '${join(fakeBin, "docker")}' "$@"\n`;
    spawnSync("bash", ["-c", `printf '%s' "$1" > "$2/docker" && chmod 755 "$2/docker"`, "x", body, wrapper]);
    const shims = shimsFor(targetDir);
    const result = runOwner(targetDir, { shims, state, fakeBin: wrapper, env: { PATH: `${fakeBin}:${shims.env.PATH}` } });
    expect(readFileSync(join(targetDir, "docker-compose.yml"), "utf8")).toBe("written by someone else\n");
    expect(result.stdout).toContain("execute action=restore-compose-file resolves=compose-file-restorable result=failed");
    expect(shims.setprivCalls().length, "the restore never used setpriv").toBeGreaterThan(0);
    expect(readdirSync(targetDir).filter((name) => name.includes(".repair."))).toEqual([]);
    expect(writesUnderFolder(shims, targetDir).filter((line) => !/ marker=1 /u.test(line))).toEqual([]);
  });
});

describe("#1857 S4: the .env-orbit configuration-rollback restore makes and replaces everything as the owner", () => {
  const action = ACTIONS["restore-config-rollback"];
  const ROLLBACK = ".env-orbit.orbit-config.rollback";

  it("the recovery folder, its evidence copy, the staged file, its rename and the removal of the rollback copy all run under setpriv", () => {
    const { targetDir, state } = action.make();
    const rollback = readFileSync(join(targetDir, ROLLBACK), "utf8");
    const shims = shimsFor(targetDir);
    const result = runOwner(targetDir, { shims, state });
    expect(result.stdout, result.stderr).toContain(action.done);
    const calls = shims.setprivCalls();
    const named = (re) => calls.some((line) => re.test(line));
    expect(named(/mkdir .*\.orbit-repair-recovery/u), `the recovery folder was not made as the owner:\n${calls.join("\n")}`).toBe(true);
    expect(named(/\.orbit-repair-recovery\S*\/live\S*\.env-orbit/u), "the evidence copy of .env-orbit was not made as the owner").toBe(true);
    expect(named(/mktemp .*\.env-orbit\.repair-restore\./u), "the staged file was not made as the owner").toBe(true);
    expect(named(/mv .*\.env-orbit\.repair-restore\.\S* \S*\.env-orbit$/u), "the rename onto .env-orbit was not done as the owner").toBe(true);
    expect(named(/rm .*\.env-orbit\.orbit-config\.rollback/u), "the rollback copy was not removed as the owner").toBe(true);
    expectOwnerWrites(shims, targetDir);
    expect(readFileSync(join(targetDir, ".env-orbit"), "utf8")).toBe(rollback);
    expect((statSync(join(targetDir, ".env-orbit")).mode & 0o777).toString(8)).toBe("600");
    expect(existsSync(join(targetDir, ROLLBACK))).toBe(false);
    expect(readdirSync(targetDir).filter((name) => name.startsWith(".env-orbit.repair-restore."))).toEqual([]);
  });

  it("when the owner's rename fails, the action reports failed, .env-orbit and the rollback copy are as they were, nothing is left", () => {
    const { targetDir, state } = action.make();
    const shims = shimsFor(targetDir, { setprivFail: '*" mv "*' });
    const before = treeSnapshot(targetDir);
    const envBefore = readFileSync(join(targetDir, ".env-orbit"));
    const result = runOwner(targetDir, { shims, state });
    expect(shims.setprivCalls().length, "the restore never used setpriv").toBeGreaterThan(0);
    expect(result.stdout).toContain("execute action=restore-transaction resolves=configuration-migration-interrupted result=failed");
    expect(readFileSync(join(targetDir, ".env-orbit")).equals(envBefore)).toBe(true);
    expect(existsSync(join(targetDir, ROLLBACK))).toBe(true);
    expect(writesUnderFolder(shims, targetDir).filter((line) => !/ marker=1 /u.test(line))).toEqual([]);
    expect(treeSnapshot(targetDir)).toBe(before);
  });

  it("when the owner can't make the recovery folder, the action reports failed and root makes nothing in the folder", () => {
    const { targetDir, state } = action.make();
    const shims = shimsFor(targetDir, { setprivFail: '*mkdir*' });
    const before = treeSnapshot(targetDir);
    const result = runOwner(targetDir, { shims, state });
    expect(shims.setprivCalls().length, "the restore never used setpriv").toBeGreaterThan(0);
    expect(result.stdout).toContain("execute action=restore-transaction resolves=configuration-migration-interrupted result=failed");
    expect(writesUnderFolder(shims, targetDir).filter((line) => !/ marker=1 /u.test(line))).toEqual([]);
    expect(treeSnapshot(targetDir)).toBe(before);
  });
});

describe("#1857 S5: guarantee 59 names the actions", () => {
  it("docs/installer-guarantees.md lists start-services, recreate-services, restore-compose-file and the .env-orbit restore beside retire-smtp-lines", () => {
    const text = readFileSync(new URL("../docs/installer-guarantees.md", import.meta.url), "utf8");
    const section = /^59\. `smtp-lines-retirable`.*$/mu.exec(text)?.[0];
    expect(section, "the repair guarantee 59 (smtp-lines-retirable) was not found").toBeDefined();
    for (const name of ["retire-smtp-lines", "start-services", "recreate-services", "restore-compose-file"]) expect(section).toContain(name);
    expect(section, "the configuration-rollback restore of .env-orbit is not named").toMatch(/orbit-config\.rollback|configuration-migration-interrupted|configuration[- ]rollback/u);
  });
});
