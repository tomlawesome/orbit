import { randomUUID } from "node:crypto";
import { closeSync, constants, openSync, readFileSync, renameSync, rmSync, statSync, writeSync } from "node:fs";
import { join } from "node:path";

import { applyHostOwnership } from "./host-ownership";

// The one deploy lock (#1210 build note D9, #1151 RANGE-F1/F6/R5). Every
// engine writer that read-modify-writes a deployment's managed paths
// (.env-orbit, .orbit-secrets) takes this lock: `orbit configure`'s writers
// (configure-engine.ts), the configuration migration (configuration-
// migration.ts), and install/update's file transaction (install-
// transaction.ts). A second writer against the same deployment directory
// fails fast with a clear message instead of racing.
//
// Pattern: lock file created with O_CREAT|O_EXCL (atomic across processes on
// every filesystem this runs on, unlike a stat-then-create pair). A lock older
// than DEPLOY_LOCK_STALE_MS is treated as abandoned by a crashed process (no
// PID-liveness check works across a container boundary) and reclaimed by
// rename, so two processes that both saw it stale cannot both believe they
// hold it. The lock names its holder, so a release never removes a lock that
// was reclaimed from this process and now belongs to another run.

export const DEPLOY_LOCK_FILE_NAME = ".orbit-engine.lock";
export const DEPLOY_LOCK_STALE_MS = 10 * 60 * 1000;

/** Builds the caller's own refusal error, so each module keeps its error type and "locked" code. */
export type DeployLockErrorFactory = (message: string) => Error;

/**
 * Releases the lock. `share(fn)` runs work done on the holder's own behalf
 * -- the install transaction calling the configure engine and the
 * configuration migration in the same process (#1212) -- during which a
 * nested acquire of this same lock succeeds without taking it again, and
 * its release leaves the holder's lock alone. Explicit and scoped, not a
 * reentrant lock: outside share() a second acquire still refuses.
 */
export type DeployLockRelease = (() => void) & { share<T>(work: () => T): T };

/** Lock path -> owner token, while a holder's share() is running. */
const sharedLocks = new Map<string, string>();

function isStillHeldBy(lockPath: string, owner: string): boolean {
  try {
    return readFileSync(lockPath, "utf8") === owner;
  } catch {
    return false;
  }
}

/**
 * Acquires the deployment-directory lock, or throws the caller's refusal if
 * another run holds it. Returns a release function the caller must call
 * exactly once, success or failure (a second call is a no-op).
 */
export function acquireDeployLock(
  deployDir: string,
  operationLabel: string,
  makeError: DeployLockErrorFactory,
): DeployLockRelease {
  const lockPath = join(deployDir, DEPLOY_LOCK_FILE_NAME);

  const sharedOwner = sharedLocks.get(lockPath);
  if (sharedOwner !== undefined && isStillHeldBy(lockPath, sharedOwner)) {
    return Object.assign(() => {}, { share: <T>(work: () => T): T => work() });
  }

  const takeLock = (): number => openSync(lockPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);

  let fd: number;
  try {
    fd = takeLock();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
      throw makeError(`Could not take the ${operationLabel} lock at ${lockPath}.`);
    }
    let staleEnough: boolean;
    try {
      staleEnough = Date.now() - statSync(lockPath).mtimeMs > DEPLOY_LOCK_STALE_MS;
    } catch {
      staleEnough = true; // Lock vanished between the EEXIST and this stat; retry once below.
    }
    if (!staleEnough) {
      throw makeError(
        `Another ${operationLabel} is already running against this deployment (lock held at ${lockPath}). Wait for it to finish, or remove the lock file yourself once you are certain no other run is active.`,
      );
    }
    const reclaimed = `${lockPath}.stale-${process.pid}`;
    try {
      renameSync(lockPath, reclaimed);
      rmSync(reclaimed, { force: true });
    } catch {
      /* the other process reclaimed it first; the create below decides */
    }
    try {
      fd = takeLock();
    } catch {
      throw makeError(`Another ${operationLabel} is already running against this deployment (lock held at ${lockPath}).`);
    }
  }
  const owner = `${process.pid}:${randomUUID()}\n`;
  try {
    writeSync(fd, owner);
  } finally {
    closeSync(fd);
  }
  // A lock left behind by a killed run must still be removable by the
  // operator (#1258), so it is theirs from the moment it exists.
  try {
    applyHostOwnership(lockPath);
  } catch (error) {
    rmSync(lockPath, { force: true });
    throw makeError((error as Error).message);
  }

  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    sharedLocks.delete(lockPath);
    try {
      if (readFileSync(lockPath, "utf8") === owner) rmSync(lockPath, { force: true });
    } catch {
      /* best effort */
    }
  };
  const share = <T>(work: () => T): T => {
    sharedLocks.set(lockPath, owner);
    let result: T;
    try {
      result = work();
    } catch (error) {
      sharedLocks.delete(lockPath);
      throw error;
    }
    if (result instanceof Promise) {
      return result.finally(() => sharedLocks.delete(lockPath)) as T;
    }
    sharedLocks.delete(lockPath);
    return result;
  };
  return Object.assign(release, { share });
}
