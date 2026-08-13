import {
  chmodSync,
  closeSync,
  constants,
  copyFileSync,
  fchmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  renameSync,
  rmSync,
  rmdirSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { dirname, join } from "node:path";

// The staged, atomic .env-orbit + secrets-directory commit/rollback
// transaction (issue #295 slice 1), ported from scripts/install.sh's
// `preflight_final_paths`, `prepare_rollback_area`, `rollback_transaction`,
// and `cleanup` (the EXIT trap). Guarantee numbers below cite
// docs/installer-guarantees.md, Part 1 / install.sh, and are re-asserted by
// name in src/lib/install-transaction.test.ts.
//
// This module is pure filesystem logic: no Docker, no network, no
// interactive prompts, and no knowledge of *what* content belongs at a
// managed path — the caller supplies staged content and decides when to
// commit. Asset fetching, image/digest resolution, OIDC discovery and
// configure.sh invocation are later slices (see
// docs/adr-notes/295-install-port-plan.md).
//
// Crash semantics are intentionally unchanged from Bash: SIGKILL cannot be
// trapped by either implementation, so a hard kill leaves the staging and
// rollback-backup evidence on disk for operator-driven recovery rather than
// an automatic resume. This module does not attempt to resume a
// transaction from a preserved staging directory; neither does install.sh.

/** Mode installer-guarantee #47/#48 requires for staging and rollback directories. */
export const SECURE_DIRECTORY_MODE = 0o700;

/** Mode installer-guarantee #53/#54 requires for staged secret-bearing files. */
export const SECURE_FILE_MODE = 0o600;

/** mktemp -d "./.orbit-install-staging.XXXXXX" prefix (install.sh:1398). */
export const STAGING_DIRECTORY_PREFIX = ".orbit-install-staging.";

export type ManagedPathType = "file" | "directory";

export interface ManagedPath {
  /** POSIX-style path relative to the target directory, e.g. ".env-orbit". */
  path: string;
  type: ManagedPathType;
}

export type InstallTransactionRefusalCode =
  | "unsafe-final-type"
  | "unsafe-backup-source"
  | "staging-directory-unavailable";

/**
 * Thrown for every fail-closed refusal this module makes: a managed path
 * (or the parent of one being restored) is not the safe, non-symlink type
 * install.sh requires before it will touch the path.
 */
export class InstallTransactionRefusal extends Error {
  readonly code: InstallTransactionRefusalCode;
  readonly path?: string;

  constructor(message: string, code: InstallTransactionRefusalCode, path?: string) {
    super(message);
    this.name = "InstallTransactionRefusal";
    this.code = code;
    this.path = path;
  }
}

export interface RollbackFailure {
  path: string;
  reason: "symlinked-parent" | "unsafe-parent" | "remove-failed" | "restore-failed" | "unsupported-type";
}

export interface RollbackResult {
  ok: boolean;
  failures: RollbackFailure[];
}

export interface DisposeResult {
  rollbackAttempted: boolean;
  rollbackSucceeded: boolean;
  stagingDirectoryRemoved: boolean;
  /** Set only when rollback or staging removal failed — the evidence path an operator must inspect. */
  preservedStagingDirectory?: string;
}

function existsAsAnyType(absolutePath: string): boolean {
  try {
    lstatSync(absolutePath);
    return true;
  } catch {
    return false;
  }
}

function isRegularNonSymlinkFile(absolutePath: string): boolean {
  try {
    return lstatSync(absolutePath).isFile();
  } catch {
    return false;
  }
}

function isRealNonSymlinkDirectory(absolutePath: string): boolean {
  try {
    return lstatSync(absolutePath).isDirectory();
  } catch {
    return false;
  }
}

function isSymlink(absolutePath: string): boolean {
  try {
    return lstatSync(absolutePath).isSymbolicLink();
  } catch {
    return false;
  }
}

function isSafeFinalType(absolutePath: string, type: ManagedPathType): boolean {
  return type === "file" ? isRegularNonSymlinkFile(absolutePath) : isRealNonSymlinkDirectory(absolutePath);
}

function describeType(type: ManagedPathType): string {
  return type === "file" ? "a regular file" : "a real directory";
}

// remove_target_path (install.sh:306-316): symlink or regular file -> rm -f;
// directory -> rm -rf; anything else that still exists -> rm -f.
function removeTargetPath(absolutePath: string): void {
  let stat;
  try {
    stat = lstatSync(absolutePath);
  } catch {
    return;
  }
  if (stat.isDirectory()) {
    rmSync(absolutePath, { recursive: true, force: true });
  } else {
    rmSync(absolutePath, { force: true });
  }
}

// cp -a equivalent for a single managed path: recursive, preserves mode and
// content exactly, and refuses (rather than silently dereferencing) any
// symlink or non-regular entry found underneath — install.sh's cp -a would
// otherwise happily copy through a symlink, but preflight has already
// guaranteed the managed path itself is safe, and this module makes the
// same guarantee recursively for defence in depth.
function copyPreservingMode(sourceAbsolute: string, destinationAbsolute: string): void {
  const stat = lstatSync(sourceAbsolute);
  if (stat.isSymbolicLink()) {
    throw new InstallTransactionRefusal(
      `Refusing to back up ${sourceAbsolute} because it is a symlink.`,
      "unsafe-backup-source",
      sourceAbsolute,
    );
  }
  if (stat.isDirectory()) {
    mkdirSync(destinationAbsolute);
    chmodSync(destinationAbsolute, stat.mode & 0o777);
    for (const entry of readdirSync(sourceAbsolute)) {
      copyPreservingMode(join(sourceAbsolute, entry), join(destinationAbsolute, entry));
    }
    return;
  }
  if (stat.isFile()) {
    copyFileSync(sourceAbsolute, destinationAbsolute);
    chmodSync(destinationAbsolute, stat.mode & 0o777);
    return;
  }
  throw new InstallTransactionRefusal(
    `Refusing to back up ${sourceAbsolute} because it is not a regular file or directory.`,
    "unsafe-backup-source",
    sourceAbsolute,
  );
}

/**
 * preflight_final_paths (install.sh:1345-1370): refuse before any mutation
 * if an existing final destination is not of its expected safe type.
 * Guarantee #46.
 */
export function preflightManagedPaths(targetDir: string, managedPaths: readonly ManagedPath[]): void {
  for (const managed of managedPaths) {
    const absolute = join(targetDir, managed.path);
    if (!existsAsAnyType(absolute)) continue;
    if (!isSafeFinalType(absolute, managed.type)) {
      throw new InstallTransactionRefusal(
        `Refusing to use ${managed.path} because it is not ${describeType(managed.type)}.`,
        "unsafe-final-type",
        managed.path,
      );
    }
  }
}

export class InstallTransaction {
  readonly targetDir: string;
  readonly stagingDir: string;
  readonly rollbackDir: string;
  readonly originalDir: string;

  private readonly managedPaths: readonly ManagedPath[];
  private readonly managedWasPresent = new Map<string, boolean>();
  private readonly createdDirectories: string[] = [];
  private active = false;
  private committed = false;
  private disposed = false;

  private constructor(targetDir: string, stagingDir: string, managedPaths: readonly ManagedPath[]) {
    this.targetDir = targetDir;
    this.stagingDir = stagingDir;
    this.rollbackDir = join(stagingDir, "rollback");
    this.originalDir = join(this.rollbackDir, "original");
    this.managedPaths = managedPaths;
  }

  /**
   * Preflights every managed path (#46), creates the private 0700 staging
   * directory under the target (#48), and backs up every currently-existing
   * managed path into the rollback area (#47) before marking the
   * transaction active (#49) — mirrors install.sh:1395-1439 in order.
   */
  static begin(targetDir: string, managedPaths: readonly ManagedPath[]): InstallTransaction {
    preflightManagedPaths(targetDir, managedPaths);

    let stagingDir: string;
    try {
      stagingDir = mkdtempSync(join(targetDir, STAGING_DIRECTORY_PREFIX));
    } catch (error) {
      throw new InstallTransactionRefusal(
        `Could not create a private staging directory: ${(error as Error).message}`,
        "staging-directory-unavailable",
      );
    }
    chmodSync(stagingDir, SECURE_DIRECTORY_MODE);

    const transaction = new InstallTransaction(targetDir, stagingDir, managedPaths);
    transaction.prepareRollbackArea();
    transaction.active = true;
    return transaction;
  }

  // prepare_rollback_area (install.sh:1372-1393).
  private prepareRollbackArea(): void {
    mkdirSync(this.rollbackDir);
    chmodSync(this.rollbackDir, SECURE_DIRECTORY_MODE);
    mkdirSync(this.originalDir);
    chmodSync(this.originalDir, SECURE_DIRECTORY_MODE);

    for (const managed of this.managedPaths) {
      const absolute = join(this.targetDir, managed.path);
      const present = existsAsAnyType(absolute);
      this.managedWasPresent.set(managed.path, present);
      if (!present) continue;

      const backupPath = join(this.originalDir, managed.path);
      const backupParent = dirname(backupPath);
      mkdirSync(backupParent, { recursive: true });
      chmodSync(backupParent, SECURE_DIRECTORY_MODE);
      copyPreservingMode(absolute, backupPath);
    }
  }

  private requireActive(): void {
    if (!this.active || this.committed) {
      throw new Error("InstallTransaction: no active, uncommitted transaction.");
    }
  }

  /** Absolute path for staged content, creating parent directories as needed. */
  stagingPathFor(relativePath: string): string {
    const absolute = join(this.stagingDir, relativePath);
    mkdirSync(dirname(absolute), { recursive: true });
    return absolute;
  }

  /**
   * Writes staged content with its permissions forced before any byte is
   * written (guarantee #53/#54's "never briefly world-readable" discipline,
   * ported from configure.sh/install.sh's mktemp+chmod-before-write+mv
   * pattern) — the caller commits it into place with commitMove.
   */
  writeStagedFile(relativePath: string, content: string | Buffer, mode: number = SECURE_FILE_MODE): string {
    this.requireActive();
    const absolute = this.stagingPathFor(relativePath);
    const descriptor = openSync(absolute, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC, mode);
    try {
      fchmodSync(descriptor, mode);
      writeSync(descriptor, typeof content === "string" ? Buffer.from(content, "utf8") : content);
    } finally {
      closeSync(descriptor);
    }
    return absolute;
  }

  /**
   * Moves a staged path onto its final destination via rename — never
   * copy (#52/#54) — after a TOCTOU re-check of the final destination's
   * type immediately before mutation (#51).
   */
  commitMove(relativePath: string, type: ManagedPathType): void {
    this.requireActive();
    const finalAbsolute = join(this.targetDir, relativePath);
    const stagedAbsolute = join(this.stagingDir, relativePath);

    if (existsAsAnyType(finalAbsolute) && !isSafeFinalType(finalAbsolute, type)) {
      throw new InstallTransactionRefusal(
        `Refusing to overwrite ${relativePath} because it is not ${describeType(type)}.`,
        "unsafe-final-type",
        relativePath,
      );
    }
    renameSync(stagedAbsolute, finalAbsolute);
  }

  /**
   * Ensures a managed directory exists at the final destination, creating
   * it (and recording it as newly created, so only this invocation's own
   * directories are ever removed on rollback — #10) if absent.
   */
  ensureManagedDirectory(relativePath: string): void {
    this.requireActive();
    const absolute = join(this.targetDir, relativePath);
    if (existsAsAnyType(absolute)) {
      if (!isRealNonSymlinkDirectory(absolute)) {
        throw new InstallTransactionRefusal(
          `Refusing to install into ${relativePath} because it is not a real directory.`,
          "unsafe-final-type",
          relativePath,
        );
      }
      return;
    }
    mkdirSync(absolute);
    this.createdDirectories.push(relativePath);
  }

  /**
   * Marks the transaction committed: dispose() will no longer roll back
   * (#56). Also records the commit in the staging directory itself
   * (install.sh:1569-1582, issue #383 finding 2): if the host dies during
   * the post-commit image-pull/health-wait phase, the surviving staging
   * directory would otherwise be indistinguishable from an interrupted
   * transaction, and repair.sh's restore-transaction would silently revert
   * a successful install. repair.sh refuses when this marker is present.
   */
  commit(): void {
    this.requireActive();
    writeFileSync(join(this.stagingDir, "committed"), "");
    this.committed = true;
  }

  /**
   * rollback_transaction (install.sh:318-386): remove paths that did not
   * exist before the transaction (reverse order, refusing to follow a
   * symlinked parent — #8), restore every backed-up path with a
   * same-filesystem rename (forward order — #9), then remove only the
   * directories this invocation created, and only if now empty (#10).
   * Never throws; failures are reported so the caller can decide whether to
   * preserve staging evidence, mirroring cleanup()'s own handling.
   */
  rollback(): RollbackResult {
    const failures: RollbackFailure[] = [];

    for (let index = this.managedPaths.length - 1; index >= 0; index -= 1) {
      const managed = this.managedPaths[index];
      if (this.managedWasPresent.get(managed.path)) continue;
      const parent = dirname(managed.path);
      if (parent !== "." && isSymlink(join(this.targetDir, parent))) {
        failures.push({ path: managed.path, reason: "symlinked-parent" });
        continue;
      }
      try {
        removeTargetPath(join(this.targetDir, managed.path));
      } catch {
        failures.push({ path: managed.path, reason: "remove-failed" });
      }
    }

    for (const managed of this.managedPaths) {
      if (!this.managedWasPresent.get(managed.path)) continue;
      const absolute = join(this.targetDir, managed.path);
      const parent = dirname(managed.path);
      if (parent !== "." && !isRealNonSymlinkDirectory(join(this.targetDir, parent))) {
        failures.push({ path: managed.path, reason: "unsafe-parent" });
        continue;
      }
      const backupPath = join(this.originalDir, managed.path);
      try {
        removeTargetPath(absolute);
      } catch {
        failures.push({ path: managed.path, reason: "remove-failed" });
        continue;
      }
      try {
        renameSync(backupPath, absolute);
      } catch {
        failures.push({ path: managed.path, reason: "restore-failed" });
      }
    }

    for (let index = this.createdDirectories.length - 1; index >= 0; index -= 1) {
      const relativePath = this.createdDirectories[index];
      const absolute = join(this.targetDir, relativePath);
      if (!existsAsAnyType(absolute)) continue;
      const stat = lstatSync(absolute);
      if (stat.isDirectory()) {
        try {
          rmdirSync(absolute);
        } catch {
          failures.push({ path: relativePath, reason: "remove-failed" });
        }
      } else if (stat.isSymbolicLink() || stat.isFile()) {
        try {
          rmSync(absolute, { force: true });
        } catch {
          failures.push({ path: relativePath, reason: "remove-failed" });
        }
      } else {
        failures.push({ path: relativePath, reason: "unsupported-type" });
      }
    }

    const ok = failures.length === 0;
    if (ok) this.active = false;
    return { ok, failures };
  }

  /**
   * cleanup (install.sh:388-406, the EXIT trap): rolls back an uncommitted
   * active transaction; if rollback fails, preserves the staging directory
   * and reports its path instead of deleting recovery evidence. Idempotent.
   */
  dispose(): DisposeResult {
    if (this.disposed) {
      return { rollbackAttempted: false, rollbackSucceeded: true, stagingDirectoryRemoved: true };
    }
    this.disposed = true;

    let rollbackAttempted = false;
    let rollbackSucceeded = true;
    if (this.active && !this.committed) {
      rollbackAttempted = true;
      rollbackSucceeded = this.rollback().ok;
    }

    if (!rollbackSucceeded) {
      return {
        rollbackAttempted,
        rollbackSucceeded,
        stagingDirectoryRemoved: false,
        preservedStagingDirectory: this.stagingDir,
      };
    }

    try {
      rmSync(this.stagingDir, { recursive: true, force: true });
      return { rollbackAttempted, rollbackSucceeded, stagingDirectoryRemoved: true };
    } catch {
      return {
        rollbackAttempted,
        rollbackSucceeded,
        stagingDirectoryRemoved: false,
        preservedStagingDirectory: this.stagingDir,
      };
    }
  }

  /** True once begin() has run and neither commit() nor a successful rollback() has. */
  isActive(): boolean {
    return this.active && !this.committed;
  }

  /** True after commit(). */
  isCommitted(): boolean {
    return this.committed;
  }
}

// Re-exported for tests that need to assert on raw filesystem facts without
// duplicating the predicate logic above.
export const internal = {
  existsAsAnyType,
  isRegularNonSymlinkFile,
  isRealNonSymlinkDirectory,
  isSymlink,
  isSafeFinalType,
  removeTargetPath,
};
