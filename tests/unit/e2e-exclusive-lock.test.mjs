import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { OWNER_GRACE_MS, holderOf, release, renew, tryAcquire } from "../e2e/support/exclusive-lock.ts";

/*
 * F2 (#1316): the advisory lock that keeps the two archive-slot spec files to
 * one Playwright worker at a time. `mkdir` is the atomic test-and-set; the
 * owner's pid and start time sit inside (`owner.json`) so a crashed worker's
 * lock can be taken over: its pid is gone, or it is older than `staleMs`.
 * A lock directory with no readable owner record is held until its directory
 * is older than OWNER_GRACE_MS (the holder may still be writing it), and a
 * holder keeps its lock alive with `renew`.
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
/** Age the lock directory's mtime as if it had been created `ms` ago. */
const ageDir = (ms) => {
  const then = new Date(Date.now() - ms);
  utimesSync(path, then, then);
};
const ownerSince = () => JSON.parse(readFileSync(join(path, "owner.json"), "utf8")).since;
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

  it("exports a 5 s grace period for an owner record still being written", () => {
    expect(OWNER_GRACE_MS).toBe(5000);
  });

  it("holds a lock whose empty owner.json sits in a directory younger than the grace period", () => {
    leaveLock("");
    expect(tryAcquire(path, { pid: process.pid + 1, staleMs: STALE_MS })).toBe(false);
    expect(existsSync(path)).toBe(true);
  });

  it("takes over a lock whose empty owner.json sits in a directory older than the grace period", () => {
    leaveLock("");
    ageDir(10_000);
    expect(tryAcquire(path, { pid: process.pid + 1, staleMs: STALE_MS })).toBe(true);
    expect(pidOf(holderOf(path))).toBe(process.pid + 1);
  });

  it("holds a fresh lock directory with no owner.json, and takes over an aged one", () => {
    mkdirSync(path);
    expect(tryAcquire(path, { pid: process.pid + 1, staleMs: STALE_MS })).toBe(false);
    expect(existsSync(path)).toBe(true);

    ageDir(10_000);
    expect(tryAcquire(path, { pid: process.pid + 1, staleMs: STALE_MS })).toBe(true);
    expect(pidOf(holderOf(path))).toBe(process.pid + 1);
  });

  it("writes owner.json atomically: only the finished record is left in the lock directory", () => {
    expect(tryAcquire(path, { pid: process.pid, staleMs: STALE_MS })).toBe(true);
    expect(readdirSync(path)).toEqual(["owner.json"]);
    expect(ownerSince()).toEqual(expect.any(Number));
  });

  it("takes over a stale lock whose directory has vanished, without throwing", () => {
    leaveLock({ pid: DEAD_PID, since: Date.now() });
    rmSync(path, { recursive: true, force: true });
    let result;
    expect(() => {
      result = tryAcquire(path, { pid: process.pid, staleMs: STALE_MS });
    }).not.toThrow();
    expect(result).toBe(true);
    expect(pidOf(holderOf(path))).toBe(process.pid);
  });

  it("renew by the holder rewrites since to the given time", () => {
    const start = Date.now() - 1000;
    expect(tryAcquire(path, { pid: process.pid, now: start, staleMs: STALE_MS })).toBe(true);
    expect(ownerSince()).toBe(start);

    const later = start + 500;
    expect(renew(path, { pid: process.pid, now: later })).toBe(true);
    expect(ownerSince()).toBe(later);
    expect(pidOf(holderOf(path))).toBe(process.pid);
  });

  it("measures age from the last renew: a lock aged past staleMs and then renewed is not stale", () => {
    leaveLock({ pid: process.pid, since: Date.now() - 2 * STALE_MS });
    const now = Date.now();
    expect(renew(path, { pid: process.pid, now })).toBe(true);
    expect(tryAcquire(path, { pid: process.pid + 1, now, staleMs: STALE_MS })).toBe(false);
    expect(pidOf(holderOf(path))).toBe(process.pid);
  });

  it("renew by another pid does nothing and returns false", () => {
    const since = Date.now() - 1000;
    leaveLock({ pid: process.pid, since });
    expect(renew(path, { pid: process.pid + 1, now: since + 500 })).toBe(false);
    expect(ownerSince()).toBe(since);
    expect(pidOf(holderOf(path))).toBe(process.pid);
  });
});
