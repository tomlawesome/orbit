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

import {
  type BackupDockerAdapter,
  type BackupManifestFields,
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
  | "backup-directory-unsafe";

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
    rmSync(path, { force: true });
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
  mkdirSync(paths.backupDirectory, { recursive: true });
  chmodSync(paths.backupDirectory, SECURE_DIRECTORY_MODE);
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
  documentKekHex: string;
  adapter: BackupDockerAdapter;
  now: Date;
}

export function runBackup(options: RunBackupOptions): CreateBackupBundleResult {
  mkdirSync(options.backupDirectory, { recursive: true });
  chmodSync(options.backupDirectory, SECURE_DIRECTORY_MODE);
  const finalTarPath = join(options.backupDirectory, `orbit-${formatBundleTimestamp(options.now)}.tar`);
  return createBackupBundle(options.backupDirectory, finalTarPath, options.documentKekHex, options.adapter, formatManifestTimestamp(options.now));
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
}

export function runRestore(options: RunRestoreOptions): RestoreDisposeResult | { outcome: "completed" } {
  ensureBackupDirectorySafe(options.paths);
  if (existsSync(options.paths.journalPath)) {
    refuse("restore-journal-exists", "preflight/journal failed; an unfinished restore exists; run restore --recover before starting a new restore.");
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
  passphrase: string;
  passphraseConfirmation: string;
  backupDirectory: string;
  adapter: Pick<BackupDockerAdapter, "pgRestoreListOk">;
  now: Date;
}

export function runExportRecoveryBundle(options: RunExportRecoveryBundleOptions): { finalPath: string } {
  requireRegularNonSymlinkFile(options.sourceBundlePath, "Usage: orbit export-recovery-bundle <backup.tar>");
  mkdirSync(options.backupDirectory, { recursive: true });
  chmodSync(options.backupDirectory, SECURE_DIRECTORY_MODE);
  const workDir = mkdtempSync(join(options.backupDirectory, ".orbit-recovery."));
  try {
    // guarantee #4: the source backup bundle must pass full verification
    // before a recovery bundle is produced from it.
    verifyBackupBundle(options.sourceBundlePath, options.documentKekHex, join(workDir, "verify"), options.adapter);

    requireValidPassphrase(options.passphrase);
    requireMatchingPassphrase(options.passphrase, options.passphraseConfirmation);

    const innerBundlePath = join(workDir, "orbit-backup.tar");
    copyFileSync(options.sourceBundlePath, innerBundlePath);

    const envelope = encryptDocumentKek(options.documentKekHex, options.passphrase);
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
    return { finalPath };
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
  passphrase: string;
  liveDocumentKekFile: string;
  backupDirectory: string;
  adapter: RestoreDockerAdapter;
  /** import-recovery-bundle.sh guarantee #19: "Type IMPORT RECOVERY to continue". */
  importConfirmed: boolean;
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
  requireRegularNonSymlinkFile(options.recoveryBundlePath, "Usage: orbit import-recovery-bundle <recovery.tar>");
  const paths = deriveRestorePaths(options.backupDirectory, options.liveDocumentKekFile);
  if (existsSync(paths.journalPath)) {
    refuse(
      "restore-journal-exists",
      "preflight/journal failed; an unfinished restore exists; run restore --recover before importing another recovery bundle.",
    );
  }

  const workDir = mkdtempSync(join(tmpdir(), "orbit-recovery-import-"));
  try {
    validateRecoveryBundleLayout(options.recoveryBundlePath);
    const extractedDir = join(workDir, "extracted");
    mkdirSync(extractedDir, { recursive: true });
    extractTar(options.recoveryBundlePath, extractedDir);
    validateRecoveryManifestFormatVersion(extractedDir);
    verifyRecoveryBundleChecksums(extractedDir);

    const envelope = readFileSync(join(extractedDir, "document-kek.enc"));
    // decryptDocumentKek already refuses (invalid-recovered-key) a plaintext
    // that isn't a well-formed 64-hex document key, so no separate re-check
    // is needed here.
    const recoveredKekHex = decryptDocumentKek(envelope, options.passphrase)
      .toString("utf8")
      .replace(/[\r\n]+$/, "");

    if (!options.importConfirmed) {
      refuse("import-not-confirmed", "Recovery import cancelled.");
    }
    requireRegularNonSymlinkFile(options.liveDocumentKekFile, "The current document KEK must be a regular file.");

    options.adapter.stopApp();
    const previousKekPath = join(workDir, "previous-document-kek");
    const restoreWorkDir = mkdtempSync(join(workDir, "restore-"));
    try {
      renameSecretFileAcrossDevices(options.liveDocumentKekFile, previousKekPath);
      writeSecretFile(options.liveDocumentKekFile, `${recoveredKekHex}\n`, SECURE_FILE_MODE);

      runRestore({
        backupTarPath: join(extractedDir, "orbit-backup.tar"),
        documentKekHex: recoveredKekHex,
        paths,
        adapter: options.adapter,
        workDir: restoreWorkDir,
        confirm: options.confirmRestore,
        rollbackDocumentKekFile: previousKekPath,
        hooks: options.hooks,
        testHooks: options.testHooks,
      });
      // Success: the previous key is no longer needed.
      rmSafely(previousKekPath);
      return { outcome: "completed" };
    } catch (error) {
      if (existsSync(paths.journalPath)) {
        // The inner restore left durable recovery evidence (a verified
        // checkpoint survived, per RestoreRun.dispose()'s own
        // manual-recovery-required/rollback-failed branches) — do not touch
        // the key further; the operator must run `orbit restore --recover`.
        refuse("restore-unfinished", "Inner backup restore left durable recovery evidence; run restore --recover.");
      }
      // No journal: the inner restore never got far enough to leave
      // evidence (e.g. capacity/correspondence preflight failed) — revert
      // the key swap and restart the app, keeping the prior deployment usable.
      try {
        renameSecretFileAcrossDevices(previousKekPath, options.liveDocumentKekFile);
      } catch {
        // Best-effort, matching import-recovery-bundle.sh:26's `mv -f ... || true`.
      }
      options.adapter.startApp();
      throw error;
    }
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}
