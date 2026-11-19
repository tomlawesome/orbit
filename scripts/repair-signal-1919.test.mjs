import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, openSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PROCESS_DEADLINE_MS, PROCESS_TEST_TIMEOUT_MS } from "./process-budget.mjs";
import { makeFixture, prepareRepair, scratchDir } from "./repair-test-harness.mjs";

// #1919 (design ruling, note 65893): an interrupted repair must always remove its private recovery copy
// (.orbit-repair-recovery.*), however the signal arrives. A group-wide TERM reaches the worker twice (once from the
// group, once forwarded by the lock holder), and bash 5.2 dies at once on a second TERM that lands while its EXIT
// trap runs. The ruling: the worker traps TERM/HUP/INT (exit 128+signo, further signals ignored, also during
// cleanup); the holder keeps forwarding and says once, on the first signal, that the stop is in progress.
//
// The window: restore-transaction opens the recovery copy (the staging folder's .env-orbit differs from the live one,
// so the restore is not discarded as a no-op). A PATH shim for `mkdir` holds the worker in that window. Tests signal
// once a marker or the recovery folder shows the run is there, not after a delay. What a test cannot see is read from
// the exit status written by a wrapper shell, so 143/129/130 are the real statuses, not node's signal names.

vi.setConfig({ testTimeout: PROCESS_TEST_TIMEOUT_MS });

const STOP_LINE = "Orbit repair: stop requested; the step in progress finishes first, then this run stops and tidies up.";
const SIGNO = { SIGTERM: 143, SIGHUP: 129, SIGINT: 130 };
const groups = [];
afterEach(() => {
  while (groups.length > 0) {
    try {
      process.kill(-groups.pop(), "SIGKILL");
    } catch {
      // already gone
    }
  }
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check, what) {
  const deadline = Date.now() + PROCESS_DEADLINE_MS;
  for (;;) {
    const value = check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(10);
  }
}
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1][0] !== "Z";
  } catch {
    return false;
  }
};
const childrenOf = (pid) => {
  try {
    return readFileSync(`/proc/${pid}/task/${pid}/children`, "utf8").split(" ").filter(Boolean).map(Number);
  } catch {
    return [];
  }
};
const recoveryCopies = (targetDir) => readdirSync(targetDir).filter((name) => name.startsWith(".orbit-repair-recovery."));

/**
 * Starts `repair.sh --execute --safe-only` in its own process group, under a wrapper shell that records the run's
 * exit status. `windowSeconds`: how long the mkdir shim holds the worker after it made the recovery folder.
 * `rmSeconds`: how long the rm shim stretches the removal of the recovery folder (0: no stretch).
 * `ignoreWindow`: the mkdir shim ignores TERM/INT/HUP (a child that does not die of the group's signal).
 */
function startRun({ windowSeconds = 1, rmSeconds = 0, ignoreWindow = false } = {}) {
  const targetDir = makeFixture();
  const { merged } = prepareRepair(targetDir, { db: "stopped", app: "stopped" });
  const staging = join(targetDir, ".orbit-install-staging.AAAAAA");
  mkdirSync(join(staging, "rollback", "original"), { recursive: true, mode: 0o700 });
  writeFileSync(join(staging, "rollback", "original", ".env-orbit"), `${readFileSync(join(targetDir, ".env-orbit"), "utf8")}OLD_EXTRA=1\n`);
  const work = scratchDir("orbit-1919-");
  const shims = join(work, "shims");
  mkdirSync(shims);
  const marks = join(work, "marks");
  mkdirSync(marks);
  writeFileSync(
    join(shims, "mkdir"),
    `#!/usr/bin/env bash
/bin/mkdir "$@"; rc=$?
if [[ "$*" == *orbit-repair-recovery* ]]; then
  ${ignoreWindow ? "trap '' TERM INT HUP" : ""}
  : > '${marks}/window'
  sleep ${windowSeconds}
  : > '${marks}/window-over'
fi
exit "$rc"
`,
    { mode: 0o755 },
  );
  writeFileSync(
    join(shims, "rm"),
    `#!/usr/bin/env bash
if [[ "$*" == *orbit-repair-recovery* && ${rmSeconds} != 0 ]]; then
  : > '${marks}/rm-started'
  sleep ${rmSeconds}
fi
exec /bin/rm "$@"
`,
    { mode: 0o755 },
  );
  const wrapper = join(work, "wrapper.sh");
  // The wrapper survives the group's signals (a no-op trap) and writes the status repair.sh ended with.
  writeFileSync(wrapper, `trap : TERM INT HUP\nbash "$1" --execute --safe-only\necho $? > '${marks}/status'\n`);
  const outFile = join(work, "out");
  const inFile = join(work, "in");
  writeFileSync(inFile, "y\n");
  const out = openSync(outFile, "w");
  const run = spawn("bash", [wrapper, join(targetDir, "scripts", "repair.sh")], {
    cwd: targetDir,
    env: { ...merged, ORBIT_REPAIR_PROMPTS: "machine", PATH: `${shims}:${merged.PATH}` },
    stdio: [openSync(inFile, "r"), out, out],
    detached: true,
  });
  groups.push(run.pid);
  const closed = new Promise((resolve) => run.once("close", resolve));
  const mark = (name) => existsSync(join(marks, name));
  const status = () => (mark("status") ? Number(readFileSync(join(marks, "status"), "utf8")) : null);
  const output = () => readFileSync(outFile, "utf8");
  const probe = {
    holder: () => childrenOf(run.pid)[0],
    worker: () => {
      const holder = childrenOf(run.pid)[0];
      return holder === undefined ? undefined : childrenOf(holder)[0];
    },
  };
  const atWindow = async () => {
    await until(() => recoveryCopies(targetDir).length > 0 && mark("window"), "the run to open its recovery copy");
    // The processes the tests signal; the holder and its worker both exist by now.
    return { holder: probe.holder(), worker: probe.worker() };
  };
  // `flock -n` on the folder: exit 1 while a run (its lock holder) still holds the one-run-per-folder lock.
  const lockHeld = () => spawnSync("flock", ["-n", targetDir, "true"]).status === 1;
  return { run, closed, targetDir, mark, status, output, atWindow, lockHeld, pgid: run.pid };
}

const done = async (r) => {
  await r.closed;
  return r.status();
};

describe("#1919: a group signal in the recovery-copy window leaves no recovery copy", () => {
  for (const [signal, code] of Object.entries(SIGNO)) {
    it(`${signal} to the group: exit ${code}, the copy is gone, the run says it was interrupted`, async () => {
      const r = startRun();
      await r.atWindow();
      process.kill(-r.pgid, signal);
      expect(await done(r), "exit status of the interrupted run").toBe(code);
      expect(recoveryCopies(r.targetDir), "a private recovery copy was left behind").toEqual([]);
      expect(r.output()).toContain("interrupted before completion");
    });
  }

  // The race (a second TERM landing while the EXIT trap runs) has to be repeated to show itself: bounded at 20 runs.
  it("TERM to the group, 20 times in a row (the race is repeated, bounded): the copy is gone every time", async () => {
    const leftovers = [];
    for (let i = 0; i < 20; i += 1) {
      const r = startRun({ windowSeconds: 3 });
      await r.atWindow();
      process.kill(-r.pgid, "SIGTERM");
      const status = await done(r);
      if (status !== 143 || recoveryCopies(r.targetDir).length > 0) leftovers.push(`run ${i + 1}: status ${status}, copies ${recoveryCopies(r.targetDir).join(",") || "none"}`);
    }
    expect(leftovers, "runs that were interrupted by TERM and did not end cleanly").toEqual([]);
  });
});

describe("#1919: a signal to one process of the run", () => {
  it("TERM to the lock holder alone: exit 143 only once the worker is gone, the copy is gone", async () => {
    const r = startRun();
    const { holder, worker } = await r.atWindow();
    process.kill(holder, "SIGTERM");
    expect(await done(r)).toBe(143);
    expect(alive(worker), "the worker outlived the lock holder").toBe(false);
    expect(recoveryCopies(r.targetDir)).toEqual([]);
    expect(r.output()).toContain("interrupted before completion");
  });

  it("TERM to the worker alone: the holder exits 143, the copy is gone", async () => {
    const r = startRun();
    const { worker } = await r.atWindow();
    process.kill(worker, "SIGTERM");
    expect(await done(r)).toBe(143);
    expect(recoveryCopies(r.targetDir)).toEqual([]);
  });
});

describe("#1919: the holder says once that the stop was asked for", () => {
  it("TERM, TERM and HUP to the holder: exactly one stop line, exit 143, the copy is gone", async () => {
    const r = startRun({ windowSeconds: 2 });
    const { holder } = await r.atWindow();
    process.kill(holder, "SIGTERM");
    await until(() => r.output().includes(STOP_LINE) || r.status() !== null, "the holder's stop line or the end of the run");
    process.kill(holder, "SIGTERM");
    process.kill(holder, "SIGHUP");
    // With TERM and HUP both pending bash runs the lower-numbered HUP first, so the exit is 129 or 143.
    expect([129, 143], "exit status").toContain(await done(r));
    expect(r.output().split(STOP_LINE).length - 1, "the stop line is printed on the first signal only").toBe(1);
    expect(recoveryCopies(r.targetDir)).toEqual([]);
  });

  it("a group TERM also prints the line exactly once", async () => {
    const r = startRun();
    await r.atWindow();
    process.kill(-r.pgid, "SIGTERM");
    await done(r);
    expect(r.output().split(STOP_LINE).length - 1).toBe(1);
  });
});

describe("#1919: repeated signals while the worker cleans up", () => {
  it("TERM, then TERM, INT and HUP while the removal of the copy is under way: the copy is gone when the run ends", async () => {
    const r = startRun({ windowSeconds: 1, rmSeconds: 2 });
    const { worker } = await r.atWindow();
    process.kill(worker, "SIGTERM");
    await until(() => r.mark("rm-started"), "the worker to start removing the copy");
    for (const signal of ["SIGTERM", "SIGINT", "SIGHUP", "SIGTERM"]) {
      try {
        process.kill(worker, signal);
      } catch {
        // a worker that is already gone: the checks below say what that cost
      }
    }
    expect(await done(r), "exit status").toBe(143);
    expect(recoveryCopies(r.targetDir), "the copy was still there when the run ended").toEqual([]);
    expect(r.output()).toContain("now removed");
  });
});

describe("#1919: a child that ignores the signal", () => {
  it("group TERM while the step's child ignores it: the lock is held, and the worker waits, until that child ends", async () => {
    const r = startRun({ windowSeconds: 2, ignoreWindow: true });
    const { worker } = await r.atWindow();
    expect(r.lockHeld(), "the folder lock is not held before the signal").toBe(true);
    process.kill(-r.pgid, "SIGTERM");
    const freeEarly = [];
    while (!r.mark("window-over")) {
      if (!r.lockHeld() && !r.mark("window-over")) freeEarly.push("lock free");
      if (!alive(worker) && !r.mark("window-over")) freeEarly.push("worker gone");
      await sleep(25);
    }
    expect(freeEarly, "the run let go before the step it was in had ended").toEqual([]);
    expect(await done(r)).toBe(143);
    expect(recoveryCopies(r.targetDir)).toEqual([]);
  });
});

describe("#1919: a run nobody signals", () => {
  it("exits 0 and removes its copy, with no stop line", async () => {
    const r = startRun({ windowSeconds: 0 });
    expect(await done(r), r.output().slice(-800)).toBe(0);
    expect(recoveryCopies(r.targetDir)).toEqual([]);
    expect(r.output()).not.toContain(STOP_LINE);
    expect(r.output()).not.toContain("interrupted before completion");
  });
});
