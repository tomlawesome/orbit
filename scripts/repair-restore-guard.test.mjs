import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { PROCESS_TEST_TIMEOUT_MS } from "./process-budget.mjs";
import {
  composeUpCalls,
  makeFixture,
  runRepair,
  runRepairBetweenPlanAndExecute,
  scratchDir,
  stderrLines,
  treeSnapshot,
} from "./repair-test-harness.mjs";

// #1804 point 1: an unfinished restore. Written from the issue text alone.
// The restore journal (`<backups>/.orbit-restore/restore.journal`, with the
// backups folder `${ORBIT_BACKUP_DIR:-<deployment folder>/backups}`) is the
// restore's lease on Orbit. Present = anything exists at that path (a symlink
// too, dangling or not; never followed, read or removed) or `.orbit-restore`
// exists but cannot be searched. Planning: finding `restore-unfinished`
// (target restore, severity warn); services-not-running and folder-moved are
// planned manual, everything else as usual. Acting: do_start_services and
// do_recreate_services check again and refuse (result=failed, exit 4, nothing
// changed), and refuse while backup.sh/restore.sh hold the lock.

vi.setConfig({ testTimeout: PROCESS_TEST_TIMEOUT_MS });

const FINDING = "finding class=restore-unfinished target=restore severity=warn";
const MANUAL_GUIDANCE =
  "manual step: a restore has not been finished and keeps Orbit stopped; run bash scripts/restore.sh --finish once Orbit is healthy, or bash scripts/restore.sh --recover to roll it back, then re-run repair (resolves=services-not-running)";
const LOCK_REASON = "a backup or restore is running right now; wait for it to end, then re-run repair.";

const backupsOf = (targetDir, backupDir) => backupDir ?? join(targetDir, "backups");
const journalOf = (targetDir, backupDir) => join(backupsOf(targetDir, backupDir), ".orbit-restore", "restore.journal");
const lockOf = (targetDir, backupDir) => join(backupsOf(targetDir, backupDir), ".orbit-backup-restore.lock");

function plantJournal(targetDir, backupDir) {
  mkdirSync(join(backupsOf(targetDir, backupDir), ".orbit-restore"), { recursive: true });
  writeFileSync(journalOf(targetDir, backupDir), '{"step":"half-done"}\n');
}

// Containers made in a folder that is now gone, still running.
function movedLabels(_targetDir) {
  const scratch = scratchDir();
  const labelsPath = join(scratch, "labels");
  writeFileSync(labelsPath, `${join(scratch, "old-orbit-folder")}\n`);
  return { workingDirLabelsPath: labelsPath };
}

const STOPPED = { db: "stopped", app: "stopped" };
const envFor = (backupDir) => (backupDir ? { ORBIT_BACKUP_DIR: backupDir } : undefined);

describe("#1804 restore-unfinished: diagnosis", () => {
  it("raises the finding when the journal is a regular file", () => {
    const targetDir = makeFixture();
    plantJournal(targetDir);
    const result = runRepair(targetDir, ["--check"], STOPPED);
    expect(result.stdout).toContain(FINDING);
  });

  it("raises nothing when there is no journal (pins the quiet case)", () => {
    const targetDir = makeFixture();
    mkdirSync(join(targetDir, "backups", ".orbit-restore"), { recursive: true });
    const result = runRepair(targetDir, ["--check"], STOPPED);
    expect(result.stdout).not.toContain("restore-unfinished");
  });

  it("counts a dangling symlink at the journal path as present, and leaves it alone", () => {
    const targetDir = makeFixture();
    mkdirSync(join(targetDir, "backups", ".orbit-restore"), { recursive: true });
    const missing = join(scratchDir(), "does-not-exist");
    symlinkSync(missing, journalOf(targetDir));
    const result = runRepair(targetDir, ["--check"], STOPPED);
    expect(result.stdout).toContain(FINDING);
    expect(lstatSync(journalOf(targetDir)).isSymbolicLink()).toBe(true);
    expect(readlinkSync(journalOf(targetDir))).toBe(missing);
  });

  it("counts a symlink to a real file as present, and never follows, reads or removes it", () => {
    const targetDir = makeFixture();
    mkdirSync(join(targetDir, "backups", ".orbit-restore"), { recursive: true });
    const elsewhere = join(scratchDir(), "real-journal");
    writeFileSync(elsewhere, "target content\n");
    symlinkSync(elsewhere, journalOf(targetDir));
    const result = runRepair(targetDir, ["--execute", "--safe-only"], STOPPED);
    expect(result.stdout).toContain(FINDING);
    expect(lstatSync(journalOf(targetDir)).isSymbolicLink()).toBe(true);
    expect(readFileSync(elsewhere, "utf8")).toBe("target content\n");
    expect(composeUpCalls(result)).toEqual([]);
  });

  it("counts an unsearchable .orbit-restore as present (fails closed)", () => {
    const targetDir = makeFixture();
    plantJournal(targetDir);
    const restoreDir = join(targetDir, "backups", ".orbit-restore");
    chmodSync(restoreDir, 0o000);
    try {
      const result = runRepair(targetDir, ["--check"], STOPPED);
      expect(result.stdout).toContain(FINDING);
    } finally {
      chmodSync(restoreDir, 0o700);
    }
  });

  it("reads the journal from ORBIT_BACKUP_DIR when it is set", () => {
    const targetDir = makeFixture();
    const custom = scratchDir("orbit-backups-");
    plantJournal(targetDir, custom);
    const result = runRepair(targetDir, ["--check"], { ...STOPPED, env: envFor(custom) });
    expect(result.stdout).toContain(FINDING);
  });

  it("does not look in the default folder when ORBIT_BACKUP_DIR points elsewhere", () => {
    const targetDir = makeFixture();
    plantJournal(targetDir); // default <deployment>/backups, which restore.sh would not use
    const custom = scratchDir("orbit-backups-");
    const result = runRepair(targetDir, ["--check"], { ...STOPPED, env: envFor(custom) });
    expect(result.stdout).not.toContain("restore-unfinished");
  });

  it("raises it even when Orbit is otherwise healthy", () => {
    const targetDir = makeFixture();
    plantJournal(targetDir);
    const result = runRepair(targetDir, ["--check"], { db: "running", app: "running" });
    expect(result.stdout).toContain(FINDING);
  });
});

describe("#1804 restore-unfinished: planning", () => {
  it("plans services-not-running as manual with the restore guidance, and no start-services", () => {
    const targetDir = makeFixture();
    plantJournal(targetDir);
    const before = treeSnapshot(targetDir);
    const result = runRepair(targetDir, ["--plan"], STOPPED);

    expect(result.stdout).toContain("plan action=manual resolves=services-not-running");
    expect(result.stdout).not.toContain("plan action=start-services");
    expect(result.stderr).toContain(MANUAL_GUIDANCE);
    expect(composeUpCalls(result)).toEqual([]);
    expect(treeSnapshot(targetDir)).toBe(before);
  });

  it("plans the same when no container exists at all, if the database volume does", () => {
    const targetDir = makeFixture();
    plantJournal(targetDir);
    const result = runRepair(targetDir, ["--plan"], {
      db: "absent",
      app: "absent",
      docker: { volumes: ["repairtest_orbit-db-data"] },
    });
    expect(result.stdout).toContain("plan action=manual resolves=services-not-running");
    expect(result.stdout).not.toContain("plan action=start-services");
    expect(result.stderr).toContain(MANUAL_GUIDANCE);
  });

  it("plans folder-moved as manual, not recreate-services", () => {
    const targetDir = makeFixture();
    plantJournal(targetDir);
    const result = runRepair(targetDir, ["--plan"], { db: "running", app: "running", docker: movedLabels(targetDir) });

    expect(runRepair(targetDir, ["--check"], { db: "running", app: "running", docker: movedLabels(targetDir) }).stdout).toContain(
      "finding class=folder-moved",
    );
    expect(result.stdout).toContain("plan action=manual resolves=folder-moved");
    expect(result.stdout).not.toContain("plan action=recreate-services");
  });

  it("plans folder-moved with stopped services as manual too, and starts nothing", () => {
    const targetDir = makeFixture();
    plantJournal(targetDir);
    const result = runRepair(targetDir, ["--execute", "--safe-only"], { ...STOPPED, docker: movedLabels(targetDir) });
    expect(result.stdout).not.toContain("plan action=recreate-services");
    expect(result.stdout).not.toContain("execute action=recreate-services");
    expect(result.stdout).not.toContain("execute action=start-services");
    expect(composeUpCalls(result)).toEqual([]);
  });

  it("plans repair's other actions as usual (not a whole-run refusal)", () => {
    const targetDir = makeFixture();
    plantJournal(targetDir);
    chmodSync(join(targetDir, ".env-orbit"), 0o644); // managed-file-permissions
    const state = { db: "running", app: "running" };
    const plan = runRepair(targetDir, ["--plan"], state);
    expect(plan.stdout).toMatch(/^plan action=(?!manual)[a-z-]+ resolves=managed-file-permissions /mu);

    const executed = runRepair(targetDir, ["--execute", "--safe-only"], state);
    expect(executed.stdout).toMatch(/^execute action=(?!manual)[a-z-]+ resolves=managed-file-permissions result=done$/mu);
    expect(executed.stdout).not.toMatch(/^execution result=refused/mu);
    expect(executed.status).not.toBe(6);
    expect(lstatSync(join(targetDir, ".env-orbit")).mode & 0o777).toBe(0o600);
  });

  it("--execute --safe-only with the journal from the start skips the manual step and never runs compose up", () => {
    const targetDir = makeFixture();
    plantJournal(targetDir);
    const result = runRepair(targetDir, ["--execute", "--safe-only"], STOPPED);
    expect(result.stdout).toContain("execute action=manual resolves=services-not-running result=skipped");
    expect(composeUpCalls(result)).toEqual([]);
    expect(result.stderr).toContain(MANUAL_GUIDANCE);
  });
});

describe("#1804 restore-unfinished: refused again at execution time", () => {
  // The journal appears after the plan was made and before the action runs:
  // repair.sh runs in machine-prompt mode, which stops on a confirmation after
  // printing the plan; the journal is created at that prompt, then "y" is sent.
  it("do_start_services refuses, changes nothing, result=failed, exit 4", async () => {
    const targetDir = makeFixture();
    const result = await runRepairBetweenPlanAndExecute(targetDir, ["--execute", "--safe-only"], STOPPED, () =>
      plantJournal(targetDir),
    );
    expect(result.stdout).toContain("plan action=start-services resolves=services-not-running"); // planned: no journal yet
    expect(result.stdout).toContain("execute action=start-services resolves=services-not-running result=failed");
    expect(result.stdout).toContain("execution result=failed done=0 failed=1");
    expect(result.status).toBe(4);
    expect(composeUpCalls(result)).toEqual([]);
    expect(result.stateOf("orbit-db")).toBe("stopped");
    expect(result.stateOf("orbit-app")).toBe("stopped");
    expect(result.stderr).toContain("Orbit repair: start-services refused, nothing was changed: a restore has not been finished (journal at ");
    expect(result.stderr).toContain(`${join(".orbit-restore", "restore.journal")}); run bash scripts/restore.sh --finish once Orbit is healthy, or --recover to roll it back.`);
    expect(existsSync(journalOf(targetDir))).toBe(true);
    expect(readFileSync(journalOf(targetDir), "utf8")).toBe('{"step":"half-done"}\n');
  });

  it("do_recreate_services refuses, changes nothing, result=failed, exit 4", async () => {
    const targetDir = makeFixture();
    const result = await runRepairBetweenPlanAndExecute(
      targetDir,
      ["--execute", "--safe-only"],
      { db: "running", app: "running", docker: movedLabels(targetDir) },
      () => plantJournal(targetDir),
    );
    expect(result.stdout).toContain("plan action=recreate-services resolves=folder-moved");
    expect(result.stdout).toContain("execute action=recreate-services resolves=folder-moved result=failed");
    expect(result.stdout).toContain("execution result=failed done=0 failed=1");
    expect(result.status).toBe(4);
    expect(composeUpCalls(result)).toEqual([]);
    expect(result.stateOf("orbit-db")).toBe("running");
    expect(result.stderr).toContain("Orbit repair: recreate-services refused, nothing was changed: a restore has not been finished (journal at ");
    expect(result.stderr).toContain("run bash scripts/restore.sh --finish once Orbit is healthy, or --recover to roll it back.");
  });

  it("a dangling symlink appearing at the journal path refuses too", async () => {
    const targetDir = makeFixture();
    const result = await runRepairBetweenPlanAndExecute(targetDir, ["--execute", "--safe-only"], STOPPED, () => {
      mkdirSync(join(targetDir, "backups", ".orbit-restore"), { recursive: true });
      symlinkSync(join(scratchDir(), "nowhere"), journalOf(targetDir));
    });
    expect(result.stdout).toContain("execute action=start-services resolves=services-not-running result=failed");
    expect(result.status).toBe(4);
    expect(composeUpCalls(result)).toEqual([]);
  });

  it("an .orbit-restore that cannot be searched at execution time refuses (fails closed)", async () => {
    const targetDir = makeFixture();
    const restoreDir = join(targetDir, "backups", ".orbit-restore");
    try {
      const result = await runRepairBetweenPlanAndExecute(targetDir, ["--execute", "--safe-only"], STOPPED, () => {
        plantJournal(targetDir);
        chmodSync(restoreDir, 0o000);
      });
      expect(result.stdout).toContain("execute action=start-services resolves=services-not-running result=failed");
      expect(result.status).toBe(4);
      expect(composeUpCalls(result)).toEqual([]);
    } finally {
      if (existsSync(restoreDir)) chmodSync(restoreDir, 0o700);
    }
  });

  it("honours ORBIT_BACKUP_DIR at execution time", async () => {
    const targetDir = makeFixture();
    const custom = scratchDir("orbit-backups-");
    const result = await runRepairBetweenPlanAndExecute(targetDir, ["--execute", "--safe-only"], { ...STOPPED, env: envFor(custom) }, () =>
      plantJournal(targetDir, custom),
    );
    expect(result.stdout).toContain("execute action=start-services resolves=services-not-running result=failed");
    expect(result.status).toBe(4);
    expect(composeUpCalls(result)).toEqual([]);
    expect(result.stderr).toContain(journalOf(targetDir, custom));
  });
});

// Holds `flock -x` on a lock file from a background process until released.
async function holdLock(lockPath) {
  mkdirSync(join(lockPath, ".."), { recursive: true });
  const holder = spawn("flock", ["-x", lockPath, "sleep", "60"], { stdio: "ignore" });
  const deadline = Date.now() + 10_000;
  while (spawnSync("flock", ["-n", lockPath, "true"]).status === 0) {
    if (Date.now() > deadline) throw new Error("the background flock never took the lock");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return () => holder.kill("SIGKILL");
}

describe("#1804 the backup/restore lock at execution time", () => {
  it("a held lock does not stop the plan: start-services is still planned", async () => {
    const targetDir = makeFixture();
    const release = await holdLock(lockOf(targetDir));
    try {
      const result = runRepair(targetDir, ["--plan"], STOPPED);
      expect(result.stdout).toContain("plan action=start-services resolves=services-not-running");
    } finally {
      release();
    }
  });

  it("start-services is refused while another process holds the lock", async () => {
    const targetDir = makeFixture();
    const release = await holdLock(lockOf(targetDir));
    try {
      const result = runRepair(targetDir, ["--execute", "--safe-only"], STOPPED);
      expect(result.stdout).toContain("execute action=start-services resolves=services-not-running result=failed");
      expect(result.stdout).toContain("execution result=failed done=0 failed=1");
      expect(result.status).toBe(4);
      expect(composeUpCalls(result)).toEqual([]);
      expect(result.stateOf("orbit-db")).toBe("stopped");
      expect(stderrLines(result).join("\n")).toContain(`Orbit repair: start-services refused, nothing was changed: ${LOCK_REASON}`);
    } finally {
      release();
    }
  });

  it("recreate-services is refused while another process holds the lock", async () => {
    const targetDir = makeFixture();
    const release = await holdLock(lockOf(targetDir));
    try {
      const result = runRepair(targetDir, ["--execute", "--safe-only"], {
        db: "running",
        app: "running",
        docker: movedLabels(targetDir),
      });
      expect(result.stdout).toContain("execute action=recreate-services resolves=folder-moved result=failed");
      expect(result.status).toBe(4);
      expect(composeUpCalls(result)).toEqual([]);
      expect(result.stderr).toContain(`Orbit repair: recreate-services refused, nothing was changed: ${LOCK_REASON}`);
    } finally {
      release();
    }
  });

  it("looks for the lock in ORBIT_BACKUP_DIR", async () => {
    const targetDir = makeFixture();
    const custom = scratchDir("orbit-backups-");
    const release = await holdLock(lockOf(targetDir, custom));
    try {
      const result = runRepair(targetDir, ["--execute", "--safe-only"], { ...STOPPED, env: envFor(custom) });
      expect(result.status).toBe(4);
      expect(composeUpCalls(result)).toEqual([]);
      expect(result.stderr).toContain(LOCK_REASON);
    } finally {
      release();
    }
  });

  it("a lock file that exists but is free does not block: services start", () => {
    const targetDir = makeFixture();
    mkdirSync(join(targetDir, "backups"), { recursive: true });
    writeFileSync(lockOf(targetDir), "");
    const result = runRepair(targetDir, ["--execute", "--safe-only"], STOPPED);
    expect(result.stdout).toContain("execute action=start-services resolves=services-not-running result=done");
    expect(result.status).toBe(0);
    expect(composeUpCalls(result)).toHaveLength(1);
    expect(result.stateOf("orbit-db")).toBe("running");
  });

  it("no lock file at all does not block either (pins the ordinary case)", () => {
    const targetDir = makeFixture();
    const result = runRepair(targetDir, ["--execute", "--safe-only"], STOPPED);
    expect(result.stdout).toContain("execute action=start-services resolves=services-not-running result=done");
    expect(composeUpCalls(result)).toHaveLength(1);
  });
});
