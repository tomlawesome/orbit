import { chownSync } from "node:fs";

// Files the engine writes on the host belong to the operator (#1210 build
// note D5, #1258). The engine one-off runs as the image's root user; on
// rootful Docker that root is the host's root, so without this every
// .env-orbit, secret and lock the engine created would be root-owned and
// install.sh's own ownership check would then refuse the deployment.
//
// scripts/configure.sh passes the operator's identity as ORBIT_HOST_UID /
// ORBIT_HOST_GID (0:0 under rootless Docker, where container root already
// is the operator). Every engine writer calls applyHostOwnership on each
// path it creates, before it becomes visible under its final name where it
// can (a temporary file is handed over before the rename). Not `docker run
// --user`: under rootless Docker a numeric --user maps to a subordinate uid
// the operator cannot access.

export const HOST_UID_ENV = "ORBIT_HOST_UID";
export const HOST_GID_ENV = "ORBIT_HOST_GID";

const NUMERIC_ID = /^(0|[1-9][0-9]{0,9})$/;

export class HostOwnershipError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HostOwnershipError";
  }
}

export interface HostIdentity {
  uid: number;
  gid: number;
}

/**
 * The operator identity from the environment, or undefined when neither
 * variable is set (a direct host run: files are already the caller's own).
 * Exactly one of the pair set, or a value that is not a plain non-negative
 * integer, fails closed rather than guessing an owner.
 */
export function readHostIdentity(env: NodeJS.ProcessEnv = process.env): HostIdentity | undefined {
  const uid = env[HOST_UID_ENV];
  const gid = env[HOST_GID_ENV];
  const uidSet = uid !== undefined && uid !== "";
  const gidSet = gid !== undefined && gid !== "";
  if (!uidSet && !gidSet) return undefined;
  if (!uidSet || !gidSet || !NUMERIC_ID.test(uid) || !NUMERIC_ID.test(gid)) {
    throw new HostOwnershipError(`${HOST_UID_ENV} and ${HOST_GID_ENV} must both be set to non-negative integers.`);
  }
  return { uid: Number(uid), gid: Number(gid) };
}

/**
 * Hands one path the engine just created to the host operator. A no-op when
 * no identity is configured, or when this process already runs as that uid
 * (a rootless engine, or a direct host run), so the common path never
 * needs chown privileges.
 */
export function applyHostOwnership(path: string, env: NodeJS.ProcessEnv = process.env): void {
  const identity = readHostIdentity(env);
  if (!identity) return;
  if (typeof process.getuid === "function" && process.getuid() === identity.uid) return;
  try {
    chownSync(path, identity.uid, identity.gid);
  } catch (error) {
    throw new HostOwnershipError(
      `Could not hand ${path} to the host operator (${(error as NodeJS.ErrnoException).code ?? "unknown error"}).`,
    );
  }
}
