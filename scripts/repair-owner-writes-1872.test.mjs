import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { runOwner } from "./repair-owner-fixtures.mjs";
import { GID, UID, privShims } from "./repair-priv-shims.mjs";
import { makeFixture, scratchDir, treeSnapshot } from "./repair-test-harness.mjs";

// #1872 (spec V1-V8): run as root in a folder another user owns, the remaining repair actions that write there
// (restore-transaction, the credential checkpoint, rotate-credential, regenerate-secret, the diagnostics file,
// fix-permissions) write as that owner (setpriv), under the #1858 limits, or refuse with nothing written. Written
// from the spec alone, on the #1857/#1858 shims: `id -u` says 0, setpriv checks its arguments, sets
// ORBIT_TEST_PRIVDROP=1 and execs, and each file tool logs whether it was set (marker=1) and whether it names a
// path in the folder (under=1).

vi.setConfig({ testTimeout: 90_000 });

const PASSPHRASE = "correct-horse-battery-staple";
const LIMIT = { ORBIT_REPAIR_OWNER_STEP_TIMEOUT: "2" };
// The limit (2 s) plus the kill grace (5 s) plus a slow host's start-up; 40 s keeps a loaded runner from flaking.
const BUDGET_MS = 40_000;
const LOCK = ["backups", ".orbit-backup-restore.lock"];
const EXTRA = ["cp", "install", "touch", "ln", "tee"];
const ROOT_WRITE_TOOLS = ["mkdir", "mktemp", "chmod", "mv", "cp"];
const HEX = /^[0-9a-f]{64}$/u;
const shimsFor = (targetDir, options = {}) => privShims(targetDir, { extraTools: EXTRA, ...options });
const orbitLines = (result) => result.stderr.split("\n").filter((line) => line.startsWith("Orbit repair:"));
const lockFree = (targetDir) => !existsSync(join(targetDir, ...LOCK)) || spawnSync("flock", ["-n", join(targetDir, ...LOCK), "true"], { encoding: "utf8" }).status === 0;
const modeOf = (path) => (statSync(path).mode & 0o777).toString(8);

/** Calls root itself (marker=0) made that create, change or move something in the folder. The rename of the staged database password onto the live secret belongs to update-config, not to these actions. */
function rootWrites(shims) {
  return shims.toolCalls().filter((line) => ROOT_WRITE_TOOLS.includes(line.split(" ")[0]) && / marker=0 /u.test(line) && / under=1 /u.test(line) && !line.includes(".repair-staged-postgres-password"));
}

function expectNoRootWrites(shims) {
  expect(rootWrites(shims), "root created, changed or moved something in the folder itself, outside setpriv").toEqual([]);
  expect(shims.chownCalls(), "root ran chown").toEqual([]);
  expect(shims.setprivCalls().filter((line) => line.startsWith("BAD ")), "setpriv called without the required options").toEqual([]);
  for (const line of shims.setprivCalls()) {
    expect(line).toContain(`--reuid=${UID}`);
    expect(line).toContain(`--regid=${GID}`);
    expect(line).toContain("--no-new-privs");
  }
}

const setprivNaming = (shims, re) => shims.setprivCalls().filter((line) => re.test(line));

// --- scenarios: one folder and one command line for each action ---------------------------------------------------

const STAGING = ".orbit-install-staging.abc123";

function restoreFolder() {
  const targetDir = makeFixture();
  const original = join(targetDir, STAGING, "rollback", "original");
  mkdirSync(original, { recursive: true, mode: 0o700 });
  for (const dir of [join(targetDir, STAGING), join(targetDir, STAGING, "rollback"), original]) chmodSync(dir, 0o700);
  writeFileSync(join(original, ".env-orbit"), "APP_URL=https://orbit.old-good-state.internal\nCOMPOSE_PROJECT_NAME=repairtest\n", { mode: 0o600 });
  writeFileSync(join(original, "docker-compose.yml"), "services:\n  orbit-app:\n    image: old-good\n");
  // Live but never backed up: removed by the restore.
  writeFileSync(join(targetDir, "docker-compose.mail.yml"), "services: {}\n");
  return { targetDir, state: { ...RUNNING } };
}

function mismatchFolder() {
  const targetDir = makeFixture();
  const markers = scratchDir();
  return { targetDir, state: { db: "running", app: "running", docker: { db: { present: true, ready: true, authResult: "mismatch" }, dbAuthMarkerPath: join(markers, "db-auth-marker") } } };
}

function missingSecretFolder() {
  const targetDir = makeFixture();
  rmSync(join(targetDir, ".orbit-secrets", "session-secret"));
  return { targetDir, state: { ...RUNNING } };
}

function looseEnvFolder() {
  const targetDir = makeFixture();
  chmodSync(join(targetDir, ".env-orbit"), 0o644);
  return { targetDir, state: { ...RUNNING } };
}

function plainFolder() {
  return { targetDir: makeFixture(), state: { ...RUNNING } };
}

const RUNNING = { db: "running", app: "running" };
const SAFE = ["--execute", "--safe-only"];
const DANGEROUS = ["--execute", "--dangerous"];

const ACTIONS = {
  "restore-transaction": {
    make: restoreFolder,
    args: SAFE,
    input: "y\n",
    done: "execute action=restore-transaction resolves=staging-evidence-present result=done",
    stall: "*mkdir*",
    flood: "*mkdir*",
  },
  "credential checkpoint": {
    make: mismatchFolder,
    args: DANGEROUS,
    input: `rotate\n${PASSPHRASE}\n${PASSPHRASE}\n`,
    done: "execute action=rotate-database-credential resolves=database-credential-mismatch result=done",
    stall: "*orbit-repair-checkpoint*",
    flood: "*orbit-repair-checkpoint*",
  },
  "rotate-credential": {
    make: mismatchFolder,
    args: DANGEROUS,
    input: `rotate\n${PASSPHRASE}\n${PASSPHRASE}\n`,
    done: "execute action=rotate-database-credential resolves=database-credential-mismatch result=done",
    stall: "*smtp-owner-write*.installing.*",
    flood: "*smtp-owner-write*.installing.*",
  },
  "regenerate-secret": {
    make: missingSecretFolder,
    args: DANGEROUS,
    input: "regenerate\n",
    done: "execute action=regenerate-secret resolves=secret-missing result=done",
    stall: "*smtp-owner-write*.installing.*",
    flood: "*smtp-owner-write*.installing.*",
  },
  diagnostics: {
    make: plainFolder,
    args: ["--export-diagnostics"],
    input: "y\n",
    done: "Orbit repair: diagnostics exported to ",
    stall: "*orbit-repair-diagnostics*",
    flood: "*orbit-repair-diagnostics*",
  },
  "fix-permissions": {
    make: looseEnvFolder,
    args: SAFE,
    input: "y\n",
    done: "execute action=fix-permissions resolves=managed-file-permissions result=done",
    stall: "*chmod*",
    flood: "*chmod*",
  },
};

const finished = (action, result) => (action.args === DANGEROUS || action.args === SAFE ? result.stdout : result.stderr).includes(action.done);

function run(name, shims, { targetDir, state }, options = {}) {
  const action = ACTIONS[name];
  return runOwner(targetDir, { shims, state, args: action.args, input: action.input, capSeconds: 60, ...options });
}

/** Everything under the folder except the backups folder and its lock (taken as the owner, by the existing lock steps). */
const withoutBackups = (snapshot) => snapshot.split("\n").filter((line) => !line.startsWith("./backups")).join("\n");

// --- V1 ---------------------------------------------------------------------------------------------------------------

describe("#1872 V1: the owner check comes first; a missing setpriv refuses each action with nothing written", () => {
  for (const name of Object.keys(ACTIONS)) {
    it(`${name}: setpriv missing refuses with the usual 'Orbit repair:' line and the folder is exactly as it was`, () => {
      const folder = ACTIONS[name].make();
      const shims = shimsFor(folder.targetDir, { setpriv: false });
      expect(spawnSync("bash", ["-c", "command -v setpriv"], { env: shims.env, encoding: "utf8" }).stdout.trim(), "setpriv is still on PATH").toBe("");
      const before = withoutBackups(treeSnapshot(folder.targetDir));
      const result = run(name, shims, folder);
      expect(result.hung, result.stderr).toBe(false);
      expect(orbitLines(result).some((line) => /through setpriv/u.test(line)), `no refusal naming setpriv:\n${result.stderr.slice(0, 1500)}`).toBe(true);
      expect(finished(ACTIONS[name], result)).toBe(false);
      expect(result.status).not.toBe(0);
      expect(rootWrites(shims)).toEqual([]);
      expect(withoutBackups(treeSnapshot(folder.targetDir))).toBe(before);
    });
  }

  for (const name of ["restore-transaction", "regenerate-secret", "diagnostics", "fix-permissions"]) {
    it(`${name}: an owner that can't be read refuses the same way, nothing written`, () => {
      const folder = ACTIONS[name].make();
      const shims = shimsFor(folder.targetDir, { ownerUnreadable: true });
      const before = withoutBackups(treeSnapshot(folder.targetDir));
      const result = run(name, shims, folder);
      expect(orbitLines(result).some((line) => /the deployment folder's owner could not be read/u.test(line)), result.stderr.slice(0, 1500)).toBe(true);
      expect(finished(ACTIONS[name], result)).toBe(false);
      expect(rootWrites(shims)).toEqual([]);
      expect(withoutBackups(treeSnapshot(folder.targetDir))).toBe(before);
    });
  }
});

// --- V2 ---------------------------------------------------------------------------------------------------------------

describe("#1872 V2: restore-transaction makes, copies and moves everything as the owner", () => {
  it("the recovery folder, the copy of the live file, the move aside and the restore all run under setpriv; root writes nothing", () => {
    const folder = restoreFolder();
    const shims = shimsFor(folder.targetDir);
    const result = run("restore-transaction", shims, folder);
    expect(result.stdout, result.stderr).toContain(ACTIONS["restore-transaction"].done);
    expectNoRootWrites(shims);
    expect(setprivNaming(shims, /mkdir .*\.orbit-repair-recovery/u), "the recovery folder was not made as the owner").not.toEqual([]);
    expect(setprivNaming(shims, /cp .*\.orbit-repair-recovery\S*\/live/u), "the copy of the current file was not made as the owner").not.toEqual([]);
    expect(setprivNaming(shims, /mv .*\.env-orbit\.pre-restore\./u), "the dated backup of .env-orbit was not moved as the owner").not.toEqual([]);
    expect(setprivNaming(shims, /cp .*\.orbit-install-staging\.abc123\/rollback\/original\/\.env-orbit/u), "the restore copy was not made as the owner").not.toEqual([]);
    expect(readFileSync(join(folder.targetDir, ".env-orbit"), "utf8")).toContain("old-good-state");
    expect(readdirSync(folder.targetDir).filter((entry) => entry.startsWith(".env-orbit.pre-restore."))).toHaveLength(1);
  });

  it("when the owner's copy into the recovery folder fails, the action reports failed and root made nothing", () => {
    const folder = restoreFolder();
    const shims = shimsFor(folder.targetDir, { setprivFail: "*cp*" });
    const result = run("restore-transaction", shims, folder);
    expect(shims.setprivCalls().length, "the restore never used setpriv").toBeGreaterThan(0);
    expect(result.stdout).toContain("execute action=restore-transaction resolves=staging-evidence-present result=failed");
    expectNoRootWrites(shims);
  });
});

// --- V3 ---------------------------------------------------------------------------------------------------------------

describe("#1872 V3: the credential checkpoint folder and its contents are made by the owner", () => {
  it("the .orbit-repair-checkpoint folder and the bundle in it are made and set to their modes under setpriv; root writes nothing", () => {
    const folder = mismatchFolder();
    const shims = shimsFor(folder.targetDir);
    const result = run("credential checkpoint", shims, folder);
    expect(result.stdout, result.stderr).toContain(ACTIONS["credential checkpoint"].done);
    expectNoRootWrites(shims);
    expect(setprivNaming(shims, /orbit-repair-checkpoint/u), "the checkpoint folder was not made as the owner").not.toEqual([]);
    expect(setprivNaming(shims, /orbit-repair-checkpoint\S*\/postgres-password\.orbkek/u), "the bundle was not written or set to its mode as the owner").not.toEqual([]);
    expect(setprivNaming(shims, /(mktemp -d|mkdir) .*orbit-repair-checkpoint|chmod 700 .*orbit-repair-checkpoint|orbit-repair-checkpoint\S* 700/u), "the checkpoint folder was not made with mode 700 as the owner").not.toEqual([]);
  });

  it("when the owner can't make the checkpoint folder, the rotation is refused and root makes nothing in the folder", () => {
    const folder = mismatchFolder();
    const shims = shimsFor(folder.targetDir, { setprivFail: "*orbit-repair-checkpoint*" });
    const result = run("credential checkpoint", shims, folder);
    expect(shims.setprivCalls().length, "the checkpoint never used setpriv").toBeGreaterThan(0);
    expect(result.stdout).not.toContain(ACTIONS["credential checkpoint"].done);
    expect(readFileSync(join(folder.targetDir, ".orbit-secrets", "postgres-password"), "utf8")).toBe(`${"a".repeat(64)}\n`);
    expect(readdirSync(folder.targetDir).filter((entry) => entry.startsWith(".orbit-repair-checkpoint."))).toEqual([]);
    expectNoRootWrites(shims);
  });
});

// --- V4 ---------------------------------------------------------------------------------------------------------------

describe("#1872 V4: rotate-credential and regenerate-secret write the secret as the owner, through standard input", () => {
  const everyRecordedCommand = (shims) => [...shims.toolCalls(), ...shims.setprivCalls(), ...shims.chownCalls(), ...shims.children().map((child) => child.line), ...shims.envRecords().map((record) => record.line)];

  it("regenerate-secret: the temp file, its mode 600 and the rename run under setpriv; the secret is on no command line", () => {
    const folder = missingSecretFolder();
    const shims = shimsFor(folder.targetDir);
    const result = run("regenerate-secret", shims, folder);
    expect(result.stdout, result.stderr).toContain(ACTIONS["regenerate-secret"].done);
    expectNoRootWrites(shims);
    const target = join(folder.targetDir, ".orbit-secrets", "session-secret");
    const secret = readFileSync(target, "utf8").trim();
    expect(secret).toMatch(HEX);
    expect(modeOf(target)).toBe("600");
    const temp = setprivNaming(shims, /\.orbit-secrets\S*\/?\.installing\./u);
    expect(temp, "the temp file in .orbit-secrets was not made as the owner").not.toEqual([]);
    expect(temp.join("\n")).toMatch(/\b600\b/u);
    expect(setprivNaming(shims, /mv .*\.orbit-secrets\/session-secret/u), "the rename into place was not done as the owner").not.toEqual([]);
    expect(everyRecordedCommand(shims).filter((line) => line.includes(secret)), "the secret appeared in a command line").toEqual([]);
    expect(readdirSync(join(folder.targetDir, ".orbit-secrets")).filter((entry) => entry.startsWith(".installing."))).toEqual([]);
  });

  it("rotate-credential: the temp file, its mode 600 and the rename run under setpriv; the new password is on no command line", () => {
    const folder = mismatchFolder();
    const shims = shimsFor(folder.targetDir);
    const result = run("rotate-credential", shims, folder);
    expect(result.stdout, result.stderr).toContain(ACTIONS["rotate-credential"].done);
    expectNoRootWrites(shims);
    const password = readFileSync(join(folder.targetDir, ".orbit-secrets", "postgres-password"), "utf8").trim();
    expect(password).toMatch(HEX);
    expect(password).not.toBe("a".repeat(64));
    const temp = setprivNaming(shims, /\.orbit-secrets\S*\/?\.installing\./u);
    expect(temp, "the temp file in .orbit-secrets was not made as the owner").not.toEqual([]);
    expect(temp.join("\n")).toMatch(/\b600\b/u);
    expect(setprivNaming(shims, /mv .*\.repair-staged-postgres-password/u), "the rename onto the staged name was not done as the owner").not.toEqual([]);
    expect(everyRecordedCommand(shims).filter((line) => line.includes(password)), "the password appeared in a command line").toEqual([]);
    expect(readdirSync(join(folder.targetDir, ".orbit-secrets")).filter((entry) => entry.startsWith(".installing."))).toEqual([]);
  });

  it("regenerate-secret: when .orbit-secrets is not the owner's, the action is refused and nothing is written", () => {
    const folder = missingSecretFolder();
    const shims = shimsFor(folder.targetDir, { rootOwned: "dir" });
    const before = withoutBackups(treeSnapshot(folder.targetDir));
    const result = run("regenerate-secret", shims, folder);
    expect(result.stdout).not.toContain(ACTIONS["regenerate-secret"].done);
    expect(orbitLines(result).length, "no 'Orbit repair:' line says why").toBeGreaterThan(0);
    expect(existsSync(join(folder.targetDir, ".orbit-secrets", "session-secret"))).toBe(false);
    expect(rootWrites(shims)).toEqual([]);
    expect(withoutBackups(treeSnapshot(folder.targetDir))).toBe(before);
  });

  it("regenerate-secret: when the owner can't make the temp file, the action reports failed and root makes nothing", () => {
    const folder = missingSecretFolder();
    const shims = shimsFor(folder.targetDir, { setprivFail: "*smtp-owner-write*" });
    const before = withoutBackups(treeSnapshot(folder.targetDir));
    const result = run("regenerate-secret", shims, folder);
    expect(shims.setprivCalls().length, "the secret was never written through setpriv").toBeGreaterThan(0);
    expect(result.stdout).not.toContain(ACTIONS["regenerate-secret"].done);
    expect(rootWrites(shims)).toEqual([]);
    expect(withoutBackups(treeSnapshot(folder.targetDir))).toBe(before);
  });
});

// --- V5 ---------------------------------------------------------------------------------------------------------------

describe("#1872 V5: the diagnostics file is made, written, set to mode 600 and renamed by the owner", () => {
  it("the temp file and its contents go through setpriv; the file is mode 600; root writes nothing", () => {
    const folder = plainFolder();
    const shims = shimsFor(folder.targetDir);
    const result = run("diagnostics", shims, folder);
    expect(result.stderr, result.stdout).toContain("diagnostics exported to ");
    expectNoRootWrites(shims);
    const made = setprivNaming(shims, /orbit-repair-diagnostics/u);
    expect(made, "the diagnostics file was not made as the owner").not.toEqual([]);
    expect(made.join("\n")).toMatch(/\b600\b/u);
    const files = readdirSync(folder.targetDir).filter((entry) => entry.startsWith(".orbit-repair-diagnostics."));
    expect(files).toHaveLength(1);
    const path = join(folder.targetDir, files[0]);
    expect(modeOf(path)).toBe("600");
    expect(readFileSync(path, "utf8")).toContain("diagnosis result=");
  });

  it("when the owner can't make the file, the export fails and root makes nothing in the folder", () => {
    const folder = plainFolder();
    const shims = shimsFor(folder.targetDir, { setprivFail: "*orbit-repair-diagnostics*" });
    const before = treeSnapshot(folder.targetDir);
    const result = run("diagnostics", shims, folder);
    expect(shims.setprivCalls().length, "the export never used setpriv").toBeGreaterThan(0);
    expect(result.status).not.toBe(0);
    expect(result.stderr).not.toContain("diagnostics exported to ");
    expect(rootWrites(shims)).toEqual([]);
    expect(treeSnapshot(folder.targetDir)).toBe(before);
  });
});

// --- V6 ---------------------------------------------------------------------------------------------------------------

describe("#1872 V6: fix-permissions runs chmod as the owner and never by path as root", () => {
  it("chmod of .env-orbit runs under setpriv; root runs no chmod in the folder", () => {
    const folder = looseEnvFolder();
    const shims = shimsFor(folder.targetDir);
    const result = run("fix-permissions", shims, folder);
    expect(result.stdout, result.stderr).toContain(ACTIONS["fix-permissions"].done);
    expectNoRootWrites(shims);
    expect(setprivNaming(shims, /chmod 600 .*\.env-orbit/u), "chmod was not run as the owner").not.toEqual([]);
    expect(modeOf(join(folder.targetDir, ".env-orbit"))).toBe("600");
  });

  it("the secrets folder and a secret file are set the same way", () => {
    const targetDir = makeFixture();
    chmodSync(join(targetDir, ".orbit-secrets"), 0o755);
    chmodSync(join(targetDir, ".orbit-secrets", "postgres-password"), 0o644);
    const shims = shimsFor(targetDir);
    const result = runOwner(targetDir, { shims, state: { ...RUNNING }, args: SAFE, capSeconds: 60 });
    expect(result.stdout, result.stderr).toContain("execute action=fix-permissions resolves=secrets-directory-invalid result=done");
    expectNoRootWrites(shims);
    expect(setprivNaming(shims, /chmod 700 .*\.orbit-secrets/u), "the folder's chmod was not run as the owner").not.toEqual([]);
    expect(modeOf(join(targetDir, ".orbit-secrets"))).toBe("700");
  });

  it("a file the folder's owner does not own is left unchanged, reported failed, and the line names the path and says it is not the folder owner's", () => {
    const folder = looseEnvFolder();
    // Not the owner's: `stat` reports root for it, and the owner's own chmod is refused, as it would be for real.
    const shims = shimsFor(folder.targetDir, {
      rootOwned: "env",
      toolFail: { tool: "chmod", match: "*env-orbit*", emit: "echo \"chmod: changing permissions of '.env-orbit': Operation not permitted\" >&2" },
    });
    const result = run("fix-permissions", shims, folder);
    expect(result.stdout).toContain("execute action=fix-permissions resolves=managed-file-permissions result=failed");
    expect(modeOf(join(folder.targetDir, ".env-orbit"))).toBe("644");
    const named = orbitLines(result).filter((line) => line.includes(".env-orbit") && /not owned by the (deployment )?folder's owner/u.test(line));
    expect(named, `no line names the path and says it is not owned by the folder's owner:\n${result.stderr.slice(0, 1500)}`).not.toEqual([]);
    expect(rootWrites(shims)).toEqual([]);
  });
});

// --- V7 ---------------------------------------------------------------------------------------------------------------

describe("#1872 V7: each owner step is time- and size-bounded; a failure releases the lock and leaves nothing root made", () => {
  /** A folder with the backups folder and its lock already there (so the lock steps are not what is under test). */
  function prepared(name) {
    const folder = ACTIONS[name].make();
    mkdirSync(join(folder.targetDir, LOCK[0]), { mode: 0o700 });
    writeFileSync(join(folder.targetDir, ...LOCK), "", { mode: 0o600 });
    return folder;
  }

  const leftovers = (targetDir) =>
    [targetDir, join(targetDir, ".orbit-secrets")].flatMap((dir) => readdirSync(dir).filter((entry) => /^(\.installing\.|\.orbit-repair-recovery\.|\.orbit-repair-checkpoint\.|\.orbit-repair-diagnostics\.|\.env-orbit\.pre-restore\.|\.env-orbit\.repair-restore\.)/u.test(entry)));

  function expectBounded(name, result, folder, shims, reason) {
    expect(result.hung, `repair was still running after the test's own cap:\n${result.stderr.slice(0, 600)}`).toBe(false);
    expect(result.ms, "repair outlived the step limit plus the kill grace").toBeLessThan(BUDGET_MS);
    expect(finished(ACTIONS[name], result)).toBe(false);
    expect(result.status).not.toBe(0);
    const named = orbitLines(result).filter((line) => reason.test(line));
    expect(named, `no 'Orbit repair:' line gives the reason ${reason}:\n${result.stderr.slice(0, 1500)}`).not.toEqual([]);
    expect(named.every((line) => line.length < 5000), "a line over the 4096-byte cap").toBe(true);
    expect(result.stderr.length, "the child's words were not capped").toBeLessThan(40_000);
    expect(leftovers(folder.targetDir), "a temp file or folder was left behind").toEqual([]);
    expect(rootWrites(shims)).toEqual([]);
    expect(lockFree(folder.targetDir), "the backup/restore lock is still held").toBe(true);
  }

  for (const name of Object.keys(ACTIONS)) {
    it(`${name}: a stalled owner step ends as timed out within the limit plus grace, no lock held, nothing left`, () => {
      const folder = prepared(name);
      const shims = shimsFor(folder.targetDir, { variant: { kind: "stop", match: ACTIONS[name].stall } });
      try {
        const result = run(name, shims, folder, { env: LIMIT });
        expect(setprivNaming(shims, /./u).length, "no owner step was started").toBeGreaterThan(0);
        expectBounded(name, result, folder, shims, /timed out/iu);
      } finally {
        shims.cleanup();
      }
    });

    it(`${name}: an owner step that floods its output is capped and the action fails with nothing left`, () => {
      const folder = prepared(name);
      const shims = shimsFor(folder.targetDir, { variant: { kind: "flood", match: ACTIONS[name].flood } });
      try {
        const result = run(name, shims, folder, { env: LIMIT });
        expect(setprivNaming(shims, /./u).length, "no owner step was started").toBeGreaterThan(0);
        expectBounded(name, result, folder, shims, /Orbit repair:/u);
      } finally {
        shims.cleanup();
      }
    });
  }
});

// --- not root: unchanged ----------------------------------------------------------------------------------------------

describe("#1872: not root, nothing changes (no owner check, no setpriv, the same results as today)", () => {
  const notRoot = (targetDir) => shimsFor(targetDir, { root: false, setpriv: false, getent: "fail" });

  for (const name of Object.keys(ACTIONS)) {
    it(`${name}: runs and finishes as before`, () => {
      const folder = ACTIONS[name].make();
      const shims = notRoot(folder.targetDir);
      const result = run(name, shims, folder);
      expect(finished(ACTIONS[name], result), `${result.stdout}\n${result.stderr}`).toBe(true);
      expect(shims.setprivCalls()).toEqual([]);
    });
  }

  it("fix-permissions: the file is mode 600 afterwards; regenerate-secret: the secret is 64 hex at mode 600", () => {
    const loose = looseEnvFolder();
    runOwner(loose.targetDir, { shims: notRoot(loose.targetDir), state: { ...RUNNING }, args: SAFE, capSeconds: 60 });
    expect(modeOf(join(loose.targetDir, ".env-orbit"))).toBe("600");
    const missing = missingSecretFolder();
    run("regenerate-secret", notRoot(missing.targetDir), missing);
    const secret = join(missing.targetDir, ".orbit-secrets", "session-secret");
    expect(readFileSync(secret, "utf8").trim()).toMatch(HEX);
    expect(modeOf(secret)).toBe("600");
  });
});

// --- V8 ---------------------------------------------------------------------------------------------------------------

describe("#1872 V8: guarantee 59 names these actions as owner writes", () => {
  it("docs/installer-guarantees.md lists restore-transaction, the credential checkpoint, rotate-credential, regenerate-secret, the diagnostics file and fix-permissions", () => {
    const text = readFileSync(new URL("../docs/installer-guarantees.md", import.meta.url), "utf8");
    const section = /^59\. `smtp-lines-retirable`.*$/mu.exec(text)?.[0];
    expect(section, "the repair guarantee 59 (smtp-lines-retirable) was not found").toBeDefined();
    for (const name of ["restore-transaction", "rotate-credential", "regenerate-secret", "fix-permissions"]) expect(section).toContain(name);
    expect(section, "the credential checkpoint is not named").toMatch(/checkpoint/u);
    expect(section, "the diagnostics file is not named").toMatch(/diagnostics/u);
  });
});
