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
 * Acquires the deployment-directory lock, or throws the caller's refusal if
 * another run holds it. Returns a release function the caller must call
 * exactly once, success or failure (a second call is a no-op).
 */
export function acquireDeployLock(
  deployDir: string,
  operationLabel: string,
  makeError: DeployLockErrorFactory,
): () => void {
  const lockPath = join(deployDir, DEPLOY_LOCK_FILE_NAME);

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
  return () => {
    if (released) return;
    released = true;
    try {
      if (readFileSync(lockPath, "utf8") === owner) rmSync(lockPath, { force: true });
    } catch {
      /* best effort */
    }
  };
}
