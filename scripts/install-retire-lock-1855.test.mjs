// scripts/install.sh --plain --update takes the backup/restore lock to retire
// the SMTP lines (#1855). Written from the specification alone (issue #1855,
// note 60203), before the change.
//
// The specification:
//  - the retirement takes `<backups>/.orbit-backup-restore.lock` (backups folder:
//    ${ORBIT_BACKUP_DIR:-<target>/backups}, made absolute against the target) with
//    `flock -n -x` before it changes anything, and holds it until the confirmation
//    and the step-record removal are done; a resumed retirement takes it too;
//  - lock held by anyone: retirement skipped, nothing changed, one stdout line
//    naming the backups folder use, exit 0;
//  - lock file unusable (symlink, not a regular file, ...): skipped as above, the line
//    names the lock file, which is never opened, followed or replaced;
//  - no `flock` on PATH: retirement goes ahead without the lock, one line says so;
//  - a fresh install, or a run with no retirement due, never touches the lock and
//    never creates the backups folder.
// The lock is probed from outside with a second, independent `flock -n`, from
// `mv` / `rm` shims placed ahead of the real ones on PATH.

import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PROCESS_TEST_TIMEOUT_MS } from "./process-budget.mjs";
import {
  baseEnvironment,
  installScript,
  makeFakeBin,
  makePreprovisionedDeployment,
  makeTarget,
  readOptional,
  recognisedVolume,
  runInstall,
} from "./install-test-support.mjs";

vi.setConfig({ testTimeout: PROCESS_TEST_TIMEOUT_MS });

const HELD_LINE =
  "Orbit installer: a backup, restore or Repair run is using the backups folder, so the old mail settings were left in place; the next update or Repair run will retire them.";
const COMPLETION_LINE =
  "Outgoing mail: SMTP credentials were migrated to Orbit's mail settings. They were removed from .env-orbit and deleted from the secrets folder.";
const FAKE_PASSWORD = "TEST-NOT-A-REAL-PASSWORD";
const RECORD = ".orbit-smtp-retirement";
const imported = "mail-sending source=imported imported-from-environment=true";
const GATE_FAILS_AFTER = { FAKE_MAIL_SENDING_STATUS_AFTER_SECRET_GONE: "mail-sending source=none imported-from-environment=false" };

const cleanups = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()();
});
const scratch = (label) => {
  const dir = mkdtempSync(join(tmpdir(), `orbit-1855-${label}-`));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};

function installedFolder() {
  const targetDir = makeTarget();
  makePreprovisionedDeployment(targetDir);
  expect(runInstall(targetDir, {}, ["--plain", "--install"]).status).toBe(0);
  return targetDir;
}

function withSmtpLines(targetDir) {
  const lines = [
    "COMPOSE_FILE=docker-compose.yml:docker-compose.mail.yml",
    "SMTP_HOST=smtp.example.test",
    "SMTP_PORT=587",
    "SMTP_SECURITY=starttls",
    "SMTP_USER=orbit@example.test",
    "SMTP_PASSWORD_FILE=/run/orbit-secrets/orbit-smtp-password",
    "SMTP_FROM=Orbit <orbit@example.test>",
    "",
  ];
  const envPath = join(targetDir, ".env-orbit");
  writeFileSync(envPath, `${readFileSync(envPath, "utf8")}${lines.join("\n")}`, { mode: 0o600 });
  writeFileSync(join(targetDir, ".orbit-secrets", "smtp-password"), FAKE_PASSWORD, { mode: 0o600 });
  return targetDir;
}

/**
 * Updates `targetDir` (status command answering `statusLine`). `pathFor(binDir)` builds PATH from the fake
 * bin directory; the default keeps the real PATH after it.
 */
function update(targetDir, statusLine = imported, { env = {}, pathFor } = {}) {
  const own = recognisedVolume("orbit");
  const binDir = makeFakeBin();
  const logDir = scratch("log");
  const stateDir = scratch("state");
  const base = baseEnvironment(binDir, logDir);
  const result = spawnSync("bash", [installScript, "--plain", "--update"], {
    cwd: targetDir,
    encoding: "utf8",
    timeout: 120_000,
    env: {
      ...base,
      ...(pathFor ? { PATH: pathFor(binDir) } : {}),
      FAKE_VOLUMES: own.volume,
      FAKE_PS: JSON.stringify(own.ps),
      FAKE_CONTAINER_IMAGES: JSON.stringify(own.images),
      FAKE_STATE_DIR: stateDir,
      XDG_STATE_HOME: join(stateDir, "state"),
      FAKE_MAIL_SENDING_STATUS: statusLine,
      ...env,
    },
  });
  return { ...result, calls: readOptional(join(logDir, "calls.log")) };
}

const backupsDir = (targetDir) => join(targetDir, "backups");
const lockOf = (targetDir) => join(backupsDir(targetDir), ".orbit-backup-restore.lock");
const envOf = (targetDir) => readFileSync(join(targetDir, ".env-orbit"), "utf8");
// Every update writes ORBIT_PREVIOUS_IMAGE= in the engine step, retirement or not.
const stableEnvOf = (targetDir) =>
  envOf(targetDir)
    .split("\n")
    .filter((entry) => !entry.startsWith("ORBIT_PREVIOUS_IMAGE="))
    .join("\n");
const secretPath = (targetDir) => join(targetDir, ".orbit-secrets", "smtp-password");
const stdoutLines = (result) => result.stdout.split("\n");
const upCalls = (result) => result.calls.split("\n").filter((entry) => /--env-file \.env-orbit up -d/u.test(entry));
const sleepMs = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/** The process group of a holder is killed, so the `sleep` under `flock` goes too and the lock is released. */
function killHolder(holder) {
  try {
    process.kill(-holder.pid, "SIGKILL");
  } catch {
    // already gone
  }
}

/** Starts `flock -x lock sleep 120` in its own process group and waits until the lock is really held. */
function startHolder(lock) {
  mkdirSync(dirname(lock), { recursive: true });
  const holder = spawn("flock", ["-x", lock, "sleep", "120"], { stdio: "ignore", detached: true });
  cleanups.push(() => killHolder(holder));
  const deadline = Date.now() + 10_000;
  while (spawnSync("flock", ["-n", lock, "true"]).status === 0) {
    if (Date.now() > deadline) throw new Error("the background flock never took the lock");
    sleepMs(25);
  }
  return holder;
}

/** Releases a holder and waits until the lock is free. */
function stopHolder(holder, lock) {
  killHolder(holder);
  const deadline = Date.now() + 10_000;
  while (spawnSync("flock", ["-n", lock, "true"]).status !== 0) {
    if (Date.now() > deadline) throw new Error("the lock was never released");
    sleepMs(25);
  }
}

const holdLock = (targetDir) => startHolder(lockOf(targetDir));

const lockIsFree = (targetDir) => spawnSync("flock", ["-n", lockOf(targetDir), "true"]).status === 0;

/** Everything a skipped retirement must leave exactly as it was. */
function expectUntouched(targetDir, before) {
  expect(stableEnvOf(targetDir)).toBe(before.env);
  expect(readFileSync(secretPath(targetDir), "utf8")).toBe(FAKE_PASSWORD);
  expect(existsSync(join(targetDir, "orbit-install-backups"))).toBe(false);
  expect(existsSync(join(targetDir, RECORD))).toBe(false);
}
const before = (targetDir) => ({ env: stableEnvOf(targetDir) });

// A PATH directory of links to every tool the test process can see, minus flock.
function dirWithoutFlock() {
  const dir = scratch("noflock");
  for (const source of new Set(process.env.PATH.split(delimiter))) {
    let names = [];
    try {
      names = readdirSync(source);
    } catch {
      continue;
    }
    for (const name of names) {
      if (name === "flock") continue;
      try {
        symlinkSync(join(source, name), join(dir, name));
      } catch {
        // an earlier PATH entry already provides it
      }
    }
  }
  return dir;
}

/**
 * `mv` and `rm` shims that, at the moment the retirement renames .env-orbit into place, deletes the secret, or
 * removes the step record, test the lock with an independent `flock -n` and log held / free / error.
 */
function lockProbes(lockPath) {
  const dir = scratch("probe");
  const out = join(dir, "probe.log");
  const probe = (label) =>
    `/usr/bin/flock -n '${lockPath}' true 2>/dev/null; case $? in 0) echo '${label}=free' >> '${out}' ;; 1) echo '${label}=held' >> '${out}' ;; *) echo '${label}=error' >> '${out}' ;; esac`;
  const realMv = existsSync("/usr/bin/mv") ? "/usr/bin/mv" : "/bin/mv";
  const realRm = existsSync("/usr/bin/rm") ? "/usr/bin/rm" : "/bin/rm";
  writeFileSync(
    join(dir, "mv"),
    `#!/bin/bash
case "\${*}" in *.retire-smtp.tmp*) ${probe("rewrite")} ;; esac
exec ${realMv} "$@"
`,
  );
  writeFileSync(
    join(dir, "rm"),
    `#!/bin/bash
for a in "$@"; do
  case "$a" in
    *.orbit-secrets/smtp-password) ${probe("secret")} ;;
    .orbit-smtp-retirement|*/.orbit-smtp-retirement) ${probe("record")} ;;
  esac
done
exec ${realRm} "$@"
`,
  );
  chmodSync(join(dir, "mv"), 0o755);
  chmodSync(join(dir, "rm"), 0o755);
  return { dir, probes: () => (existsSync(out) ? readFileSync(out, "utf8").split("\n").filter(Boolean) : []) };
}

describe("install.sh --plain --update: the SMTP retirement takes the backup/restore lock (#1855)", () => {
  it("1: the lock is held while .env-orbit is rewritten, while the secret is deleted and while the step record is removed, and free again afterwards", () => {
    const targetDir = withSmtpLines(installedFolder());
    const probe = lockProbes(lockOf(targetDir));
    const result = update(targetDir, imported, { pathFor: (binDir) => `${probe.dir}:${binDir}:${process.env.PATH}`, env: {} });
    expect(result.status).toBe(0);
    expect(stdoutLines(result)).toContain(COMPLETION_LINE);
    expect(existsSync(secretPath(targetDir))).toBe(false);
    const seen = probe.probes();
    expect(seen).toContain("rewrite=held");
    expect(seen).toContain("secret=held");
    expect(seen).toContain("record=held");
    expect(seen.filter((entry) => !entry.endsWith("=held"))).toEqual([]);
    expect(lockIsFree(targetDir)).toBe(true);
  });

  it("1: a retirement resumed from an unconfirmed step record takes the lock too (the record is removed under it)", () => {
    const targetDir = withSmtpLines(installedFolder());
    const first = update(targetDir, imported, { env: GATE_FAILS_AFTER });
    expect(first.status).toBe(0);
    expect(existsSync(join(targetDir, RECORD))).toBe(true);
    const probe = lockProbes(lockOf(targetDir));
    const second = update(targetDir, imported, { pathFor: (binDir) => `${probe.dir}:${binDir}:${process.env.PATH}` });
    expect(second.status).toBe(0);
    expect(existsSync(join(targetDir, RECORD))).toBe(false);
    expect(probe.probes()).toEqual(expect.arrayContaining(["record=held"]));
    expect(probe.probes().filter((entry) => !entry.endsWith("=held"))).toEqual([]);
    expect(lockIsFree(targetDir)).toBe(true);
  });

  it("2: with the lock held by another process, the retirement is skipped, one stdout line says why, nothing changes, exit 0", () => {
    const targetDir = withSmtpLines(installedFolder());
    const snap = before(targetDir);
    holdLock(targetDir);
    const result = update(targetDir);
    expect(result.status).toBe(0);
    expect(stdoutLines(result).filter((entry) => entry === HELD_LINE)).toHaveLength(1);
    expect(result.stdout).not.toContain(COMPLETION_LINE);
    expectUntouched(targetDir, snap);
    // Only the update's own start ran: the retirement's `up -d` did not.
    expect(upCalls(result)).toHaveLength(1);
  });

  it("2: a held lock also stops a resumed retirement: the undo copy and the step record stay as they were", () => {
    const targetDir = withSmtpLines(installedFolder());
    expect(update(targetDir, imported, { env: GATE_FAILS_AFTER }).status).toBe(0);
    const recordBefore = readFileSync(join(targetDir, RECORD), "utf8");
    const copies = readdirSync(join(targetDir, "orbit-install-backups")).sort();
    const envBefore = stableEnvOf(targetDir);
    holdLock(targetDir);
    const result = update(targetDir);
    expect(result.status).toBe(0);
    expect(stdoutLines(result)).toContain(HELD_LINE);
    expect(readFileSync(join(targetDir, RECORD), "utf8")).toBe(recordBefore);
    expect(readdirSync(join(targetDir, "orbit-install-backups")).sort()).toEqual(copies);
    expect(stableEnvOf(targetDir)).toBe(envBefore);
  });

  it("2: once the holder is gone the next update retires the lines", () => {
    const targetDir = withSmtpLines(installedFolder());
    const holder = holdLock(targetDir);
    expect(update(targetDir).stdout).toContain(HELD_LINE);
    stopHolder(holder, lockOf(targetDir));
    const result = update(targetDir);
    expect(result.status).toBe(0);
    expect(stdoutLines(result)).toContain(COMPLETION_LINE);
    expect(existsSync(secretPath(targetDir))).toBe(false);
  });

  it("3: a symlinked lock file: skipped, the line names the lock file, the link and its target are untouched", () => {
    const targetDir = withSmtpLines(installedFolder());
    const snap = before(targetDir);
    mkdirSync(backupsDir(targetDir), { recursive: true });
    const victim = join(scratch("victim"), "victim.txt");
    writeFileSync(victim, "keep me\n");
    symlinkSync(victim, lockOf(targetDir));
    const result = update(targetDir);
    expect(result.status).toBe(0);
    expect(stdoutLines(result).some((entry) => entry.includes(lockOf(targetDir)))).toBe(true);
    expect(result.stdout).not.toContain(COMPLETION_LINE);
    expect(lstatSync(lockOf(targetDir)).isSymbolicLink()).toBe(true);
    expect(readFileSync(victim, "utf8")).toBe("keep me\n");
    expectUntouched(targetDir, snap);
    expect(upCalls(result)).toHaveLength(1);
  });

  it("3: a dangling symlink as the lock file is not created through", () => {
    const targetDir = withSmtpLines(installedFolder());
    const snap = before(targetDir);
    mkdirSync(backupsDir(targetDir), { recursive: true });
    const missing = join(scratch("dangling"), "created-through-the-link");
    symlinkSync(missing, lockOf(targetDir));
    const result = update(targetDir);
    expect(result.status).toBe(0);
    expect(stdoutLines(result).some((entry) => entry.includes(lockOf(targetDir)))).toBe(true);
    expect(existsSync(missing)).toBe(false);
    expectUntouched(targetDir, snap);
  });

  it("3: a lock path that is a directory (not a regular file): skipped, the line names it", () => {
    const targetDir = withSmtpLines(installedFolder());
    const snap = before(targetDir);
    mkdirSync(lockOf(targetDir), { recursive: true });
    const result = update(targetDir);
    expect(result.status).toBe(0);
    expect(stdoutLines(result).some((entry) => entry.includes(lockOf(targetDir)))).toBe(true);
    expect(lstatSync(lockOf(targetDir)).isDirectory()).toBe(true);
    expectUntouched(targetDir, snap);
  });

  it("3: a backups folder that cannot hold the lock file (a regular file in its place): skipped, exit 0, nothing changed", () => {
    const targetDir = withSmtpLines(installedFolder());
    const snap = before(targetDir);
    writeFileSync(backupsDir(targetDir), "not a folder\n");
    const result = update(targetDir);
    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain(COMPLETION_LINE);
    expect(readFileSync(backupsDir(targetDir), "utf8")).toBe("not a folder\n");
    expectUntouched(targetDir, snap);
  });

  it("the backups folder follows ORBIT_BACKUP_DIR, relative to the target: a lock held there stops the retirement", () => {
    const targetDir = withSmtpLines(installedFolder());
    const snap = before(targetDir);
    startHolder(join(targetDir, "elsewhere", ".orbit-backup-restore.lock"));
    const result = update(targetDir, imported, { env: { ORBIT_BACKUP_DIR: "elsewhere" } });
    expect(result.status).toBe(0);
    expect(stdoutLines(result)).toContain(HELD_LINE);
    expectUntouched(targetDir, snap);
  });

  it("4: with no flock on PATH the retirement goes ahead without the lock, with one line saying so", () => {
    const targetDir = withSmtpLines(installedFolder());
    const noFlock = dirWithoutFlock();
    const result = update(targetDir, imported, { pathFor: (binDir) => `${binDir}:${noFlock}` });
    expect(result.status).toBe(0);
    expect(stdoutLines(result)).toContain(COMPLETION_LINE);
    expect(existsSync(secretPath(targetDir))).toBe(false);
    expect(envOf(targetDir)).not.toMatch(/^SMTP_/mu);
    expect(stdoutLines(result).filter((entry) => /flock/iu.test(entry))).toHaveLength(1);
  });

  it("4: with no flock on PATH a lock file held by another process does not stop the retirement", () => {
    const targetDir = withSmtpLines(installedFolder());
    holdLock(targetDir);
    const noFlock = dirWithoutFlock();
    const result = update(targetDir, imported, { pathFor: (binDir) => `${binDir}:${noFlock}` });
    expect(result.status).toBe(0);
    expect(stdoutLines(result)).toContain(COMPLETION_LINE);
    expect(result.stdout).not.toContain(HELD_LINE);
  });

  it("6: a deployment with no SMTP artefacts: no lock file and no backups folder appear", () => {
    const targetDir = installedFolder();
    const result = update(targetDir);
    expect(result.status).toBe(0);
    expect(existsSync(backupsDir(targetDir))).toBe(false);
    expect(existsSync(lockOf(targetDir))).toBe(false);
  });

  it("6: a fresh install does not touch the lock or create the backups folder", () => {
    const targetDir = makeTarget();
    makePreprovisionedDeployment(targetDir);
    const result = runInstall(targetDir, {}, ["--plain", "--install"]);
    expect(result.status).toBe(0);
    expect(existsSync(backupsDir(targetDir))).toBe(false);
    expect(existsSync(lockOf(targetDir))).toBe(false);
  });

  it("6: a fresh install of a folder that already holds SMTP lines does not touch the lock either", () => {
    const targetDir = makeTarget();
    makePreprovisionedDeployment(targetDir);
    withSmtpLines(targetDir);
    const result = runInstall(targetDir, { FAKE_MAIL_SENDING_STATUS: imported }, ["--plain", "--install"]);
    expect(result.status).toBe(0);
    expect(existsSync(lockOf(targetDir))).toBe(false);
    expect(existsSync(backupsDir(targetDir))).toBe(false);
  });
});
