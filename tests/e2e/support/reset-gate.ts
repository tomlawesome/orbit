import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * #1080: the moment at which putting the whole database back to its seed is
 * provably safe, once more than one Playwright worker is live.
 *
 * THE COLLISION THIS RESOLVES. #1077 restores `public` from a seed schema
 * between spec files, and its own comment says why that was safe: the suite
 * ran on one worker, so nothing else held rows the restore could pull away.
 * #1080 removes the one-worker pin. A restore is global -- it truncates every
 * table -- so a worker starting its file would delete the households, items
 * and sessions another worker is mid-test with. There are exactly two ways
 * out of that: scope the restore to the rows one worker owns, or run the
 * global restore only when no worker is inside a test.
 *
 * SCOPING WAS REJECTED, and it is worth recording why rather than leaving it
 * to be rediscovered. The schema has 46 tables and 66 foreign keys, of which
 * 21 are `on delete set null` -- so "delete this worker's accounts and let the
 * cascades take the rest" leaves rows behind (audit_log is one), and the rows
 * it leaves are precisely the ones that lengthen lists. Nothing in the schema
 * records which worker made a row: `auditColumns` is created/updated
 * timestamps only, and src/db/schema.ts has no creator column. So a scoped
 * reset would need an ownership rule per table, maintained by hand as the
 * schema grows, failing SILENTLY when a new table is missed. That is the
 * discipline-instead-of-guarantee trap #1077 was written to avoid, one level
 * down. The global restore stays; what changes is when it may run.
 *
 * THE GATE. Every worker announces itself for the length of a spec file. A
 * worker that finds the database has grown past its budget asks for a reset;
 * the ask blocks new workers from starting a file, the workers already inside
 * one finish it, and the first worker to find itself alone performs the
 * single restore and releases everybody together. Workers that were waiting
 * then start their files as a cohort against one clean database.
 *
 * WHY A BUDGET RATHER THAN A RESET AT EVERY FILE. A reset at every file
 * boundary would mean a full drain at every file boundary: each worker would
 * wait for the slowest file still running before it could start its next one,
 * and the suite would spend most of its parallelism queueing. The budget is
 * the invariant #1077 was actually defending -- `tabTo`'s 60-press cap is
 * exhausted by a list that grew, so bound the lists -- stated directly
 * instead of implied by "reset every time". Between resets the parallelism is
 * unrestricted, and the drains happen a handful of times a run.
 *
 * ONE WORKER IS UNCHANGED. With `workers: 1` the gate is transparent: the
 * worker is always alone, so it always resets, which is #1077 exactly. The
 * local-only profile and every `--spec` run keep that behaviour.
 *
 * WHAT A RESET STILL CANNOT DO is unshare the instance. Two workers running
 * at once are two readers of one administration roster, so a spec that walks
 * that roster sees the accounts the other worker is making. The budget bounds
 * that -- it is a bound on the instance, not on one worker -- and it is a
 * reason to keep the worker count modest rather than as high as the host
 * would allow.
 */

/** A worker is inside a spec file, or in the file's teardown afterwards. */
type Phase = "running" | "tearing-down";

type Attendance = { pid: number; phase: Phase; since: number };

type Gate = {
  /** Keyed by parallel index, the same key worker identities use (#1080). */
  attending: Record<string, Attendance>;
  /** Set by a worker that found the database over budget; cleared by the reset. */
  resetWanted: string | null;
};

const EMPTY: Gate = { attending: {}, resetWanted: null };

/**
 * A worker in `tearing-down` still blocks a reset, because a spec's own
 * `afterAll` cleanup runs there -- #730's household sweep needs its session to
 * still work, and a restore would take it away. Playwright runs a file's
 * `afterAll` hooks in declaration order, and this module's is declared first
 * (the call sits at the top of each spec file), so this state is what stands
 * in for "the file's real teardown is still going".
 *
 * It is cleared the moment that worker starts its next file, which is the
 * normal case and costs nobody anything. The expiry below only matters for a
 * worker that has run its LAST file: Playwright keeps such a worker's process
 * alive until the whole run ends rather than stopping it (runner/index.js
 * `_runJobInWorker` reuses the slot), so without an expiry the final resets
 * of a run would wait forever.
 */
const TEARDOWN_EXPIRY_MS = 10_000;

/** A crashed worker's `running` entry, kept long enough to outlast the
 *  slowest test the suite declares (v19-mail-collection's 180s) and no
 *  longer. A dead pid is pruned immediately regardless. */
const RUNNING_EXPIRY_MS = 300_000;

/** How long to hold the state file's lock directory before assuming the
 *  holder died mid-update. Every critical section here is a few file reads. */
const LOCK_EXPIRY_MS = 15_000;

const POLL_MS = 150;

/**
 * How long a worker may legitimately wait at the gate, and what the hook that
 * waits has to be given to do it in.
 *
 * A wait lasts until the longest spec FILE still running has finished, and
 * files here are not short: v19-arrival and v19-mail-collection each declare
 * 180s for a single test, and a file holds several. Waits of fifty seconds
 * were measured at four workers, and the first version of this gate waited
 * inside Playwright's ordinary 60s hook budget and failed four spec files
 * that way -- the wait is not the spec's own time and must not be charged to
 * it.
 *
 * So the hook that waits is given a budget of its own, and the gate gives up
 * inside it with a message that says what it was waiting for. The give-up is
 * a backstop for a gate that has gone wrong, not a tuning knob: a run that
 * reaches it is broken, and would otherwise hang until the job's timeout with
 * nothing in the log. Progress is reported while waiting so a long run is
 * never silent.
 */
const GIVE_UP_MS = 600_000;
export const GATE_HOOK_TIMEOUT_MS = GIVE_UP_MS + 60_000;
const STILL_WAITING_MS = 30_000;

/**
 * One gate per stack, so two acceptance stacks on the same host never share
 * one. `COMPOSE_PROJECT_NAME` is what scripts/test-e2e-local.sh exports and
 * is unset in CI, where there is one stack per job anyway.
 *
 * In the system temp directory rather than in `test-results/`: Playwright
 * empties its `outputDir` at the start of a run and collects it as the job's
 * artifact, and this is neither a result nor something to publish.
 */
function gatePath(suffix: string): string {
  const stack = process.env.COMPOSE_PROJECT_NAME ?? "orbit-acceptance";
  return join(tmpdir(), `orbit-e2e-reset-gate-${stack}${suffix}`);
}

function readGate(): Gate {
  try {
    return { ...EMPTY, ...(JSON.parse(readFileSync(gatePath(".json"), "utf8")) as Gate) };
  } catch {
    /* Absent on the first worker through, and unreadable only if a previous
       run died mid-write; either way an empty gate is the right start. */
    return { ...EMPTY };
  }
}

function writeGate(gate: Gate): void {
  writeFileSync(gatePath(".json"), JSON.stringify(gate), "utf8");
}

function alive(pid: number): boolean {
  try {
    /* Signal 0 asks the kernel whether the process exists without touching
       it. These are always our own Playwright workers on this host. */
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Drops entries whose worker is gone, and teardowns that have outlived their
 *  window. Every read of the gate goes through this, so no single caller has
 *  to remember it. */
function prune(gate: Gate): Gate {
  const now = Date.now();
  for (const [key, entry] of Object.entries(gate.attending)) {
    const expiry = entry.phase === "tearing-down" ? TEARDOWN_EXPIRY_MS : RUNNING_EXPIRY_MS;
    if (!alive(entry.pid) || now - entry.since > expiry) delete gate.attending[key];
  }
  return gate;
}

/**
 * `mkdir` is the lock: the filesystem makes it atomic, and it fails rather
 * than succeeding twice. A lock older than LOCK_EXPIRY_MS is broken, because
 * the only way to hold one that long is to have died holding it.
 */
function withGate<T>(change: (gate: Gate) => T): T {
  const lock = gatePath(".lock");
  for (;;) {
    try {
      mkdirSync(lock);
      break;
    } catch {
      let age = 0;
      try {
        age = Date.now() - Number(readFileSync(join(lock, "since"), "utf8"));
      } catch {
        /* The holder has not written its stamp yet, or has just released. */
      }
      if (age > LOCK_EXPIRY_MS) rmSync(lock, { recursive: true, force: true });
      pause(20);
    }
  }
  try {
    writeFileSync(join(lock, "since"), String(Date.now()), "utf8");
    const gate = prune(readGate());
    const answer = change(gate);
    writeGate(gate);
    return answer;
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
}

/**
 * A synchronous pause, used only inside the lock-acquisition loop, which
 * cannot be asynchronous without letting a second hook interleave with it.
 * `Atomics.wait` parks the thread on a value that never changes, so it costs
 * nothing while it waits; `setTimeout` would need an await and a spawned
 * process would cost more than the pause.
 */
function pause(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.max(1, Math.round(ms)));
}

function me(): string {
  return process.env.TEST_PARALLEL_INDEX ?? "0";
}

/**
 * Called from the first `beforeAll` of every spec file. Returns once this
 * worker may start the file, having reset the database first if one was due.
 *
 * `overBudget` returns a sentence naming what has grown when a reset is due
 * and null when it is not; it is asked outside the gate's lock, because it is
 * a round trip to the database and holding a lock across it would serialise
 * the workers on the probe rather than on the reset.
 */
export async function enterSpecFile(options: {
  workers: number;
  overBudget: () => string | null;
  reset: () => void;
}): Promise<void> {
  const worker = me();

  /* One worker is always alone, so skip the probe entirely and reset every
     file: #1077 unchanged, and no gate file written at all. */
  if (options.workers <= 1) {
    options.reset();
    return;
  }

  /* Asked once, not once per poll: it is a round trip to the database, and
     the answer cannot become "no" while this worker waits -- only a reset
     makes it no, and a reset is what it is waiting for. */
  let due: string | null = options.overBudget();

  const waitingSince = Date.now();
  let waited = false;
  let announced = 0;
  for (;;) {
    const verdict = withGate((gate) => {
      /* Leaving my own previous file's teardown behind is the first thing I
         do, so a worker moving from one file to the next never blocks the
         reset it is itself waiting for. */
      delete gate.attending[worker];
      if (due && !gate.resetWanted) gate.resetWanted = due;
      due = null;

      if (!gate.resetWanted) {
        gate.attending[worker] = { pid: process.pid, phase: "running", since: Date.now() };
        return "go" as const;
      }
      if (Object.keys(gate.attending).length > 0) return "wait" as const;

      /* Alone, with a reset outstanding. Claim the file before releasing the
         lock so nobody slips in behind the restore, then do it. */
      gate.attending[worker] = { pid: process.pid, phase: "running", since: Date.now() };
      return "reset" as const;
    });

    if (verdict === "wait") {
      waited = true;
      const waiting = Date.now() - waitingSince;
      if (waiting > GIVE_UP_MS) {
        throw new Error(
          `#1080: still waiting at the reset gate after ${Math.round(waiting / 1000)}s. `
          + `${JSON.stringify(withGate((gate) => gate.attending))} is still inside a spec file.`,
        );
      }
      if (waiting - announced > STILL_WAITING_MS) {
        announced = waiting;
        console.log(`#1080: ${Math.round(waiting / 1000)}s at the reset gate, waiting for the other workers' files to end`);
      }
      await new Promise((resume) => setTimeout(resume, POLL_MS));
      continue;
    }
    if (verdict === "reset") {
      const reason = withGate((gate) => gate.resetWanted);
      console.log(`#1080: resetting for the cohort -- ${reason ?? "a reset was asked for"}`);
      /* The ask is cleared only once the restore has actually finished.
         Clearing it first would let a waiting worker start its file against a
         database that is halfway through being truncated. If the restore
         throws, the ask stands: this worker's file fails loudly, and the next
         worker to find itself alone tries the same restore and fails the same
         way, rather than the run carrying on over a half-reset database. */
      options.reset();
      withGate((gate) => {
        gate.resetWanted = null;
      });
    }
    if (waited) {
      console.log(`#1080: waited ${Date.now() - waitingSince}ms at the reset gate`);
    }
    return;
  }
}

/**
 * Called from the last thing this module registers for a spec file. The
 * worker stays visible to the gate as `tearing-down`, because the spec's own
 * cleanup still has to run and still needs its session.
 */
export function leaveSpecFile(): void {
  const worker = me();
  withGate((gate) => {
    if (gate.attending[worker]) {
      gate.attending[worker] = { pid: process.pid, phase: "tearing-down", since: Date.now() };
    }
  });
}
