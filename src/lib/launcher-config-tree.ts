import { chmodSync, closeSync, constants, fchmodSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, writeFileSync, writeSync } from "node:fs";
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
//
// The tree is two-way since #1519: the launcher may leave the configuration
// it ran in it (`.env-orbit`, and `.orbit-secrets/`) for the next install to
// take in (takeHandedInConfiguration), so the install's transaction is the
// only writer in the deployment folder. Those two entries are the only ones
// the configure tree may be written beside, apart from the tree's own
// leftovers: a launcher that reconfigures and fails again still holds the
// last hand-over, so those three names are replaced, never refused.

/** What the launcher tree receives from the image, beside the .orbit-image pin. */
export const LAUNCHER_CONFIG_TREE_ASSETS: readonly string[] = ["scripts/configure.sh", "scripts/installer-ui.sh", ".env-orbit.example"];

/** What the launcher may leave in the tree for the install to take in (#1519). */
export const LAUNCHER_HANDED_IN_ENTRIES: readonly string[] = [".env-orbit", ".orbit-secrets"];

/** What an earlier hand-over left in the tree, replaced by the next one: the directory first, then the files. */
const OWN_LEFTOVERS: readonly string[] = ["scripts", ".env-orbit.example", ".orbit-image"];

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
  if (entries.some((entry) => !LAUNCHER_HANDED_IN_ENTRIES.includes(entry) && !OWN_LEFTOVERS.includes(entry))) return "it is not empty";
  return undefined;
}

/**
 * Removes an earlier hand-over's leftovers, after checking every one has the
 * shape a hand-over writes (lstat, so a symlink is never followed): scripts a
 * real directory, the two files regular files. Anything else is refused with
 * nothing removed.
 */
function removeOwnLeftovers(tree: string): string | undefined {
  const present: string[] = [];
  for (const name of OWN_LEFTOVERS) {
    let stat;
    try {
      stat = lstatSync(join(tree, name));
    } catch {
      continue;
    }
    if (name === "scripts" ? !stat.isDirectory() : !stat.isFile()) return "it holds something that is not ours";
    present.push(name);
  }
  try {
    for (const name of present) rmSync(join(tree, name), { recursive: true, force: true });
  } catch {
    return "its earlier copies could not be removed";
  }
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

  const reason = refusal(tree) ?? removeOwnLeftovers(tree);
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

export type HandedInConfiguration = { kind: "none" } | { kind: "taken" } | { kind: "refused"; problem: string };

/** Whether the tree holds a `.env-orbit` at all (of any kind): a configuration the launcher handed in. */
export function treeHoldsConfiguration(tree: string | undefined): boolean {
  if (tree === undefined || tree === "") return false;
  try {
    lstatSync(join(tree, LAUNCHER_HANDED_IN_ENTRIES[0]));
    return true;
  } catch {
    return false;
  }
}

/** One owner-only regular file, read through an O_NOFOLLOW descriptor (a symlink is refused, never followed). */
function readOwnerOnlyFile(path: string, name: string): { content: Buffer; mode: number } | { problem: string } {
  let descriptor: number;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    return { problem: `its ${name} is a symlink or cannot be read` };
  }
  try {
    const stat = fstatSync(descriptor);
    if (!stat.isFile()) return { problem: `its ${name} is not a regular file` };
    if ((stat.mode & 0o077) !== 0) return { problem: `its ${name} is readable by others than its owner` };
    return { content: readFileSync(descriptor), mode: stat.mode & 0o777 };
  } finally {
    closeSync(descriptor);
  }
}

/**
 * The launcher's configuration, handed in through its tree (#1519), copied
 * into the install's scratch directory, where the engine stages a guided
 * configuration, so it reaches the deployment only through the transaction:
 * `.env-orbit`, an owner-only regular file, and `.orbit-secrets/` when
 * there is one, a real directory of owner-only regular files. Nothing in the
 * tree is changed. "none" when the tree holds no `.env-orbit`; "refused",
 * with what is wrong, for anything of another shape (and nothing copied).
 */
export function takeHandedInConfiguration(tree: string | undefined, scratchDir: string): HandedInConfiguration {
  if (tree === undefined || !treeHoldsConfiguration(tree)) return { kind: "none" };
  const root = tree;
  const [environmentName, secretsName] = LAUNCHER_HANDED_IN_ENTRIES;
  const environment = readOwnerOnlyFile(join(root, environmentName), environmentName);
  if ("problem" in environment) return { kind: "refused", problem: environment.problem };

  const secrets = new Map<string, { content: Buffer; mode: number }>();
  const secretsDir = join(root, secretsName);
  let secretsStat;
  try {
    secretsStat = lstatSync(secretsDir);
  } catch {
    secretsStat = undefined;
  }
  if (secretsStat) {
    if (secretsStat.isSymbolicLink() || !secretsStat.isDirectory()) return { kind: "refused", problem: `its ${secretsName} is not a real directory` };
    if ((secretsStat.mode & 0o077) !== 0) return { kind: "refused", problem: `its ${secretsName} is open to others than its owner` };
    let names: string[];
    try {
      names = readdirSync(secretsDir);
    } catch {
      return { kind: "refused", problem: `its ${secretsName} could not be read` };
    }
    for (const name of names) {
      const file = readOwnerOnlyFile(join(secretsDir, name), `${secretsName}/${name}`);
      if ("problem" in file) return { kind: "refused", problem: file.problem };
      secrets.set(name, file);
    }
  }

  writeFileSync(join(scratchDir, environmentName), environment.content, { mode: 0o600, flag: "wx" });
  if (secretsStat) {
    mkdirSync(join(scratchDir, secretsName), { mode: 0o700 });
    for (const [name, file] of secrets) writeFileSync(join(scratchDir, secretsName, name), file.content, { mode: file.mode, flag: "wx" });
  }
  return { kind: "taken" };
}
