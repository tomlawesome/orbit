import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
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

/** How long a lock directory with no readable owner record is still given to
 *  get one: its holder may be between `mkdir` and the record's rename. */
export const OWNER_GRACE_MS = 5000;

/** Errors a lost race produces: the other side removed, retook or refilled the directory. */
const RACE_CODES = new Set(["ENOENT", "ENOTEMPTY", "EEXIST"]);

function lostRace(error: unknown): boolean {
  return RACE_CODES.has((error as NodeJS.ErrnoException).code ?? "");
}

/** Writes the record through a temp file in the lock directory and a rename,
 *  so a reader sees the whole record or none, never a half-written one. */
function writeOwner(path: string, owner: Owner): void {
  const temp = join(path, `${OWNER_FILE}.${owner.pid}.tmp`);
  try {
    writeFileSync(temp, JSON.stringify(owner), "utf8");
    renameSync(temp, join(path, OWNER_FILE));
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
}

/** A lock with an owner is stale once its pid is gone or its last renew is
 *  older than `staleMs`. One with no readable owner is stale only once its
 *  directory is older than the grace period; younger, it is held. */
function stale(path: string, now: number, staleMs: number): boolean {
  const owner = readOwner(path);
  if (owner !== null) return !alive(owner.pid) || now - owner.since > staleMs;
  try {
    return now - statSync(path).mtimeMs > OWNER_GRACE_MS;
  } catch {
    return true; /* The directory is gone: nothing holds it. */
  }
}

export function tryAcquire(
  path: string,
  options: { pid: number; now?: number; staleMs?: number },
): boolean {
  const { pid, now = Date.now(), staleMs = 600_000 } = options;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      try {
        mkdirSync(path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        if (!stale(path, now, staleMs)) return false;
        rmSync(path, { recursive: true, force: true });
        continue;
      }
      writeOwner(path, { pid, since: now });
      return true;
    } catch (error) {
      if (lostRace(error)) return false;
      throw error;
    }
  }
  return false;
}

/** Marks the lock as still in use: when `pid` holds it, rewrites its start
 *  time to `now` and returns true; otherwise changes nothing and returns false. */
export function renew(path: string, options: { pid: number; now?: number }): boolean {
  const { pid, now = Date.now() } = options;
  if (readOwner(path)?.pid !== pid) return false;
  try {
    writeOwner(path, { pid, since: now });
    return true;
  } catch (error) {
    if (lostRace(error)) return false;
    throw error;
  }
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
