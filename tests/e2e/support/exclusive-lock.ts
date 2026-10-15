import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * #1316: an advisory lock held for the length of a spec file, so two spec
 * files that must not overlap never run on two workers at once. The same
 * shape as reset-gate.ts's gate: `mkdir` is the atomic test-and-set, and the
 * owner's pid and start time sit inside for a stale takeover.
 */

type Owner = { pid: number; since: number };

const OWNER_FILE = "owner.json";

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readOwner(path: string): Owner | null {
  try {
    const owner = JSON.parse(readFileSync(join(path, OWNER_FILE), "utf8")) as Partial<Owner> | null;
    if (typeof owner?.pid === "number" && typeof owner.since === "number") {
      return { pid: owner.pid, since: owner.since };
    }
  } catch {
    /* Absent, empty or half-written: no usable owner. */
  }
  return null;
}

/** A lock with no readable owner counts as stale: its holder died between
 *  `mkdir` and writing the record, or the record is corrupt. */
function stale(owner: Owner | null, now: number, staleMs: number): boolean {
  return owner === null || !alive(owner.pid) || now - owner.since > staleMs;
}

export function tryAcquire(
  path: string,
  options: { pid: number; now?: number; staleMs?: number },
): boolean {
  const { pid, now = Date.now(), staleMs = 600_000 } = options;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      mkdirSync(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (!stale(readOwner(path), now, staleMs)) return false;
      rmSync(path, { recursive: true, force: true });
      continue;
    }
    writeFileSync(join(path, OWNER_FILE), JSON.stringify({ pid, since: now }), "utf8");
    return true;
  }
  return false;
}

/** Removes the lock only if this process holds it, so a waiter's cleanup can
 *  never take the holder's lock away. */
export function release(path: string): void {
  if (readOwner(path)?.pid === process.pid) rmSync(path, { recursive: true, force: true });
}

/** The pid holding the lock, or null when there is none. */
export function holderOf(path: string): number | null {
  return readOwner(path)?.pid ?? null;
}
