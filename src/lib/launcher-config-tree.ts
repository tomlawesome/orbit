import { chmodSync, closeSync, constants, fchmodSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, writeSync } from "node:fs";
import { join } from "node:path";

import { applyHostOwnership, readHostIdentity } from "./host-ownership";

// ORBIT_LAUNCHER_CONFIG_TREE (#1225): on any install exit whose event reason
// is configuration-failure, the launcher is left the configure tree this run
// verified, so it can reconfigure without a deployment. Since #1212
// (amendment note 30988 to build note F8) the install engine writes it,
// before it rolls back, from its own image's deployment assets plus the
// image pin -- install.sh used to copy a snapshot it had extracted itself.
//
// install.sh bind-mounts the launcher's directory into the engine and names
// the mount point in ORBIT_LAUNCHER_CONFIG_TREE, or, when the directory
// cannot be mounted (a symlink, missing, not a directory), says why in
// ORBIT_LAUNCHER_CONFIG_TREE_UNAVAILABLE. Writing into a directory another
// program owns follows the installer's own write and rollback rules: owned
// by the host user, mode 0700 and empty first; never through a symlink,
// never over an existing entry (O_EXCL); owner-only files; all or nothing,
// with everything written removed when any copy fails. Every outcome leaves
// the install's own exit unchanged; a refusal is one stderr line.

/** What the launcher tree receives from the image, beside the .orbit-image pin. */
export const LAUNCHER_CONFIG_TREE_ASSETS: readonly string[] = ["scripts/configure.sh", "scripts/installer-ui.sh", ".env-orbit.example"];

export const LAUNCHER_CONFIG_TREE_ENV = "ORBIT_LAUNCHER_CONFIG_TREE";
export const LAUNCHER_CONFIG_TREE_UNAVAILABLE_ENV = "ORBIT_LAUNCHER_CONFIG_TREE_UNAVAILABLE";

/** The reasons install.sh may hand over for a directory it could not mount; anything else is not echoed. */
const SHELL_REASONS = new Set(["it is a symlink", "it does not exist", "it is not a directory", "it could not be entered"]);

export interface LauncherConfigTreeRequest {
  /** The mounted directory, as the engine sees it; undefined when the launcher set nothing. */
  tree: string | undefined;
  /** Why install.sh could not mount the directory it was given. */
  unavailableReason?: string;
  /** The image's own deployment assets (/opt/orbit/deploy). */
  assetsRoot: string;
  /** The verified digest reference, written as .orbit-image. */
  imageReference: string;
  /** Where the one-line refusal goes (stderr). */
  notice: (line: string) => void;
  /** Test hook: runs before each file is created, so a test can take its name first or fail it. */
  beforeWrite?: (asset: string) => void;
}

export type LauncherConfigTreeResult = "not-requested" | "written" | "refused";

function noticeLine(reason: string): string {
  return `Orbit installer: ${LAUNCHER_CONFIG_TREE_ENV} was not written because ${reason}.`;
}

/** The uid the tree must belong to: the host operator as the engine sees them. */
function expectedOwner(): number | undefined {
  const identity = readHostIdentity();
  if (identity) return identity.uid;
  return typeof process.getuid === "function" ? process.getuid() : undefined;
}

/** Why the directory must not be written, or undefined. */
function refusal(tree: string): string | undefined {
  let stat;
  try {
    stat = lstatSync(tree);
  } catch {
    return "it does not exist";
  }
  if (stat.isSymbolicLink()) return "it is a symlink";
  if (!stat.isDirectory()) return "it is not a directory";
  const owner = expectedOwner();
  if (owner !== undefined && stat.uid !== owner) return "it is not owned by the current user";
  if ((stat.mode & 0o777) !== 0o700) return "it is not mode 0700";
  let entries: string[];
  try {
    entries = readdirSync(tree);
  } catch {
    return "it could not be entered";
  }
  if (entries.length > 0) return "it is not empty";
  return undefined;
}

/** O_EXCL + O_NOFOLLOW, owner-only whatever the umask, handed to the operator, read back to compare. */
function writeExclusive(path: string, content: Buffer): void {
  const descriptor = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    fchmodSync(descriptor, 0o600);
    applyHostOwnership(path);
    let offset = 0;
    while (offset < content.length) offset += writeSync(descriptor, content, offset);
  } finally {
    closeSync(descriptor);
  }
  const lstat = lstatSync(path);
  if (!lstat.isFile() || !readFileSync(path).equals(content)) throw new Error("mismatch");
}

/**
 * Hands the launcher its configure tree. Called only on a configuration-failure
 * exit, before the install's rollback; never throws.
 */
export function handOverLauncherConfigTree(request: LauncherConfigTreeRequest): LauncherConfigTreeResult {
  if (request.tree === undefined || request.tree === "") {
    if (request.unavailableReason !== undefined && request.unavailableReason !== "") {
      request.notice(noticeLine(SHELL_REASONS.has(request.unavailableReason) ? request.unavailableReason : "it could not be entered"));
      return "refused";
    }
    return "not-requested";
  }
  const tree = request.tree;

  // The image's copies, read before anything is written: a bundle that
  // cannot be read is nothing to hand over.
  const sources = new Map<string, Buffer>();
  try {
    for (const asset of LAUNCHER_CONFIG_TREE_ASSETS) {
      const source = join(request.assetsRoot, asset);
      if (!lstatSync(source).isFile()) throw new Error("not a regular file");
      sources.set(asset, readFileSync(source));
    }
  } catch {
    request.notice(noticeLine("the verified copies are unavailable"));
    return "refused";
  }
  sources.set(".orbit-image", Buffer.from(`${request.imageReference}\n`, "utf8"));

  const reason = refusal(tree);
  if (reason) {
    request.notice(noticeLine(reason));
    return "refused";
  }

  const scripts = join(tree, "scripts");
  try {
    mkdirSync(scripts, { mode: 0o700 });
  } catch {
    request.notice(noticeLine("its scripts directory could not be created"));
    return "refused";
  }
  // rmSync removes a symlink itself, never what it points at.
  const removeWritten = () => {
    for (const path of [scripts, join(tree, ".env-orbit.example"), join(tree, ".orbit-image")]) {
      try {
        rmSync(path, { recursive: true, force: true });
      } catch {
        /* best effort: the notice below still names the failure */
      }
    }
  };
  try {
    // Owner-only whatever the umask the engine runs under.
    chmodSync(scripts, 0o700);
    applyHostOwnership(scripts);
    if (!lstatSync(scripts).isDirectory()) throw new Error("scripts is not a directory");
  } catch {
    removeWritten();
    request.notice(noticeLine("its scripts directory could not be created"));
    return "refused";
  }

  for (const [asset, content] of sources) {
    try {
      request.beforeWrite?.(asset);
      writeExclusive(join(tree, asset), content);
    } catch {
      removeWritten();
      request.notice(noticeLine(`${asset} could not be written`));
      return "refused";
    }
  }
  return "written";
}
