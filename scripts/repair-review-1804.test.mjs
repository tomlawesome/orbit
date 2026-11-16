import { spawn, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { PROCESS_TEST_TIMEOUT_MS } from "./process-budget.mjs";
import { composeUpCalls, makeFixture, runRepair, runRepairBetweenPlanAndExecute, scratchDir } from "./repair-test-harness.mjs";

// The inline review findings of 8dbebcb0, as recorded on #1804 (points 1-5, 7,
// 8, 9 and the flock-missing case). Points 6 and 10 are docs and a comment.
// Point 8 is observed through a `timeout` shim that logs its arguments.

vi.setConfig({ testTimeout: PROCESS_TEST_TIMEOUT_MS });

const STOPPED = { db: "stopped", app: "stopped" };
const lockOf = (dir) => join(dir, "backups", ".orbit-backup-restore.lock");
const MANUAL_STEP_FOR_SERVICES = /manual step: .*\(resolves=services-not-running\)/u;

function movedLabels() {
  const scratch = scratchDir();
  const path = join(scratch, "labels");
  writeFileSync(path, `${join(scratch, "old-orbit-folder")}\n`);
  return { workingDirLabelsPath: path };
}

describe("#1804 review 1: a backups folder repair cannot search", () => {
  it("counts as restore-unfinished, with guidance saying repair can't tell", () => {
    const targetDir = makeFixture();
    const backups = join(targetDir, "backups");
    mkdirSync(backups);
    chmodSync(backups, 0o000);
    try {
      expect(runRepair(targetDir, ["--check"], STOPPED).stdout).toContain(
        "finding class=restore-unfinished target=restore severity=warn",
      );
      const plan = runRepair(targetDir, ["--plan"], STOPPED);
      expect(plan.stdout).not.toContain("plan action=start-services");
      expect(plan.stderr).toContain(
        "repair can't tell whether a restore is unfinished, because the backups folder can't be searched",
      );
    } finally {
      chmodSync(backups, 0o700);
    }
  });

  it("at execution the lock check refuses too, naming the folder", async () => {
    const targetDir = makeFixture();
    const backups = join(targetDir, "backups");
    mkdirSync(backups);
    try {
      const result = await runRepairBetweenPlanAndExecute(targetDir, ["--execute", "--safe-only"], STOPPED, () => chmodSync(backups, 0o000));
      expect(result.stdout).toContain("execute action=start-services resolves=services-not-running result=failed");
      expect(result.status).toBe(4);
      expect(composeUpCalls(result)).toEqual([]);
      expect(result.stderr).toContain(`repair can't check whether a backup, restore or export is running: ${backups} can't be searched.`);
    } finally {
      chmodSync(backups, 0o700);
    }
  });
});

describe("#1804 review 2 and 3: the restarting probe", () => {
  it("a failed restarting probe leaves the service unknown: no finding, no start planned", () => {
    const targetDir = makeFixture();
    const state = { db: "stopped", app: "running", restartingProbeFails: true };
    const check = runRepair(targetDir, ["--check"], state);
    expect(check.stdout).not.toContain("class=services-not-running");
    expect(check.stdout).not.toContain("class=service-restarting");
    const executed = runRepair(targetDir, ["--execute", "--safe-only"], state);
    expect(executed.stdout).not.toContain("start-services");
    expect(composeUpCalls(executed)).toEqual([]);
  });

  it("several container ids from the restarting probe still mean restarting", () => {
    const targetDir = makeFixture();
    const state = { db: "running", app: "restarting", multiRestarting: true };
    const check = runRepair(targetDir, ["--check"], state);
    expect(check.stdout).toContain("finding class=service-restarting target=container severity=fail");
    expect(check.stdout).not.toContain("class=services-not-running");
  });
});

describe("#1804 review 4: a volume list that fails", () => {
  it("still raises database-volume-missing, with guidance that says repair could not list the volumes", () => {
    const targetDir = makeFixture();
    const state = { db: "absent", app: "absent", docker: { volumeLsFailFilter: "orbit-db-data" } };
    expect(runRepair(targetDir, ["--check"], state).stdout).toContain("finding class=database-volume-missing target=database severity=fail");
    const plan = runRepair(targetDir, ["--plan"], state);
    expect(plan.stdout).not.toContain("plan action=start-services");
    expect(plan.stderr).toContain(
      "repair could not list Docker's volumes, so it can't tell whether the database's data is there; check with docker volume ls, then re-run repair",
    );
    expect(plan.stderr).not.toContain("data is missing");
  });

  it("a list that worked and has no volume keeps the data-is-missing guidance", () => {
    const targetDir = makeFixture();
    const plan = runRepair(targetDir, ["--plan"], { db: "absent", app: "absent" });
    expect(plan.stderr).toContain("data is missing");
    expect(plan.stderr).not.toContain("could not list Docker's volumes");
  });
});

describe("#1804 review 5: a lock file that is not a plain readable file", () => {
  function expectRefusedUnread(targetDir, result) {
    expect(result.stdout).toContain("execute action=start-services resolves=services-not-running result=failed");
    expect(result.status).toBe(4);
    expect(composeUpCalls(result)).toEqual([]);
    expect(result.stderr).toContain(
      `repair can't check whether a backup, restore or export is running: the lock at ${lockOf(targetDir)} can't be read.`,
    );
    expect(result.stderr).not.toContain("running right now");
  }

  it("a FIFO is refused without being opened", () => {
    const targetDir = makeFixture();
    mkdirSync(join(targetDir, "backups"));
    expect(spawnSync("mkfifo", [lockOf(targetDir)]).status).toBe(0);
    expectRefusedUnread(targetDir, runRepair(targetDir, ["--execute", "--safe-only"], STOPPED));
  });

  it("a symlink to a regular file is refused", () => {
    const targetDir = makeFixture();
    mkdirSync(join(targetDir, "backups"));
    const real = join(scratchDir(), "real.lock");
    writeFileSync(real, "");
    symlinkSync(real, lockOf(targetDir));
    expectRefusedUnread(targetDir, runRepair(targetDir, ["--execute", "--safe-only"], STOPPED));
  });

  it("an unreadable lock file is refused", () => {
    const targetDir = makeFixture();
    mkdirSync(join(targetDir, "backups"));
    writeFileSync(lockOf(targetDir), "");
    chmodSync(lockOf(targetDir), 0o000);
    expectRefusedUnread(targetDir, runRepair(targetDir, ["--execute", "--safe-only"], STOPPED));
  });

  it("a directory at the lock path is refused", () => {
    const targetDir = makeFixture();
    mkdirSync(lockOf(targetDir), { recursive: true });
    expectRefusedUnread(targetDir, runRepair(targetDir, ["--execute", "--safe-only"], STOPPED));
  });
});

describe("#1804 review 7: --execute prints the manual-step guidance", () => {
  // A fix-permissions action plus a manual services-not-running entry.
  function mixed() {
    const targetDir = makeFixture();
    chmodSync(join(targetDir, ".orbit-secrets", "postgres-password"), 0o644);
    return targetDir;
  }

  it("in the declined branch", () => {
    const result = runRepair(mixed(), ["--execute", "--safe-only"], { ...STOPPED, env: { ORBIT_REPAIR_PROMPTS: "machine" }, input: "n\n" });
    expect(result.stdout).toContain("execution result=declined");
    expect(result.stderr).toMatch(MANUAL_STEP_FOR_SERVICES);
  });

  it("in the skipped branch", () => {
    const result = runRepair(mixed(), ["--execute", "--safe-only"], STOPPED);
    expect(result.stdout).toContain("execute action=manual resolves=services-not-running result=skipped");
    expect(result.stderr).toMatch(MANUAL_STEP_FOR_SERVICES);
  });
});

describe("#1804 review 8: a hung recreate is bounded like start-services", () => {
  it("recreate-services' compose call runs under timeout with --kill-after", () => {
    const targetDir = makeFixture();
    const result = runRepair(targetDir, ["--execute", "--safe-only"], { db: "running", app: "running", docker: movedLabels() });
    expect(result.stdout).toContain("execute action=recreate-services resolves=folder-moved result=done");
    const upCalls = result.timeoutCalls.filter((line) => /\bdocker compose\b.*\bup\b/u.test(line));
    expect(upCalls).toHaveLength(1);
    expect(upCalls[0]).toMatch(/--kill-after=\S+/u);
  });

  it("(pin) start-services' compose call has it", () => {
    const targetDir = makeFixture();
    const result = runRepair(targetDir, ["--execute", "--safe-only"], STOPPED);
    const upCalls = result.timeoutCalls.filter((line) => /\bdocker compose\b.*\bup\b/u.test(line));
    expect(upCalls).toHaveLength(1);
    expect(upCalls[0]).toMatch(/--kill-after=\S+/u);
  });
});

describe("#1804 review 9: who holds the lock", () => {
  it("the refusal names backup, restore and export", async () => {
    const targetDir = makeFixture();
    mkdirSync(join(targetDir, "backups"));
    const holder = spawn("flock", ["-x", lockOf(targetDir), "sleep", "60"], { stdio: "ignore" });
    const deadline = Date.now() + 10_000;
    while (spawnSync("flock", ["-n", lockOf(targetDir), "true"]).status === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    try {
      const result = runRepair(targetDir, ["--execute", "--safe-only"], STOPPED);
      expect(result.status).toBe(4);
      expect(result.stderr).toContain("a backup, restore or export is running right now; wait for it to end, then re-run repair.");
    } finally {
      holder.kill("SIGKILL");
    }
  });
});

// A PATH holding every tool the test process can see, minus flock.
function pathWithoutFlock() {
  const dir = scratchDir("orbit-noflock-");
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

describe("#1804: flock not on PATH", () => {
  it("the lock check is skipped: a held lock does not stop the start", async () => {
    const targetDir = makeFixture();
    mkdirSync(join(targetDir, "backups"));
    const holder = spawn("flock", ["-x", lockOf(targetDir), "sleep", "60"], { stdio: "ignore" });
    const deadline = Date.now() + 10_000;
    while (spawnSync("flock", ["-n", lockOf(targetDir), "true"]).status === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    try {
      const noFlock = pathWithoutFlock();
      expect(spawnSync("bash", ["-c", "command -v flock"], { env: { PATH: noFlock } }).status).not.toBe(0);
      const result = runRepair(targetDir, ["--execute", "--safe-only"], { ...STOPPED, env: { PATH: noFlock } });
      expect(result.stdout).toContain("execute action=start-services resolves=services-not-running result=done");
      expect(composeUpCalls(result)).toHaveLength(1);
    } finally {
      holder.kill("SIGKILL");
    }
  });

  it("the journal check still runs at execution", async () => {
    const targetDir = makeFixture();
    const result = await runRepairBetweenPlanAndExecute(
      targetDir,
      ["--execute", "--safe-only"],
      { ...STOPPED, env: { PATH: pathWithoutFlock() } },
      () => {
        mkdirSync(join(targetDir, "backups", ".orbit-restore"), { recursive: true });
        writeFileSync(join(targetDir, "backups", ".orbit-restore", "restore.journal"), "{}\n");
      },
    );
    expect(result.stdout).toContain("execute action=start-services resolves=services-not-running result=failed");
    expect(result.status).toBe(4);
    expect(composeUpCalls(result)).toEqual([]);
  });
});
