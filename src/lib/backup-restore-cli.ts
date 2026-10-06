import { spawnSync } from "node:child_process";
import {
  chmodSync,
  closeSync,
  constants,
  copyFileSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { applyHostOwnership } from "./host-ownership";
import {
  type BackupDockerAdapter,
  type BackupManifestFields,
  RecoveryBundleRefusal,
  type CreateBackupBundleResult,
  RECOVERY_BUNDLE_MEMBERS,
  SECURE_DIRECTORY_MODE,
  SECURE_FILE_MODE,
  buildRecoveryManifest,
  createBackupBundle,
  createTar,
  decryptDocumentKek,
  encryptDocumentKek,
  extractTar,
  publishBundleAtomically,
  requireMatchingPassphrase,
  requireRegularNonSymlinkFile,
  requireValidPassphrase,
  sha256File,
  validateBackupBundleContents,
  validateBackupBundleLayout,
  validateRecoveryBundleLayout,
  validateRecoveryManifestFormatVersion,
  verifyRecoveryBundleChecksums,
  writeSecretFile,
} from "./recovery-bundle";
import {
  type RestoreDisposeResult,
  type RestoreDockerAdapter,
  type RestoreDurabilityHooks,
  type RestorePaths,
  RestoreRun,
  checkRestoreCapacity,
  deriveRestorePaths,
  directoryUsageKib,
  filesystemAvailableKib,
  preflightValidateBundle,
  refuseIfDocumentKekRotationOpen,
} from "./restore-engine";

// Orchestration tying slices 1-3 (src/lib/recovery-bundle.ts's bundle-format
// crypto/packaging and src/lib/restore-engine.ts's transactional restore
// engine) into the backup/restore/export/import flows themselves — issue
// #296 slice 4 (docs/adr-notes/296-backup-port-plan.md). Every function here
// composes existing, already-characterized building blocks; no new crypto or
// mutation primitive is introduced. Every live mutation still goes through
// RestoreRun's journal/checkpoint machinery — nothing here bypasses it.
//
// Pure orchestration logic, injected-adapter style like both modules it
// composes: no direct process/stdio access (that belongs to src/cli/orbit.ts,
// which is the only caller of the functions below in a shipped path).

export type BackupRestoreCliRefusalCode =
  | "restore-journal-exists"
  | "restore-not-confirmed"
  | "import-not-confirmed"
  | "live-key-invalid"
  | "restore-unfinished"
  | "staging-failed"
  | "backup-directory-unsafe"
  | "restore-locked"
  | "app-stop-failed"
  | "rollback-conflict"
  | "test-failure-requested"
  | "import-preflight-failed";

/**
 * Thrown for every fail-closed refusal this orchestration layer itself
 * makes (as opposed to a refusal surfaced unchanged from recovery-bundle.ts
 * or restore-engine.ts). Never carries secret material or attacker-
 * controlled path/member names, matching both modules' existing discipline.
 */
export class BackupRestoreCliRefusal extends Error {
  readonly code: BackupRestoreCliRefusalCode;

  constructor(message: string, code: BackupRestoreCliRefusalCode) {
    super(message);
    this.name = "BackupRestoreCliRefusal";
    this.code = code;
  }
}

function refuse(code: BackupRestoreCliRefusalCode, message: string): never {
  throw new BackupRestoreCliRefusal(message, code);
}

function rmSafely(path: string): void {
  try {
    // recursive: withScratchCleanupOnSignal hands this a directory, and a
    // non-recursive rmSync of one throws, which the catch below would hide.
    rmSync(path, { force: true, recursive: true });
  } catch {
    // Best-effort, matching restore.sh/import-recovery-bundle.sh's own `|| true` cleanup.
  }
}

function isSymlinkPath(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

// --- cross-process backup/restore lock (O2-R7, #1151 RANGE-R6/S3/S4) -------
//
// Before O2-R7, two concurrent `orbit restore` runs were only ever
// distinguished by the journal restore.sh/writeRestoreJournal writes at the
// *end* of checkpointing — so both could pass the "no journal yet" check,
// stage, capacity-check and confirm concurrently, and both reach the
// checkpoint/cutover machinery at once. Taking this lock as the very first
// step closes that window; a second run against the same backup directory
// fails fast instead of racing.
//
// `runBackup` originally took no lock at all, reopening the identical O2-R3
// hazard (a backup's stopApp/startApp racing a restore's cutover) inside the
// new code, and did so under a different file name than the Bash scripts'
// shared lock (scripts/backup.sh / scripts/restore.sh / scripts/
// import-recovery-bundle.sh's `.orbit-backup-restore.lock`). `--dir`'s backup
// directory matches the Bash scripts' default `ORBIT_BACKUP_DIR` (both
// `<root>/backups`), so by default both sides contend for the same file.
//
// The lock is the same flock(2) the Bash scripts hold (#1151 RANGE-R6/S3/S4):
// `exec {fd}>file; flock -n $fd`, held on the open file description until
// the process closes it or exits. An earlier version here created the file
// with O_EXCL, wrote an owner marker and closed it. That gave no mutual
// exclusion against the Bash scripts at all: their `exec {fd}>file`
// truncated the marker and `flock -n` succeeded at once, since nobody held a
// flock, so a Bash backup/restore ran its own stop/start and cutover
// alongside a TS one. Here the fd stays open for the whole run and the
// `flock` utility locks it through inheritance (the child's fd 3 is our open
// file description, which is what flock(2) locks belong to), so the lock
// outlives the child. The kernel drops it on close, exit or crash, so there
// is no stale state to reclaim. The file is never removed: a Bash run
// blocked in `flock` on the old inode would wake holding a lock nobody else
// can see. Since #1211 the CLI runs inside the deployment (a compose one-off
// on orbit-app) with the backups directory bind-mounted from the host: same
// kernel, so the flock still excludes a second run, and BusyBox in the
// image provides the `flock` command.
const BACKUP_RESTORE_LOCK_FILE_NAME = ".orbit-backup-restore.lock";

function ensurePrivateBackupDirectory(backupDirectory: string): void {
  mkdirSync(backupDirectory, { recursive: true });
  chmodSync(backupDirectory, SECURE_DIRECTORY_MODE);
  // #1211 E6: the engine runs as root inside the deployment; what it creates
  // on the host belongs to the operator.
  applyHostOwnership(backupDirectory);
}

function acquireBackupRestoreLock(backupDirectory: string): () => void {
  ensurePrivateBackupDirectory(backupDirectory);
  const lockPath = join(backupDirectory, BACKUP_RESTORE_LOCK_FILE_NAME);

  let fd: number;
  try {
    fd = openSync(lockPath, constants.O_CREAT | constants.O_WRONLY, 0o600);
    applyHostOwnership(lockPath);
  } catch {
    refuse("restore-locked", `Could not open the orbit backup/restore lock at ${lockPath}.`);
  }
  const result = spawnSync("flock", ["-n", "3"], { stdio: ["ignore", "pipe", "pipe", fd], encoding: "utf8" });
  if (result.status !== 0) {
    closeSync(fd);
    if ((result.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
      refuse(
        "restore-locked",
        "The `flock` command (util-linux) is required to take the orbit backup/restore lock, as scripts/backup.sh and scripts/restore.sh already require. Install util-linux and retry.",
      );
    }
    if (result.status === 1) {
      refuse(
        "restore-locked",
        `Another orbit backup or restore is already running against this backup directory (lock held at ${lockPath}). Wait for it to finish.`,
      );
    }
    const detail = result.error ? result.error.message : (result.stderr ?? "").trim();
    refuse("restore-locked", `Could not take the orbit backup/restore lock at ${lockPath}: ${detail || `flock exited with status ${String(result.status)}`}.`);
  }

  let released = false;
  return () => {
    if (released) return;
    released = true;
    closeSync(fd);
  };
}

// --- Ctrl-C scratch-directory cleanup (O1-R1) -------------------------------
//
// SIGINT/SIGTERM during a long docker/pg operation (createCheckpoint's dump,
// the recovery-bundle import's decrypt/restore) kills the process before any
// `finally` block gets a turn, leaving sensitive scratch material — a
// decrypted document KEK, a staged document tree — sitting in a private
// directory forever. This registers best-effort signal handlers for the
// lifetime of `fn` that remove `scratchDir` before re-raising the signal (so
// the process still ends the way the operator expects), on top of the
// ordinary `finally` cleanup already in place for a normal return or throw.
// src/cli/orbit.ts's own top-level scratch directories (commandBackup's
// --verify workDir, commandRestore's run workDir — both mkdtempSync(tmpdir())
// calls outside this module) are out of this module's reach and still need
// the same registration there.
function withScratchCleanupOnSignal<T>(scratchDir: string, fn: () => T): T {
  let cleaned = false;
  const cleanup = (): void => {
    if (cleaned) return;
    cleaned = true;
    rmSafely(scratchDir);
  };
  const onSignal = (signal: NodeJS.Signals): void => {
    cleanup();
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
    process.kill(process.pid, signal);
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  try {
    return fn();
  } finally {
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
  }
}

/**
 * restore.sh:886-889 (guarantee #44): both the private backup directory and
 * the restore-evidence directory must not be symlinks, checked before any
 * restore state is written; the backup directory is then created (if
 * missing) at the private 0700 mode, matching restore.sh's own `mkdir -p`+
 * `chmod 700` before any preflight work begins.
 */
function ensureBackupDirectorySafe(paths: RestorePaths): void {
  if (isSymlinkPath(paths.backupDirectory)) {
    refuse("backup-directory-unsafe", "preflight/configuration failed; the private backup directory must not be a symbolic link.");
  }
  ensurePrivateBackupDirectory(paths.backupDirectory);
  if (isSymlinkPath(paths.restoreRoot)) {
    refuse("backup-directory-unsafe", "preflight/configuration failed; the restore evidence directory must not be a symbolic link.");
  }
}

/** `date -u +%Y%m%d-%H%M%S` (backup.sh:12, export-recovery-bundle.sh:11) — the timestamp embedded in both bundles' file names. */
function formatBundleTimestamp(now: Date): string {
  const iso = now.toISOString();
  return `${iso.slice(0, 4)}${iso.slice(5, 7)}${iso.slice(8, 10)}-${iso.slice(11, 13)}${iso.slice(14, 16)}${iso.slice(17, 19)}`;
}

/** `date -u +%Y-%m-%dT%H:%M:%SZ` (backup.sh:162) — the manifest's own `created_at`, a separate `date` call in Bash and so intentionally computed independently here too (may differ from the filename timestamp by up to a second, matching the original). */
function formatManifestTimestamp(now: Date): string {
  return now.toISOString().replace(/\.\d{3}Z$/, "Z");
}

// ---------------------------------------------------------------------------
// backup.sh's validate_bundle (:102-133) end-to-end, composing recovery-
// bundle.ts's layer-1 layout/manifest/HMAC/checksum checks with its own
// pg_restore/document-archive completion — the single pipeline
// `orbit backup --verify`, restore.sh's own inline bundle load, and
// export-recovery-bundle.sh's source-bundle preflight (guarantee #4) all
// three call identically in Bash.
// ---------------------------------------------------------------------------

export interface VerifiedBackupBundle {
  extractedDir: string;
  manifestFields: BackupManifestFields;
}

/** `workDir` is caller-owned scratch space (not yet containing `extracted/`), matching this module's existing extractedDir convention. */
export function verifyBackupBundle(
  bundlePath: string,
  documentKekHex: string,
  workDir: string,
  adapter: Pick<BackupDockerAdapter, "pgRestoreListOk">,
): VerifiedBackupBundle {
  requireRegularNonSymlinkFile(bundlePath, "The bundle must be a regular, non-symbolic-link file.");
  validateBackupBundleLayout(bundlePath);
  const extractedDir = join(workDir, "extracted");
  mkdirSync(extractedDir, { recursive: true });
  extractTar(bundlePath, extractedDir);
  const manifestFields = validateBackupBundleContents(extractedDir, documentKekHex, adapter);
  return { extractedDir, manifestFields };
}

// ---------------------------------------------------------------------------
// orbit backup — create_bundle's outer wrapper (backup.sh:135-179): timestamp
// and private-work-directory setup around createBackupBundle, which already
// ports create_bundle's own body end-to-end (slice 2).
// ---------------------------------------------------------------------------

export interface RunBackupOptions {
  backupDirectory: string;
  /** The live key, or how to read it: a reader is called only once the lock is held (#1151 RANGE-R7, backup.sh's lock-then-read order). */
  documentKekHex: string | (() => string);
  adapter: BackupDockerAdapter;
  now: Date;
}

export function runBackup(options: RunBackupOptions): CreateBackupBundleResult {
  // #1151 RANGE-R6/RANGE-S3: taken before anything else, same as runRestore
  // — otherwise a backup's own stopApp/startApp (inside createBackupBundle)
  // can race a concurrent restore's document-tree/database cutover.
  const releaseLock = acquireBackupRestoreLock(options.backupDirectory);
  try {
    // #1151 RANGE-R7: read only now, under the lock — an import's two-rename
    // key swap (taken under the same lock) can leave the live key file
    // briefly absent.
    const documentKekHex = typeof options.documentKekHex === "function" ? options.documentKekHex() : options.documentKekHex;
    const finalTarPath = join(options.backupDirectory, `orbit-${formatBundleTimestamp(options.now)}.tar`);
    return createBackupBundle(options.backupDirectory, finalTarPath, documentKekHex, options.adapter, formatManifestTimestamp(options.now));
  } finally {
    releaseLock();
  }
}

// ---------------------------------------------------------------------------
// restore.sh's prepare_staged_bundle (:334-353, guarantees #7-10): the
// private-staging preflight, entirely before capacity/confirmation/cutover.
// ---------------------------------------------------------------------------

export interface StagedRestoreBundle {
  extractedDir: string;
  stagedDocumentsRoot: string;
  manifestFields: BackupManifestFields;
}

export function stageAndPreflightRestoreBundle(
  backupTarPath: string,
  documentKekHex: string,
  workDir: string,
  adapter: Pick<RestoreDockerAdapter, "pgRestoreListOk" | "createStageDatabase" | "dropStageDatabase" | "restoreDumpToDatabase" | "queryReport">,
  stagingId: string,
): StagedRestoreBundle {
  const { extractedDir, manifestFields } = verifyBackupBundle(backupTarPath, documentKekHex, workDir, adapter);
  const stagedDocumentsRoot = join(workDir, "staged-documents");
  mkdirSync(stagedDocumentsRoot, { recursive: true });
  try {
    extractTar(join(extractedDir, "documents.tar"), stagedDocumentsRoot);
  } catch {
    refuse("staging-failed", "preflight/staging failed; the document tree could not be staged privately.");
  }
  preflightValidateBundle({ adapter, databaseDumpPath: join(extractedDir, "database.dump"), stagedDocumentsRoot, stagingId });
  return { extractedDir, stagedDocumentsRoot, manifestFields };
}

// ---------------------------------------------------------------------------
// orbit restore — restore.sh's main flow (:897-933): staged preflight ->
// check_capacity (slice 4, guarantees #11-12) -> confirmation gate
// (guarantee #46, invoked at exactly restore.sh's own confirmation point —
// the CLI layer owns the actual prompt/machine-prompt/--yes mechanism) ->
// RestoreRun's checkpoint/cutover/finalize, with dispose() always run (the
// `cleanup` EXIT-trap equivalent), matching restore.sh's own
// trap-always-fires discipline.
// ---------------------------------------------------------------------------

export interface RestoreOrchestrationTestHooks {
  /** Fires immediately after createCheckpoint() completes — the rehearsal harness's SIGKILL point, matching restore.sh's own `ORBIT_RESTORE_TEST_HARD_INTERRUPT_STAGE=after-checkpoint`. */
  afterCheckpoint?: () => void;
  afterDocumentsReplaced?: () => void;
  afterDatabaseRestored?: () => void;
}

export interface RunRestoreOptions {
  backupTarPath: string;
  documentKekHex: string;
  paths: RestorePaths;
  adapter: RestoreDockerAdapter;
  /** Caller-owned scratch directory for this whole run (staging, capacity probing, and RestoreRun's own workDir all live under it); removed by the caller after this function returns or throws. */
  workDir: string;
  /**
   * guarantee #46: destructive restore requires explicit operator opt-in.
   * Invoked exactly once, at the same point restore.sh itself prompts
   * (:903-910) — after the staged-bundle preflight and capacity check both
   * pass, immediately before the checkpoint (the first live mutation) is
   * taken — never before, so an operator is never asked to confirm a
   * restore that preflight/capacity would have refused anyway, and never
   * after any live state has changed.
   */
  confirm: () => boolean;
  /** ORBIT_RESTORE_ROLLBACK_KEK_FILE equivalent (import-recovery-bundle.sh's key-swap safety net). */
  rollbackDocumentKekFile?: string;
  hooks?: RestoreDurabilityHooks;
  testHooks?: RestoreOrchestrationTestHooks;
  /** The caller already holds the backup/restore lock (runImportRecoveryBundle takes it before swapping the key, as import-recovery-bundle.sh did). */
  lockHeld?: boolean;
}

export function runRestore(options: RunRestoreOptions): RestoreDisposeResult | { outcome: "completed" } {
  // O2-R7: taken before anything else, including the journal-exists check
  // below — the journal written at the end of checkpointing was the only
  // thing stopping two concurrent restores, and both could pass that check
  // before either got far enough to write it.
  const releaseLock = options.lockHeld ? () => undefined : acquireBackupRestoreLock(options.paths.backupDirectory);
  try {
    return withScratchCleanupOnSignal(options.workDir, () => runRestoreLocked(options));
  } finally {
    releaseLock();
  }
}

function runRestoreLocked(options: RunRestoreOptions): RestoreDisposeResult | { outcome: "completed" } {
  ensureBackupDirectorySafe(options.paths);
  if (existsSync(options.paths.journalPath)) {
    refuse("restore-journal-exists", "preflight/journal failed; an unfinished restore exists; run bash scripts/restore.sh --recover before starting a new restore.");
  }

  const stagingWorkDir = join(options.workDir, "staging");
  mkdirSync(stagingWorkDir, { recursive: true });
  const stagingId = `${Date.now()}_${process.pid}`;
  const staged = stageAndPreflightRestoreBundle(options.backupTarPath, options.documentKekHex, stagingWorkDir, options.adapter, stagingId);

  checkRestoreCapacity({
    stagedDocumentsKib: directoryUsageKib(staged.stagedDocumentsRoot),
    backupBytes: statSync(options.backupTarPath).size,
    currentDatabaseBytes: options.adapter.measureLiveDatabaseSizeBytes(),
    currentDocumentKib: options.adapter.measureLiveDocumentTreeKib(),
    hostAvailableKib: filesystemAvailableKib(options.paths.backupDirectory),
    tempAvailableKib: filesystemAvailableKib(stagingWorkDir),
    volumeAvailableKib: options.adapter.measureDocumentVolumeAvailableKib(),
  });

  if (!options.confirm()) {
    refuse("restore-not-confirmed", "confirmation failed; restore cancelled.");
  }

  const runWorkDir = join(options.workDir, "run");
  mkdirSync(runWorkDir, { recursive: true });
  const run = RestoreRun.prepare({
    adapter: options.adapter,
    paths: options.paths,
    workDir: runWorkDir,
    rollbackDocumentKekFile: options.rollbackDocumentKekFile,
    hooks: options.hooks,
  });

  try {
    run.createCheckpoint();
    options.testHooks?.afterCheckpoint?.();

    run.cutoverDocuments(join(staged.extractedDir, "documents.tar"));
    options.testHooks?.afterDocumentsReplaced?.();

    run.cutoverDatabase(join(staged.extractedDir, "database.dump"));
    options.testHooks?.afterDatabaseRestored?.();

    run.finalize();
    return { outcome: "completed" };
  } finally {
    // dispose() is the `cleanup` EXIT-trap equivalent: always runs, success or
    // failure (restore.sh's `trap cleanup EXIT` fires unconditionally); safe
    // to call after a successful finalize() too (RestoreRun.dispose() is
    // idempotent and, once completed=true, only removes runWorkDir).
    run.dispose();
  }
}

// ---------------------------------------------------------------------------
// orbit export-recovery-bundle — export-recovery-bundle.sh's orchestration
// (:1-70): verify the source bundle passes full backup.sh --verify
// (guarantee #4), wrap the document KEK in a passphrase envelope, and
// package/publish the four-member recovery bundle.
// ---------------------------------------------------------------------------

export interface RunExportRecoveryBundleOptions {
  sourceBundlePath: string;
  documentKekHex: string;
  /** Both entries, already collected; or `collectPassphrase` instead, called only once the source bundle has passed verification (export-recovery-bundle.sh's order). */
  passphrase?: string;
  passphraseConfirmation?: string;
  /** Returns a passphrase it has already had confirmed. */
  collectPassphrase?: () => string;
  backupDirectory: string;
  adapter: Pick<BackupDockerAdapter, "pgRestoreListOk" | "recordRecoveryBundleExported">;
  now: Date;
}

export function runExportRecoveryBundle(options: RunExportRecoveryBundleOptions): { finalPath: string } {
  requireRegularNonSymlinkFile(options.sourceBundlePath, "Usage: orbit export-recovery-bundle <backup.tar>");
  ensurePrivateBackupDirectory(options.backupDirectory);
  const workDir = mkdtempSync(join(options.backupDirectory, ".orbit-recovery."));
  applyHostOwnership(workDir);
  try {
    return withScratchCleanupOnSignal(workDir, () => {
      // guarantee #4: the source backup bundle must pass full verification
      // before a recovery bundle is produced from it.
      verifyBackupBundle(options.sourceBundlePath, options.documentKekHex, join(workDir, "verify"), options.adapter);

      const passphrase = options.collectPassphrase ? options.collectPassphrase() : (options.passphrase ?? "");
      requireValidPassphrase(passphrase);
      requireMatchingPassphrase(passphrase, options.collectPassphrase ? passphrase : (options.passphraseConfirmation ?? ""));

      const innerBundlePath = join(workDir, "orbit-backup.tar");
      copyFileSync(options.sourceBundlePath, innerBundlePath);

      const envelope = encryptDocumentKek(options.documentKekHex, passphrase);
      const envelopePath = join(workDir, "document-kek.enc");
      writeSecretFile(envelopePath, envelope, SECURE_FILE_MODE);

      const manifestPath = join(workDir, "manifest");
      writeSecretFile(manifestPath, buildRecoveryManifest(), SECURE_FILE_MODE);

      const checksums = `${sha256File(innerBundlePath)}  orbit-backup.tar\n${sha256File(envelopePath)}  document-kek.enc\n`;
      writeSecretFile(join(workDir, "checksums.sha256"), checksums, SECURE_FILE_MODE);

      const finalPath = join(options.backupDirectory, `orbit-recovery-${formatBundleTimestamp(options.now)}.tar`);
      const temporaryPath = `${finalPath}.installing`;
      createTar(workDir, temporaryPath, [...RECOVERY_BUNDLE_MEMBERS]);
      publishBundleAtomically(temporaryPath, finalPath);
      // #968: the bundle is on disk before the administration card can clear,
      // never the other way round — a failed record here still leaves a
      // usable bundle at finalPath, so this throws rather than swallowing the
      // failure (RunExportRecoveryBundleOptions.adapter's own doc comment).
      options.adapter.recordRecoveryBundleExported();
      return { finalPath };
    });
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// orbit import-recovery-bundle — import-recovery-bundle.sh's orchestration
// (:1-121): validate the recovery bundle, decrypt the wrapped document KEK,
// swap the live key with an automatic-rollback safety net, and drive the
// inner backup bundle through the same runRestore() every direct `orbit
// restore` invocation uses (ORBIT_RESTORE_ROLLBACK_KEK_FILE's callee-side
// seam, restore-engine.ts's `rollbackDocumentKekFile` option, wired to its
// real caller for the first time in this slice).
// ---------------------------------------------------------------------------

export interface RunImportRecoveryBundleOptions {
  recoveryBundlePath: string;
  /** The passphrase, or how to ask for it: a collector is called only once the archive, manifest and checksums have passed (import-recovery-bundle.sh's order). */
  passphrase: string | (() => string);
  liveDocumentKekFile: string;
  backupDirectory: string;
  adapter: RestoreDockerAdapter;
  /** import-recovery-bundle.sh guarantee #19: "Type IMPORT RECOVERY to continue". A callback is asked only once the recovered key has decrypted. */
  importConfirmed: boolean | (() => boolean);
  /** Runs once confirmed, before anything is changed (the CLI's PostgreSQL client check). */
  beforeRestore?: () => void;
  /** restore.sh guarantee #46, re-prompted by the inner restore.sh invocation (import-recovery-bundle.sh:105 passes neither `--yes` nor `ORBIT_NONINTERACTIVE_RESTORE`, so the inner script always re-confirms interactively) — a genuinely separate gate from `importConfirmed`, not a duplicate of it; see runRestore's `confirm` for why this is a callback, not a precomputed boolean. */
  confirmRestore: () => boolean;
  hooks?: RestoreDurabilityHooks;
  testHooks?: RestoreOrchestrationTestHooks;
}

/**
 * `renameSync`, falling back to copy+fsync+unlink on EXDEV. The live
 * document KEK lives under the deployment directory while `workDir` is
 * `mkdtempSync(join(tmpdir(), ...))` — on Debian 13, Ubuntu 24.04+ and
 * Fedora, /tmp is tmpfs by default, a different filesystem from the
 * deployment directory, so a plain `renameSync` throws EXDEV
 * (issue #383). Mirrors writeRestoreJournal's (restore-engine.ts)
 * temp-then-publish durability shape: write the copy at its final secure
 * mode before any byte lands (writeSecretFile), fsync its data, then remove
 * the source — never leaving two live copies of key material if a step
 * after the copy throws.
 */
function renameSecretFileAcrossDevices(sourcePath: string, destinationPath: string): void {
  try {
    renameSync(sourcePath, destinationPath);
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EXDEV") {
      throw error;
    }
  }
  const descriptor = openSync(sourcePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  let content: Buffer;
  try {
    content = readFileSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  writeSecretFile(destinationPath, content, SECURE_FILE_MODE);
  const destinationDescriptor = openSync(destinationPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    fsyncSync(destinationDescriptor);
  } finally {
    closeSync(destinationDescriptor);
  }
  unlinkSync(sourcePath);
}

/**
 * Mirrors import-recovery-bundle.sh's own binary outside view: either the
 * whole import completed, or it failed and threw — there is no partial
 * "resolved but not completed" return value, matching the Bash script's own
 * always-exit-1-on-any-inner-failure shape (rolled-back vs. rollback-failed
 * vs. manual-recovery-required are RestoreRun.dispose()'s internal
 * distinctions, already fully handled inside runRestore()).
 */
export function runImportRecoveryBundle(options: RunImportRecoveryBundleOptions): { outcome: "completed" } {
  requireRegularNonSymlinkFile(options.recoveryBundlePath, "Usage: bash scripts/import-recovery-bundle.sh <recovery.tar>");
  const paths = deriveRestorePaths(options.backupDirectory, options.liveDocumentKekFile);
  if (existsSync(paths.journalPath)) {
    refuse(
      "restore-journal-exists",
      "preflight/journal failed; an unfinished restore exists; run bash scripts/restore.sh --recover before importing another recovery bundle.",
    );
  }
  // SS1-S3: never swap DOCUMENT_KEK under an open rotation. Checked here,
  // again after the prompts (which can sit open for as long as the operator
  // takes) and once more with the lock held, as import-recovery-bundle.sh did.
  refuseIfDocumentKekRotationOpen(options.liveDocumentKekFile);

  // O2-S3: staged inside the install's own directory (a sibling of the live
  // document KEK file itself), not under workDir/tmpdir() — guaranteed same
  // filesystem as options.liveDocumentKekFile, and never removed by
  // workDir's own cleanup below. A previous failed import that could not
  // revert leaves this file *here*, where the next run (and an operator)
  // will find it, rather than it vanishing with a deleted scratch
  // directory. A leftover from an earlier failed import is refused rather
  // than silently reused or overwritten.
  const previousKekPath = `${options.liveDocumentKekFile}.import-rollback`;
  if (existsSync(previousKekPath)) {
    refuse(
      "rollback-conflict",
      `${previousKekPath} already exists, left over from a previous import that could not fully revert. Resolve it by hand (confirm whether it is the document KEK Orbit should be using, then move or remove it) before importing another recovery bundle.`,
    );
  }

  const workDir = mkdtempSync(join(tmpdir(), "orbit-recovery-import-"));
  try {
    return withScratchCleanupOnSignal(workDir, () => {
      const extractedDir = join(workDir, "extracted");
      preflightRecoveryBundle(options.recoveryBundlePath, extractedDir);

      const passphrase = typeof options.passphrase === "function" ? options.passphrase() : options.passphrase;
      const envelope = readFileSync(join(extractedDir, "document-kek.enc"));
      // decryptDocumentKek already refuses (invalid-recovered-key) a plaintext
      // that isn't a well-formed 64-hex document key, so no separate re-check
      // is needed here.
      let recoveredKekHex: string;
      try {
        recoveredKekHex = decryptDocumentKek(envelope, passphrase)
          .toString("utf8")
          .replace(/[\r\n]+$/, "");
      } catch (error) {
        if (error instanceof RecoveryBundleRefusal && error.code === "invalid-recovered-key") {
          refuse("import-preflight-failed", "Recovery passphrase did not decrypt a valid document KEK.");
        }
        refuse("import-preflight-failed", "preflight/decryption failed; the recovery key could not be decrypted.");
      }

      const confirmed = typeof options.importConfirmed === "function" ? options.importConfirmed() : options.importConfirmed;
      if (!confirmed) {
        refuse("import-not-confirmed", "Recovery import cancelled.");
      }
      refuseIfDocumentKekRotationOpen(options.liveDocumentKekFile);
      // Taken here, before the app stop and key swap, not left to the inner
      // restore: a backup landing in that gap would otherwise encrypt a
      // bundle with the swapped key (import-recovery-bundle.sh's own lock).
      const releaseLock = acquireBackupRestoreLock(options.backupDirectory);
      try {
        refuseIfDocumentKekRotationOpen(options.liveDocumentKekFile);
        requireRegularNonSymlinkFile(options.liveDocumentKekFile, "The current document KEK must be a regular file.");
        options.beforeRestore?.();
        return swapKeyAndRestore(options, paths, previousKekPath, recoveredKekHex, join(extractedDir, "orbit-backup.tar"), workDir);
      } finally {
        releaseLock();
      }
    });
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

/**
 * import-recovery-bundle.sh's archive preflight (guarantees #5-9), with its
 * stable categories: nothing from tar or the checksum file, and no member
 * name, reaches the operator (test_recovery_bundle_diagnostics).
 */
function preflightRecoveryBundle(recoveryBundlePath: string, extractedDir: string): void {
  const archiveMessages: Partial<Record<string, string>> = {
    "archive-invalid": "preflight/archive failed; the recovery bundle archive is invalid.",
    "unexpected-members": "preflight/archive failed; the recovery bundle does not contain the expected files.",
    "link-or-special-entry": "preflight/archive failed; the recovery bundle contains a link or special file.",
  };
  const asImportRefusal = (step: () => void, messages: Partial<Record<string, string>>, fallback: string): void => {
    try {
      step();
    } catch (error) {
      const code = error instanceof RecoveryBundleRefusal ? error.code : "";
      refuse("import-preflight-failed", messages[code] ?? fallback);
    }
  };
  asImportRefusal(() => validateRecoveryBundleLayout(recoveryBundlePath), archiveMessages, "preflight/archive failed; the recovery bundle archive is invalid.");
  asImportRefusal(
    () => {
      mkdirSync(extractedDir, { recursive: true });
      extractTar(recoveryBundlePath, extractedDir);
    },
    {},
    "preflight/archive failed; the recovery bundle could not be extracted.",
  );
  asImportRefusal(() => validateRecoveryManifestFormatVersion(extractedDir), {}, "preflight/manifest failed; the recovery bundle format is unsupported.");
  asImportRefusal(() => verifyRecoveryBundleChecksums(extractedDir), {}, "preflight/checksum failed; a recovery bundle member is corrupt.");
}

function swapKeyAndRestore(
  options: RunImportRecoveryBundleOptions,
  paths: RestorePaths,
  previousKekPath: string,
  recoveredKekHex: string,
  innerBundlePath: string,
  workDir: string,
): { outcome: "completed" } {
  // O2-F3: a failed stop must abort before the key swap. Proceeding
  // would swap the live document KEK while the app may still be
  // reading documents under the old one.
  if (!options.adapter.stopApp()) {
    refuse("app-stop-failed", "The Orbit application could not be stopped; the document KEK was not changed.");
  }
  const restoreWorkDir = mkdtempSync(join(workDir, "restore-"));
  try {
    renameSecretFileAcrossDevices(options.liveDocumentKekFile, previousKekPath);
    writeSecretFile(options.liveDocumentKekFile, `${recoveredKekHex}\n`, SECURE_FILE_MODE);

    runRestore({
      backupTarPath: innerBundlePath,
      documentKekHex: recoveredKekHex,
      paths,
      adapter: options.adapter,
      workDir: restoreWorkDir,
      confirm: options.confirmRestore,
      rollbackDocumentKekFile: previousKekPath,
      hooks: options.hooks,
      testHooks: options.testHooks,
      lockHeld: true,
    });
    // Success: the previous key is no longer needed.
    rmSafely(previousKekPath);
    return { outcome: "completed" };
  } catch (error) {
    if (existsSync(paths.journalPath)) {
      // The inner restore left durable recovery evidence (a verified
      // checkpoint survived, per RestoreRun.dispose()'s own
      // manual-recovery-required/rollback-failed branches) — do not touch
      // the key further; the operator must run `restore.sh --recover`.
      refuse("restore-unfinished", "Inner backup restore left durable recovery evidence; run bash scripts/restore.sh --recover.");
    }
    // No journal: the inner restore never got far enough to leave
    // evidence (e.g. capacity/correspondence preflight failed) — revert
    // the key swap and restart the app, keeping the prior deployment usable.
    let revertFailed = false;
    try {
      renameSecretFileAcrossDevices(previousKekPath, options.liveDocumentKekFile);
    } catch {
      revertFailed = true;
    }
    options.adapter.startApp();
    if (revertFailed) {
      // O2-S3: never silently lose the old key — it is still sitting at
      // previousKekPath (outside workDir, so the `finally` below never
      // touches it), and the operator is told exactly where.
      const originalMessage = error instanceof Error ? error.message : String(error);
      refuse(
        "live-key-invalid",
        `Import failed (${originalMessage}) and the previous document KEK could not be restored to ${options.liveDocumentKekFile}; it is preserved at ${previousKekPath}. Restore it by hand before using Orbit again.`,
      );
    }
    throw error;
  }
}
