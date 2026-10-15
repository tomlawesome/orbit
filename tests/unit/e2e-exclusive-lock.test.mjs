import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { holderOf, release, tryAcquire } from "../e2e/support/exclusive-lock.ts";

/*
 * F2 (#1316): the advisory lock that keeps the two archive-slot spec files to
 * one Playwright worker at a time. `mkdir` is the atomic test-and-set; the
 * owner's pid and start time sit inside (`owner.json`) so a crashed worker's
 * lock can be taken over: its pid is gone, or it is older than `staleMs`.
 */

const STALE_MS = 10 * 60 * 1000;
const DEAD_PID = 999999;

/** @type {string} */
let parent;
/** @type {string} */
let path;

beforeEach(() => {
  parent = mkdtempSync(join(tmpdir(), "orbit-exclusive-lock-test-"));
  path = join(parent, "lock");
});
afterEach(() => {
  rmSync(parent, { recursive: true, force: true });
});

/** Leave a lock behind as another worker would have: the directory and its owner file. */
const leaveLock = (owner) => {
  mkdirSync(path);
  writeFileSync(join(path, "owner.json"), typeof owner === "string" ? owner : JSON.stringify(owner));
};
/** `holderOf` may answer with the pid itself or with the owner record. */
const pidOf = (holder) => (holder !== null && typeof holder === "object" ? holder.pid : holder);

describe("the exclusive lock", () => {
  it("is taken once, refused to a second pid while held, and free again after release", () => {
    expect(tryAcquire(path, { pid: process.pid, staleMs: STALE_MS })).toBe(true);
    expect(pidOf(holderOf(path))).toBe(process.pid);

    expect(tryAcquire(path, { pid: process.pid + 1, staleMs: STALE_MS })).toBe(false);
    expect(pidOf(holderOf(path))).toBe(process.pid);

    release(path);
    expect(existsSync(path)).toBe(false);
    expect(tryAcquire(path, { pid: process.pid + 1, staleMs: STALE_MS })).toBe(true);
  });

  it("is taken over from a holder whose process is gone, even with a fresh start time", () => {
    leaveLock({ pid: DEAD_PID, since: Date.now() });
    expect(tryAcquire(path, { pid: process.pid, staleMs: STALE_MS })).toBe(true);
    expect(pidOf(holderOf(path))).toBe(process.pid);
  });

  it("is taken over from a live holder once its lock is older than staleMs", () => {
    leaveLock({ pid: process.pid, since: Date.now() - 2 * STALE_MS });
    expect(tryAcquire(path, { pid: process.pid, staleMs: STALE_MS })).toBe(true);
    expect(pidOf(holderOf(path))).toBe(process.pid);
  });

  it("stays with a live, fresh holder, and a waiter's release does not remove it", () => {
    leaveLock({ pid: process.pid, since: Date.now() });
    expect(tryAcquire(path, { pid: process.pid + 1, staleMs: STALE_MS })).toBe(false);
    expect(existsSync(path)).toBe(true);

    // release only removes a lock whose pid is the caller's: held by the parent process, this one is the waiter
    rmSync(path, { recursive: true, force: true });
    leaveLock({ pid: process.ppid, since: Date.now() });
    release(path);
    expect(existsSync(path)).toBe(true);
    expect(pidOf(holderOf(path))).toBe(process.ppid);
  });

  it("counts a corrupt (empty) owner.json as stale", () => {
    leaveLock("");
    expect(tryAcquire(path, { pid: process.pid, staleMs: STALE_MS })).toBe(true);
    expect(pidOf(holderOf(path))).toBe(process.pid);
  });
});
