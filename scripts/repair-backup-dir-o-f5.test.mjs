import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PROCESS_TEST_TIMEOUT_MS } from "./process-budget.mjs";
import { composeUpCalls, makeFixture, runRepair, scratchDir, treeSnapshot } from "./repair-test-harness.mjs";

// #1848 O-F5, written from the spec alone. When start-services,
// recreate-services or retire-smtp-lines must take the backup/restore lock and
// the lock file does not exist, repair creates the backups folder and the lock
// file. If that fails it refuses (nothing changed) with a reason that names
// the folder and says the user running repair can't create it or write the
// lock file in it, and names the way forward by whether ORBIT_BACKUP_DIR is set.

vi.setConfig({ testTimeout: PROCESS_TEST_TIMEOUT_MS });

const isRoot = process.getuid?.() === 0;
const STOPPED = { db: "stopped", app: "stopped" };
const RUNNING = { db: "running", app: "running" };
const MACHINE = { ORBIT_REPAIR_PROMPTS: "machine" };
const SMTP_ANSWER = "mail-sending source=imported imported-from-environment=true";
const EXEC = ["--execute", "--safe-only"];

// Everything chmod-ed in a test is put back so the temp dirs can be removed.
const restores = [];
afterEach(() => {
  while (restores.length > 0) {
    const [path, mode] = restores.pop();
    try {
      chmodSync(path, mode);
    } catch {
      // already gone
    }
  }
});
function lockDown(path, mode = 0o555) {
  restores.push([path, 0o755]);
  chmodSync(path, mode);
}

function movedLabels() {
  const scratch = scratchDir();
  const labelsPath = join(scratch, "labels");
  writeFileSync(labelsPath, `${join(scratch, "old-orbit-folder")}\n`);
  return { workingDirLabelsPath: labelsPath };
}

function withMail() {
  const targetDir = makeFixture();
  writeFileSync(
    join(targetDir, ".env-orbit"),
    [
      "SMTP_HOST=smtp.example.test",
      "SMTP_PORT=587",
      "SMTP_SECURITY=starttls",
      "SMTP_USER=orbit@example.test",
      "SMTP_PASSWORD_FILE=/run/orbit-secrets/orbit-smtp-password",
      "SMTP_FROM=Orbit <orbit@example.test>",
      "",
    ].join("\n"),
    { flag: "a" },
  );
  return targetDir;
}

// Each action: how to build the fixture and the options of the run.
const ACTIONS = {
  "start-services": () => ({ targetDir: makeFixture(), options: STOPPED, args: EXEC }),
  "recreate-services": () => ({ targetDir: makeFixture(), options: { ...RUNNING, docker: movedLabels() }, args: EXEC }),
  "retire-smtp-lines": () => ({ targetDir: withMail(), options: { ...RUNNING, mailStatus: SMTP_ANSWER }, args: EXEC, input: "y\n", machine: true }),
};

function run(action, extraEnv) {
  const made = ACTIONS[action]();
  const options = { ...made.options, env: { ...(made.machine ? MACHINE : {}), ...extraEnv } };
  if (made.input) options.input = made.input;
  return { targetDir: made.targetDir, run: () => runRepair(made.targetDir, made.args, options) };
}

function expectRefusedNothingChanged(action, result, before, targetDir) {
  expect(result.stdout).toContain(`execute action=${action}`);
  expect(result.stdout).toContain("result=failed");
  expect(result.stdout).not.toMatch(new RegExp(`execute action=${action} \\S+ result=done`, "u"));
  expect(result.status).toBe(4);
  expect(result.stderr).toContain(`Orbit repair: ${action} refused, nothing was changed:`);
  expect(composeUpCalls(result).filter((line) => !line.includes("--no-recreate"))).toEqual([]);
  expect(treeSnapshot(targetDir)).toBe(before);
}

function expectNewWording(result, folder) {
  expect(result.stderr).toContain(folder);
  expect(result.stderr).toMatch(/can't create/u);
  expect(result.stderr).toContain("writable");
  expect(result.stderr).toContain("re-run repair");
  expect(result.stderr).not.toContain("can't be read");
}

describe("O-F5: ORBIT_BACKUP_DIR set, under a parent repair cannot write", () => {
  for (const action of Object.keys(ACTIONS)) {
    it.skipIf(isRoot)(`${action}: refused with the set-variant guidance, nothing changed`, () => {
      const parent = scratchDir("orbit-backups-parent-");
      lockDown(parent);
      const folder = join(parent, "backups");
      const { targetDir, run: go } = run(action, { ORBIT_BACKUP_DIR: folder });
      const before = treeSnapshot(targetDir);
      const result = go();
      expectRefusedNothingChanged(action, result, before, targetDir);
      expectNewWording(result, folder);
      expect(result.stderr).toContain("ORBIT_BACKUP_DIR points at");
      expect(result.stderr).toMatch(/mount or create/u);
      expect(result.stderr).toContain("backup.sh");
      expect(existsSync(folder)).toBe(false);
    });
  }
});

describe("O-F5: ORBIT_BACKUP_DIR set, folder exists but the lock file cannot be created in it", () => {
  for (const action of Object.keys(ACTIONS)) {
    it.skipIf(isRoot)(`${action}: refused, nothing changed, lock not created`, () => {
      const folder = scratchDir("orbit-backups-ro-");
      lockDown(folder);
      const { targetDir, run: go } = run(action, { ORBIT_BACKUP_DIR: folder });
      const before = treeSnapshot(targetDir);
      const result = go();
      expectRefusedNothingChanged(action, result, before, targetDir);
      expectNewWording(result, folder);
      expect(result.stderr).toContain("ORBIT_BACKUP_DIR points at");
      expect(existsSync(join(folder, ".orbit-backup-restore.lock"))).toBe(false);
    });
  }
});

describe("O-F5: ORBIT_BACKUP_DIR not set, default ./backups cannot be created", () => {
  for (const action of Object.keys(ACTIONS)) {
    it.skipIf(isRoot)(`${action}: refused with the unset-variant guidance, nothing changed`, () => {
      const { targetDir, run: go } = run(action);
      const before = treeSnapshot(targetDir);
      lockDown(targetDir); // the deployment folder is unwritable, so ./backups cannot be made
      let result;
      try {
        result = go();
      } finally {
        chmodSync(targetDir, 0o755);
      }
      lockDown(targetDir, 0o755);
      expectRefusedNothingChanged(action, result, before, targetDir);
      expectNewWording(result, join(targetDir, "backups"));
      expect(result.stderr).toContain("ORBIT_BACKUP_DIR");
      expect(result.stderr).not.toContain("ORBIT_BACKUP_DIR points at");
      expect(result.stderr).toMatch(/create that folder|create .*backups/u);
      expect(result.stderr).toContain("set ORBIT_BACKUP_DIR");
      expect(existsSync(join(targetDir, "backups"))).toBe(false);
    });
  }

  it.skipIf(isRoot)("an existing but unwritable ./backups gives the unset-variant guidance too", () => {
    const { targetDir, run: go } = run("start-services");
    const folder = join(targetDir, "backups");
    mkdirSync(folder);
    lockDown(folder);
    const result = go();
    expect(result.status).toBe(4);
    expectNewWording(result, folder);
    expect(result.stderr).not.toContain("ORBIT_BACKUP_DIR points at");
    expect(composeUpCalls(result)).toEqual([]);
  });
});

describe("O-F5: unchanged behaviour", () => {
  it.skipIf(isRoot)("an existing lock file that is not readable still says it can't be read", () => {
    const { targetDir, run: go } = run("start-services");
    mkdirSync(join(targetDir, "backups"));
    const lock = join(targetDir, "backups", ".orbit-backup-restore.lock");
    writeFileSync(lock, "");
    chmodSync(lock, 0o000);
    const result = go();
    expect(result.status).toBe(4);
    expect(result.stderr).toContain(`the lock at ${lock} can't be read`);
    expect(result.stderr).not.toContain("can't create");
    expect(composeUpCalls(result)).toEqual([]);
  });

  it("a directory at the lock path still says it can't be read", () => {
    const { targetDir, run: go } = run("start-services");
    const lock = join(targetDir, "backups", ".orbit-backup-restore.lock");
    mkdirSync(lock, { recursive: true });
    const result = go();
    expect(result.status).toBe(4);
    expect(result.stderr).toContain(`the lock at ${lock} can't be read`);
    expect(result.stderr).not.toContain("can't create");
  });

  it.skipIf(isRoot)("a check-only run treats a missing lock as free and creates nothing, even in an unwritable place", () => {
    const parent = scratchDir("orbit-backups-parent-");
    lockDown(parent);
    const folder = join(parent, "backups");
    const targetDir = makeFixture();
    const result = runRepair(targetDir, ["--check"], { ...STOPPED, env: { ORBIT_BACKUP_DIR: folder } });
    expect(result.stderr).not.toContain("can't create");
    expect(result.stderr).not.toContain("can't be read");
    expect(existsSync(folder)).toBe(false);
    expect(composeUpCalls(result)).toEqual([]);
  });

  it("a writable place still works: the folder and lock are created and services start", () => {
    const parent = scratchDir("orbit-backups-parent-");
    const folder = join(parent, "backups");
    const { run: go } = run("start-services", { ORBIT_BACKUP_DIR: folder });
    const result = go();
    expect(result.status).toBe(0);
    expect(composeUpCalls(result)).toHaveLength(1);
    expect(existsSync(join(folder, ".orbit-backup-restore.lock"))).toBe(true);
  });
});
