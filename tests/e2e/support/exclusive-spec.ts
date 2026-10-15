import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "@playwright/test";
import { holderOf, release, renew, tryAcquire } from "./exclusive-lock";
import { GATE_HOOK_TIMEOUT_MS, stackKey, stillInsideSpecFile } from "./reset-gate";

const RETRY_MS = 250;
const STILL_WAITING_MS = 30_000;
const STALE_MS = 600_000;
/** Longer than STALE_MS so the loud give-up can fire: a lock nobody renews is
 *  taken over at STALE_MS, and a waiter still stuck after that is a real fault. */
const GIVE_UP_MS = 900_000;

/**
 * #1316: the spec files that call this with the same name run one at a time
 * across Playwright workers, whichever project they belong to. A lock file in
 * the system temp directory is held from the file's `beforeAll` to its
 * `afterAll`; a crashed worker's lock is taken over by exclusive-lock.ts's
 * stale rule.
 *
 * Call it immediately after `resetDatabaseBetweenSpecFiles()`: Playwright runs
 * `beforeAll` hooks in declaration order, and the reset gate's must already be
 * registered. With one worker there is nothing to take turns with.
 */
export function exclusiveSpecFile(name: string): void {
  const lockPath = join(tmpdir(), `orbit-e2e-exclusive-${stackKey()}-${name}`);
  let held = false;

  test.beforeAll(async () => {
    if (test.info().config.workers <= 1) return;
    test.setTimeout(GATE_HOOK_TIMEOUT_MS);

    const started = Date.now();
    let announced = 0;
    while (!tryAcquire(lockPath, { pid: process.pid, staleMs: STALE_MS })) {
      const waiting = Date.now() - started;
      const holder = holderOf(lockPath);
      if (waiting > GIVE_UP_MS) {
        throw new Error(
          `#1316: still waiting for the ${name} lock after ${Math.round(waiting / 1000)}s, held by pid ${holder ?? "unknown"}`,
        );
      }
      if (waiting - announced > STILL_WAITING_MS) {
        announced = waiting;
        /* The reset gate treats a worker silent for its running expiry as dead. */
        stillInsideSpecFile();
        console.log(`#1316: still waiting for the ${name} lock held by pid ${holder ?? "unknown"}`);
      }
      await new Promise((resume) => setTimeout(resume, RETRY_MS));
    }
    held = true;
  });

  /* A live holder renews before every test, so a long file never ages out. */
  test.beforeEach(() => {
    if (!held || test.info().config.workers <= 1) return;
    renew(lockPath, { pid: process.pid });
  });

  test.afterAll(() => {
    if (test.info().config.workers <= 1) return;
    held = false;
    release(lockPath);
  });
}
