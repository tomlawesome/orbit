import { spawnSync } from "node:child_process";
import {
  chmodSync,
  closeSync,
  constants,
  copyFileSync,
  fdatasyncSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";

import {
  type BackupDockerAdapter,
  type DockerComposeAdapterOptions,
  SECURE_DIRECTORY_MODE,
  SECURE_FILE_MODE,
  createDockerComposeBackupAdapter,
  extractTar,
  isRegularNonSymlinkFile,
  isValidDocumentKekHex,
  listTarEntriesVerbose,
  sha256File,
  validateDocumentArchiveEntries,
  writeSecretFile,
} from "./recovery-bundle";

// The transactional restore engine (issue #296 slice 3), ported from
// scripts/restore.sh's checkpoint/journal/rollback state machine
// (create_checkpoint, write_journal, rollback_checkpoint, recover_restore,
// the `cleanup` EXIT trap) and validate_correspondence's database-row-to-
// document-blob referential integrity checks — the single highest-blast-
// radius piece of issue #296 ("the only flow that mutates the live database
// and document volume"), per docs/adr-notes/296-backup-port-plan.md.
//
// This is the direct analogue of src/lib/install-transaction.ts
// (InstallTransaction), but with a durable, crash-recoverable journal on
// top: restore.sh already survives a hard SIGKILL via its own `--recover`
// path (verified by scripts/test-backup-restore.sh's
// test_hard_interruption_recovery), and this module preserves that exactly
// — RestoreRun.dispose() is the `cleanup` EXIT-trap equivalent, and
// recoverRestore() is the `--recover` entry point equivalent. Every
// guarantee number cited below is from docs/installer-guarantees.md, Part
// 2 / restore.sh, and is re-asserted by name in the *.test.ts files
// alongside this module.
//
// Pure filesystem/crypto logic except where RestoreDockerAdapter is
// injected for the operations that genuinely need a live Docker/Postgres
// deployment, mirroring recovery-bundle.ts's BackupDockerAdapter shape.
// check_capacity (restore.sh #11-12) is deliberately out of scope for this
// slice — see Flags in docs/adr-notes/296-backup-port-plan.md.
//
// No shipped entry point reaches this module in this slice: it is wired
// only to the hidden `orbit __restore-engine-rehearse` subcommand
// (src/cli/orbit.ts), used solely for the SIGKILL interruption
// characterization test in restore-engine.interruption.test.ts — the same
// pattern install-transaction.ts uses for #295 slice 1.

// ---------------------------------------------------------------------------
// Refusals
// ---------------------------------------------------------------------------

export type RestoreEngineRefusalCode =
  | "journal-path-unsafe"
  | "journal-missing"
  | "journal-invalid"
  | "journal-durability-failed"
  | "checkpoint-missing"
  | "checkpoint-incomplete"
  | "checkpoint-integrity-failed"
  | "checkpoint-key-invalid"
  | "checkpoint-database-invalid"
  | "checkpoint-verification-failed"
  | "stage-database-failed"
  | "app-stop-failed"
  | "cutover-documents-failed"
  | "cutover-database-failed"
  | "cutover-recovery-jobs-failed"
  | "active-correspondence-failed"
  | "health-check-failed"
  | "preflight-correspondence-failed"
  | "query-report-failed"
  | "recovery-restore-failed"
  | "recovery-health-failed";

/**
 * Thrown for every fail-closed refusal this module makes. Never carries
 * secret material (document KEK, passphrases) or attacker-controlled
 * member/path names — mirroring restore.sh's own stable, category-only
 * diagnostic strings (`checkpoint/journal failed`, `recovery/integrity
 * failed`, etc.) and RecoveryBundleRefusal's existing discipline.
 */
export class RestoreEngineRefusal extends Error {
  readonly code: RestoreEngineRefusalCode;

  constructor(message: string, code: RestoreEngineRefusalCode) {
    super(message);
    this.name = "RestoreEngineRefusal";
    this.code = code;
  }
}

function refuse(code: RestoreEngineRefusalCode, message: string): never {
  throw new RestoreEngineRefusal(message, code);
}

// ---------------------------------------------------------------------------
// Shared filesystem helpers
// ---------------------------------------------------------------------------

const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;

function isSymlinkPath(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

function isRealNonSymlinkDirectory(path: string): boolean {
  try {
    return lstatSync(path).isDirectory();
  } catch {
    return false;
  }
}

function rmSafely(path: string): void {
  try {
    rmSync(path, { force: true });
  } catch {
    // Best-effort, matches restore.sh's own `rm -f -- "$path" >/dev/null 2>&1 || true`.
  }
}

/**
 * Opens `path` with a single O_NOFOLLOW descriptor and reads it whole — no
 * separate stat-then-open/read pair, so there is no window between checking
 * the path is not a symlink and reading its content (CodeQL
 * js/file-system-race), matching recovery-bundle.ts's own
 * readRegularFileNoFollow discipline.
 */
function readFileNoFollow(path: string): Buffer {
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    return readFileSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

/** Single-descriptor regular-file-size check (open O_NOFOLLOW + fstat), never a separate lstat-then-stat pair. */
function regularFileSizeNoFollow(path: string): number | undefined {
  let descriptor: number;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    return undefined;
  }
  try {
    const stat = fstatSync(descriptor);
    return stat.isFile() ? stat.size : undefined;
  } finally {
    closeSync(descriptor);
  }
}

/** `sync -d <path> || sync <path>` — data-sync a file/directory's fd, falling back to a full sync (restore.sh:415-428,442-452). */
function fsyncPath(path: string, hook?: () => void): void {
  if (hook) hook();
  const descriptor = openSync(path, constants.O_RDONLY);
  try {
    try {
      fdatasyncSync(descriptor);
    } catch {
      fsyncSync(descriptor);
    }
  } finally {
    closeSync(descriptor);
  }
}

// ---------------------------------------------------------------------------
// Restore journal (restore.sh:467-506 write_journal / :772-796 load_recovery_journal)
// ---------------------------------------------------------------------------

export const RESTORE_JOURNAL_FORMAT_VERSION = "1";

export type RestoreJournalState = "checkpointed" | "documents-replaced" | "database-restored" | "rollback-failed";

const RESTORE_JOURNAL_STATES: readonly RestoreJournalState[] = [
  "checkpointed",
  "documents-replaced",
  "database-restored",
  "rollback-failed",
];

function isRestoreJournalState(value: string): value is RestoreJournalState {
  return (RESTORE_JOURNAL_STATES as readonly string[]).includes(value);
}

const RESTORE_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

export interface RestorePaths {
  backupDirectory: string;
  restoreRoot: string;
  journalPath: string;
  documentKekFile: string;
}

/** restore.sh:8-12's path derivation: `$backup_directory/.orbit-restore/restore.journal`. */
export function deriveRestorePaths(backupDirectory: string, documentKekFile: string): RestorePaths {
  const restoreRoot = join(backupDirectory, ".orbit-restore");
  return { backupDirectory, restoreRoot, journalPath: join(restoreRoot, "restore.journal"), documentKekFile };
}

export interface RestoreCheckpointDigests {
  databaseSha256: string;
  documentsSha256: string;
  documentKekSha256: string;
}

export interface RestoreJournalFields extends RestoreCheckpointDigests {
  restoreId: string;
  state: RestoreJournalState;
}

/**
 * Fault-injection seam for the durability-write tests: each hook is called
 * immediately before the corresponding real fsync attempt and may throw to
 * simulate that sync failing, without any environment variable or modified
 * Bash — the TS analogue of restore.sh's `ORBIT_RESTORE_TEST_SYNC_FAILURE_STAGE`.
 */
export interface RestoreDurabilityHooks {
  beforeJournalFileSync?: (state: RestoreJournalState) => void;
  beforeJournalDirectorySync?: (state: RestoreJournalState) => void;
  beforeCheckpointArtifactSync?: () => void;
  beforeCheckpointDirectorySync?: () => void;
}

/**
 * write_journal (restore.sh:467-506): writes the journal to a pid-suffixed
 * temp file, fsyncs its data (#15's symlink refusal, #16's digest-format
 * gate, part of #17), backs up any existing journal, renames atomically into
 * place, then fsyncs the containing directory — restoring the previous
 * journal (or removing the just-published one, if none existed) on a late
 * directory-sync failure rather than leaving a torn journal (#17). Never
 * partially publishes: every failure path removes its own temp evidence.
 */
export function writeRestoreJournal(
  paths: Pick<RestorePaths, "journalPath" | "restoreRoot">,
  fields: RestoreJournalFields,
  hooks: RestoreDurabilityHooks = {},
): void {
  if (isSymlinkPath(paths.journalPath)) {
    refuse("journal-path-unsafe", "checkpoint/journal failed; the recovery journal could not be durably published.");
  }
  const digests = [fields.databaseSha256, fields.documentsSha256, fields.documentKekSha256];
  if (!digests.every((value) => SHA256_HEX_PATTERN.test(value))) {
    refuse("checkpoint-integrity-failed", "checkpoint/integrity failed; checkpoint digests were not available for the recovery journal.");
  }

  const pid = process.pid;
  const journalTemp = join(paths.restoreRoot, `.restore.journal.${pid}`);
  const content =
    `format_version=${RESTORE_JOURNAL_FORMAT_VERSION}\n` +
    `restore_id=${fields.restoreId}\n` +
    `state=${fields.state}\n` +
    `database_sha256=${fields.databaseSha256}\n` +
    `documents_sha256=${fields.documentsSha256}\n` +
    `document_kek_sha256=${fields.documentKekSha256}\n`;
  writeSecretFile(journalTemp, content, SECURE_FILE_MODE);

  try {
    fsyncPath(journalTemp, () => hooks.beforeJournalFileSync?.(fields.state));
  } catch {
    rmSafely(journalTemp);
    refuse("journal-durability-failed", "checkpoint/journal failed; the recovery journal could not be durably published.");
  }

  let previousJournal: string | undefined;
  if (isRegularNonSymlinkFile(paths.journalPath)) {
    previousJournal = join(paths.restoreRoot, `.restore.journal.previous.${pid}`);
    try {
      copyFileSync(paths.journalPath, previousJournal);
      chmodSync(previousJournal, SECURE_FILE_MODE);
    } catch {
      rmSafely(journalTemp);
      refuse("journal-durability-failed", "checkpoint/journal failed; the recovery journal could not be durably published.");
    }
  }

  try {
    renameSync(journalTemp, paths.journalPath);
  } catch {
    rmSafely(journalTemp);
    if (previousJournal) rmSafely(previousJournal);
    refuse("journal-durability-failed", "checkpoint/journal failed; the recovery journal could not be durably published.");
  }

  try {
    fsyncPath(paths.restoreRoot, () => hooks.beforeJournalDirectorySync?.(fields.state));
  } catch {
    if (previousJournal) {
      try {
        renameSync(previousJournal, paths.journalPath);
      } catch {
        try {
          copyFileSync(previousJournal, paths.journalPath);
        } catch {
          // Best-effort restoration, matches restore.sh:497-498's own `|| true` fallback chain.
        }
      }
    } else {
      rmSafely(paths.journalPath);
    }
    if (previousJournal) rmSafely(previousJournal);
    refuse("journal-durability-failed", "checkpoint/journal failed; the recovery journal could not be durably published.");
  }

  if (previousJournal) rmSafely(previousJournal);
}

function readJournalField(content: string, key: string): string | undefined {
  const prefix = `${key}=`;
  for (const line of content.split("\n")) {
    if (line.startsWith(prefix)) return line.slice(prefix.length);
  }
  return undefined;
}

/**
 * load_recovery_journal (restore.sh:772-796): requires the journal to be a
 * regular, non-symlink, mode-600 file (single O_NOFOLLOW descriptor — no
 * stat-then-open race, unlike Bash's own separate `[[ -f ]]`+`stat` pair);
 * `restore_id`/`state` are strictly format/enum validated (#32); the three
 * checkpoint digests must already be valid 64-hex values (#33); and the
 * referenced checkpoint directory plus all three of its artifacts must exist
 * as regular, non-symlink files (#33) — every check runs before any of the
 * journal's claims are trusted.
 */
export function loadRestoreJournal(
  journalPath: string,
  restoreRoot: string,
): { fields: RestoreJournalFields; checkpointDirectory: string } {
  let descriptor: number;
  try {
    descriptor = openSync(journalPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    refuse("journal-missing", "recovery/journal failed; no unfinished restore evidence was found.");
  }
  let content: string;
  try {
    const stat = fstatSync(descriptor);
    if (!stat.isFile() || (stat.mode & 0o777) !== SECURE_FILE_MODE) {
      refuse("journal-invalid", "recovery/journal failed; the restore journal permissions are unsafe.");
    }
    content = readFileSync(descriptor, "utf8");
  } finally {
    closeSync(descriptor);
  }

  const restoreId = readJournalField(content, "restore_id") ?? "";
  const state = readJournalField(content, "state") ?? "";
  if (!RESTORE_ID_PATTERN.test(restoreId) || !isRestoreJournalState(state)) {
    refuse("journal-invalid", "recovery/journal failed; the restore journal is invalid and must be reviewed by an operator.");
  }

  const databaseSha256 = readJournalField(content, "database_sha256") ?? "";
  const documentsSha256 = readJournalField(content, "documents_sha256") ?? "";
  const documentKekSha256 = readJournalField(content, "document_kek_sha256") ?? "";
  if (![databaseSha256, documentsSha256, documentKekSha256].every((value) => SHA256_HEX_PATTERN.test(value))) {
    refuse(
      "checkpoint-integrity-failed",
      "recovery/integrity failed; the checkpoint journal digests are invalid; keep Orbit stopped and preserve the recovery evidence.",
    );
  }

  const checkpointDirectory = join(restoreRoot, `checkpoint-${restoreId}`);
  if (!isRealNonSymlinkDirectory(checkpointDirectory)) {
    refuse("checkpoint-missing", "recovery/checkpoint failed; the durable rollback checkpoint is missing.");
  }
  for (const member of ["database.dump", "documents.tar", "document-kek"]) {
    if (!isRegularNonSymlinkFile(join(checkpointDirectory, member))) {
      refuse("checkpoint-incomplete", "recovery/checkpoint failed; the durable rollback checkpoint is incomplete.");
    }
  }

  return {
    fields: { restoreId, state, databaseSha256, documentsSha256, documentKekSha256 },
    checkpointDirectory,
  };
}

// ---------------------------------------------------------------------------
// Checkpoint digests (restore.sh:399-413,454-465)
// ---------------------------------------------------------------------------

export function computeCheckpointDigests(checkpointDirectory: string): RestoreCheckpointDigests {
  return {
    databaseSha256: sha256File(join(checkpointDirectory, "database.dump")),
    documentsSha256: sha256File(join(checkpointDirectory, "documents.tar")),
    documentKekSha256: sha256File(join(checkpointDirectory, "document-kek")),
  };
}

/** validate_checkpoint_integrity (restore.sh:454-465): recomputes and compares all three digests. */
export function validateCheckpointIntegrity(checkpointDirectory: string, digests: RestoreCheckpointDigests): boolean {
  try {
    const current = computeCheckpointDigests(checkpointDirectory);
    return (
      current.databaseSha256 === digests.databaseSha256 &&
      current.documentsSha256 === digests.documentsSha256 &&
      current.documentKekSha256 === digests.documentKekSha256
    );
  } catch {
    return false;
  }
}

/** sync_checkpoint_artifacts (restore.sh:415-428): durably syncs the three artifacts, then the checkpoint directory itself. */
export function syncCheckpointArtifacts(checkpointDirectory: string, hooks: RestoreDurabilityHooks = {}): void {
  try {
    for (const member of ["database.dump", "documents.tar", "document-kek"]) {
      fsyncPath(join(checkpointDirectory, member), hooks.beforeCheckpointArtifactSync);
    }
    fsyncPath(checkpointDirectory, hooks.beforeCheckpointDirectorySync);
  } catch {
    refuse("checkpoint-integrity-failed", "checkpoint/integrity failed; checkpoint artifacts could not be durably synchronized.");
  }
}

function isValidCheckpointKeyFile(checkpointDirectory: string): boolean {
  const keyPath = join(checkpointDirectory, "document-kek");
  if (!isRegularNonSymlinkFile(keyPath)) return false;
  try {
    const content = readFileNoFollow(keyPath)
      .toString("utf8")
      .replace(/[\r\n]+$/, "");
    return isValidDocumentKekHex(content);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// validate_correspondence / validate_correspondence_reports (restore.sh:
// 205-332, 658-736) — database-row-to-document-blob referential integrity.
// The two Bash functions are near-duplicates of the same logic run against a
// private stage database vs. the live database (restore.sh's own internal
// duplication); consolidated here into one canonical function, the same
// simplification #296 slice 1 already made for backup.sh/restore.sh's
// duplicated bundle validators (see Flags, docs/adr-notes/296-backup-port-plan.md).
// ---------------------------------------------------------------------------

/** The exact `psql --tuples-only --no-align --field-separator="|"` queries restore.sh runs (:219-236,623-652), byte-for-byte. */
export const CORRESPONDENCE_QUERIES = {
  crypto:
    "SELECT c.document_id::text, c.storage_key, c.ciphertext_size::text, COALESCE(d.lifecycle::text, '<missing-document>') FROM document_crypto c LEFT JOIN documents d ON d.id = c.document_id ORDER BY c.storage_key;",
  visible:
    "SELECT d.id::text, d.lifecycle::text, COALESCE(c.storage_key, ''), COALESCE(c.ciphertext_size::text, '') FROM documents d LEFT JOIN document_crypto c ON c.document_id = d.id WHERE d.lifecycle IN ('available', 'pending_deletion') ORDER BY d.id;",
  attachments:
    "SELECT a.id::text, a.storage_key, a.ciphertext_size::text, a.key_id FROM imap_ingestion_attachments a WHERE a.status = 'stored' OR (a.status = 'assigned' AND a.purge_pending = true) ORDER BY a.storage_key;",
  staging: "SELECT s.storage_key, s.status FROM imap_ingestion_staging_objects s WHERE s.status IN ('pending', 'purge_pending') ORDER BY s.storage_key;",
  documentStaging:
    "SELECT s.document_id::text, s.storage_key, s.status, s.ciphertext_size::text FROM document_staging_objects s WHERE s.status IN ('pending', 'purge_pending') ORDER BY s.storage_key;",
  transientCount:
    "SELECT count(*)::text FROM documents d WHERE d.lifecycle IN ('receiving', 'validating', 'quarantined', 'encrypting') OR (d.lifecycle = 'scanning' AND NOT EXISTS (SELECT 1 FROM document_staging_objects s WHERE s.document_id = d.id));",
} as const;

/** reset_scan_recovery_leases's literal SQL (restore.sh:587), unmodified. */
export const SCAN_RECOVERY_LEASES_SQL =
  'exec psql --username="$POSTGRES_USER" --dbname="$POSTGRES_DB" --set=ON_ERROR_STOP=1 --command="BEGIN; UPDATE document_jobs AS job SET status = \'failed\', completed_at = NULL, locked_at = NULL, lease_expires_at = NULL, lease_token = NULL, last_error = COALESCE(job.last_error, \'scanner_failed\'), updated_at = now() FROM documents document WHERE job.document_id = document.id AND job.kind = \'scan\' AND job.status IN (\'pending\', \'retry\', \'processing\') AND job.attempts >= 5 AND document.lifecycle = \'scanning\' AND EXISTS (SELECT 1 FROM document_staging_objects stage WHERE stage.document_id = document.id AND stage.status = \'pending\'); UPDATE document_jobs AS job SET status = \'pending\', next_attempt_at = now(), locked_at = NULL, lease_expires_at = NULL, lease_token = NULL, completed_at = NULL, updated_at = now() FROM documents document WHERE job.document_id = document.id AND job.kind = \'scan\' AND job.status IN (\'pending\', \'retry\', \'processing\') AND job.attempts < 5 AND document.lifecycle = \'scanning\' AND EXISTS (SELECT 1 FROM document_staging_objects stage WHERE stage.document_id = document.id AND stage.status = \'pending\'); COMMIT;"';

export interface CorrespondenceReports {
  crypto: string;
  visible: string;
  attachments: string;
  staging: string;
  documentStaging: string;
  transientCount: string;
}

const STORAGE_KEY_PATTERN = /^[a-f0-9]{64}$/;
const POSITIVE_INT_PATTERN = /^[1-9][0-9]*$/;
const DOCUMENT_ID36_PATTERN = /^[0-9a-f-]{36}$/;
const PENDING_STATUS_PATTERN = /^(pending|purge_pending)$/;
const OBJECT_RELATIVE_PATTERN = /^([a-f0-9]{2})\/([a-f0-9]{2})\/([a-f0-9]{64})\.bin$/;
const STAGING_RELATIVE_PATTERN = /^([a-f0-9]{64})\.bin$/;

function splitReportLines(report: string): string[] {
  return report.split("\n").filter((line) => line.length > 0);
}

function objectPath(documentsRoot: string, storageKey: string): string {
  return join(documentsRoot, "objects", storageKey.slice(0, 2), storageKey.slice(2, 4), `${storageKey}.bin`);
}

function walkFiles(documentsRoot: string, subdirectory: string): Array<{ relativePath: string; size: number }> {
  const results: Array<{ relativePath: string; size: number }> = [];
  function recurse(directory: string, prefix: string): void {
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const absolute = join(directory, entry.name);
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        recurse(absolute, relative);
        continue;
      }
      const size = regularFileSizeNoFollow(absolute);
      if (size !== undefined) results.push({ relativePath: relative, size });
    }
  }
  recurse(join(documentsRoot, subdirectory), "");
  return results;
}

/**
 * validate_correspondence / validate_correspondence_reports (restore.sh:
 * 205-332,658-736): cross-checks every document/attachment/staging-object
 * database row against the actual on-disk blob (existence, non-symlink,
 * exact byte size, no duplicate storage-key reuse, no orphaned on-disk
 * objects) and refuses if any in-flight ("transient") document lifecycle
 * rows exist that a point-in-time backup can't safely represent (guarantee
 * #9). Returns false (never throws) on any mismatch, mirroring the Bash
 * function's own `return 1` — the caller supplies the fail-closed message
 * appropriate to its context (preflight/checkpoint/active all report
 * differently for the same underlying check).
 */
export function checkCorrespondence(reports: CorrespondenceReports, documentsRoot: string): boolean {
  if (reports.transientCount.replace(/\s/g, "") !== "0") return false;

  const referencedObjects = new Set<string>();
  const storedCounts = new Map<string, number>();

  for (const line of splitReportLines(reports.crypto)) {
    const [documentId, storageKey, ciphertextSize, lifecycle] = line.split("|");
    if (!documentId) continue;
    if (!STORAGE_KEY_PATTERN.test(storageKey) || !POSITIVE_INT_PATTERN.test(ciphertextSize) || lifecycle === "<missing-document>") {
      return false;
    }
    if (referencedObjects.has(storageKey)) return false;
    const size = regularFileSizeNoFollow(objectPath(documentsRoot, storageKey));
    if (size === undefined || String(size) !== ciphertextSize) return false;
    referencedObjects.add(storageKey);
  }

  for (const line of splitReportLines(reports.attachments)) {
    const [attachmentId, storageKey, ciphertextSize, keyId] = line.split("|");
    if (!attachmentId) continue;
    if (!STORAGE_KEY_PATTERN.test(storageKey) || !POSITIVE_INT_PATTERN.test(ciphertextSize) || !keyId) return false;
    if (referencedObjects.has(storageKey)) return false;
    const size = regularFileSizeNoFollow(objectPath(documentsRoot, storageKey));
    if (size === undefined || String(size) !== ciphertextSize) return false;
    referencedObjects.add(storageKey);
  }

  // Pending ledger rows are the bounded recovery reference for a ciphertext
  // written before its attachment row committed (restore.sh:272-275
  // comment). A missing object is safe (the write may have failed); an
  // existing one must not be treated as an unreferenced ordinary document.
  for (const line of splitReportLines(reports.staging)) {
    const [storageKey, lifecycle] = line.split("|");
    if (!storageKey) continue;
    if (!STORAGE_KEY_PATTERN.test(storageKey) || !PENDING_STATUS_PATTERN.test(lifecycle)) return false;
    if (regularFileSizeNoFollow(objectPath(documentsRoot, storageKey)) !== undefined) {
      referencedObjects.add(storageKey);
    }
  }

  for (const line of splitReportLines(reports.documentStaging)) {
    const [documentId, storageKey, lifecycle, ciphertextSize] = line.split("|");
    if (!documentId) continue;
    if (
      !DOCUMENT_ID36_PATTERN.test(documentId) ||
      !STORAGE_KEY_PATTERN.test(storageKey) ||
      !POSITIVE_INT_PATTERN.test(ciphertextSize) ||
      !PENDING_STATUS_PATTERN.test(lifecycle)
    ) {
      return false;
    }
    if (referencedObjects.has(storageKey)) return false;
    const size = regularFileSizeNoFollow(join(documentsRoot, "staging", `${storageKey}.bin`));
    if (size === undefined || String(size) !== ciphertextSize) return false;
    referencedObjects.add(storageKey);
  }

  for (const line of splitReportLines(reports.visible)) {
    const [documentId, , storageKey, ciphertextSize] = line.split("|");
    if (!documentId) continue;
    if (!STORAGE_KEY_PATTERN.test(storageKey) || !POSITIVE_INT_PATTERN.test(ciphertextSize)) return false;
  }

  for (const entry of walkFiles(documentsRoot, "objects")) {
    const match = OBJECT_RELATIVE_PATTERN.exec(entry.relativePath);
    if (!match) return false;
    const [, dirA, dirB, objectKey] = match;
    if (`${dirA}${dirB}` !== objectKey.slice(0, 4)) return false;
    if (!referencedObjects.has(objectKey)) return false;
    const count = (storedCounts.get(objectKey) ?? 0) + 1;
    storedCounts.set(objectKey, count);
    if (count !== 1) return false;
  }
  for (const entry of walkFiles(documentsRoot, "staging")) {
    const match = STAGING_RELATIVE_PATTERN.exec(entry.relativePath);
    if (!match) return false;
    const objectKey = match[1];
    if (!referencedObjects.has(objectKey)) return false;
    const count = (storedCounts.get(objectKey) ?? 0) + 1;
    storedCounts.set(objectKey, count);
    if (count !== 1) return false;
  }

  for (const storageKey of referencedObjects) {
    if ((storedCounts.get(storageKey) ?? 0) !== 1) return false;
  }

  return true;
}

// ---------------------------------------------------------------------------
// RestoreDockerAdapter — the thin, injectable edge over the Docker/Postgres
// operations restore.sh needs beyond what BackupDockerAdapter already
// covers (pg_dump/pg_restore --list/document-tar collection are reused
// as-is: restore.sh's checkpoint capture uses the identical command shapes
// backup.sh's create_bundle does).
// ---------------------------------------------------------------------------

export interface RestoreDockerAdapter extends Pick<BackupDockerAdapter, "dumpDatabase" | "pgRestoreListOk" | "collectDocumentsArchive"> {
  /** restore.sh:525,752,766,822 — `compose stop orbit-app`. Returns success; callers decide checked vs. best-effort. */
  stopApp(): boolean;
  /** restore.sh:747,769,825 — `compose start orbit-app`. */
  startApp(): boolean;
  /** restore.sh:161-167 — `CREATE DATABASE "<name>"`; throws on failure. */
  createStageDatabase(name: string): void;
  /** restore.sh:170-176 — `DROP DATABASE IF EXISTS "<name>"`; best-effort, never throws (`|| true`). */
  dropStageDatabase(name: string): void;
  /** restore.sh:178-185 — `pg_restore --single-transaction --exit-on-error` into a private stage database. */
  restoreDumpToDatabase(databaseName: string, dumpPath: string): boolean;
  /** restore.sh:578-583 — `pg_restore --single-transaction --clean --if-exists --exit-on-error` into the live database. */
  restoreActiveDatabase(dumpPath: string): boolean;
  /** restore.sh:568-576 — removes the live document tree and extracts the given archive in one container invocation. */
  replaceDocumentsFromArchive(archivePath: string): boolean;
  /** restore.sh:585-589 — requeues or fails stuck scan jobs after a restore. */
  resetScanRecoveryLeases(): boolean;
  /** restore.sh:187-194 — a `psql --tuples-only --no-align --field-separator="|"` report against a named (private stage) database; throws on failure. */
  queryReport(databaseName: string, query: string): string;
  /** restore.sh:196-203 — the same report shape against the live database; throws on failure. */
  queryActiveReport(query: string): string;
  /** restore.sh:738-750 — polls the app's health endpoint for up to 45s. */
  waitForHealth(): boolean;
}

function fetchCorrespondenceReports(adapter: Pick<RestoreDockerAdapter, "queryReport">, databaseName: string): CorrespondenceReports {
  return {
    crypto: adapter.queryReport(databaseName, CORRESPONDENCE_QUERIES.crypto),
    visible: adapter.queryReport(databaseName, CORRESPONDENCE_QUERIES.visible),
    attachments: adapter.queryReport(databaseName, CORRESPONDENCE_QUERIES.attachments),
    staging: adapter.queryReport(databaseName, CORRESPONDENCE_QUERIES.staging),
    documentStaging: adapter.queryReport(databaseName, CORRESPONDENCE_QUERIES.documentStaging),
    transientCount: adapter.queryReport(databaseName, CORRESPONDENCE_QUERIES.transientCount),
  };
}

function fetchActiveCorrespondenceReports(adapter: Pick<RestoreDockerAdapter, "queryActiveReport">): CorrespondenceReports {
  return {
    crypto: adapter.queryActiveReport(CORRESPONDENCE_QUERIES.crypto),
    visible: adapter.queryActiveReport(CORRESPONDENCE_QUERIES.visible),
    attachments: adapter.queryActiveReport(CORRESPONDENCE_QUERIES.attachments),
    staging: adapter.queryActiveReport(CORRESPONDENCE_QUERIES.staging),
    documentStaging: adapter.queryActiveReport(CORRESPONDENCE_QUERIES.documentStaging),
    transientCount: adapter.queryActiveReport(CORRESPONDENCE_QUERIES.transientCount),
  };
}

function installCheckpointKey(checkpointDirectory: string, documentKekFile: string): boolean {
  const keyPath = join(checkpointDirectory, "document-kek");
  if (!isRegularNonSymlinkFile(keyPath)) return false;
  try {
    const content = readFileNoFollow(keyPath)
      .toString("utf8")
      .replace(/[\r\n]+$/, "");
    if (!isValidDocumentKekHex(content)) return false;
    writeSecretFile(documentKekFile, `${content}\n`, SECURE_FILE_MODE);
    return true;
  } catch {
    return false;
  }
}

function captureAndCheckActiveCorrespondence(adapter: RestoreDockerAdapter, workDir: string): boolean {
  try {
    const archivePath = join(workDir, "active-documents.tar");
    adapter.collectDocumentsArchive(archivePath);
    validateDocumentArchiveEntries(listTarEntriesVerbose(archivePath));
    const extractedDir = join(workDir, "active-documents");
    rmSync(extractedDir, { recursive: true, force: true });
    mkdirSync(extractedDir, { recursive: true });
    extractTar(archivePath, extractedDir);
    const reports = fetchActiveCorrespondenceReports(adapter);
    return checkCorrespondence(reports, extractedDir);
  } catch {
    return false;
  }
}

/**
 * restore_checkpoint_state (restore.sh:752-762): reapplies a verified
 * checkpoint's database, documents, and key onto live state, then
 * re-validates correspondence — used identically by both rollback_checkpoint
 * (automatic, mid-run) and recover_restore (`--recover`, a fresh process).
 */
function applyCheckpointState(adapter: RestoreDockerAdapter, checkpointDirectory: string, documentKekFile: string, workDir: string): boolean {
  if (!adapter.restoreActiveDatabase(join(checkpointDirectory, "database.dump"))) return false;
  if (!adapter.replaceDocumentsFromArchive(join(checkpointDirectory, "documents.tar"))) return false;
  if (!installCheckpointKey(checkpointDirectory, documentKekFile)) return false;
  return captureAndCheckActiveCorrespondence(adapter, workDir);
}

// ---------------------------------------------------------------------------
// Private staging preflight (restore.sh:334-353's prepare_staged_bundle,
// guarantees #7-10): validates a newly staged bundle's database dump and
// document tree correspond, entirely in a throwaway private database — never
// touching live state — before a checkpoint is ever created.
// ---------------------------------------------------------------------------

export interface PreflightValidateBundleOptions {
  adapter: Pick<RestoreDockerAdapter, "createStageDatabase" | "dropStageDatabase" | "restoreDumpToDatabase" | "queryReport">;
  databaseDumpPath: string;
  /** Already-extracted document tar (caller's responsibility, matching recovery-bundle.ts's extractedDir convention). */
  stagedDocumentsRoot: string;
  /** A caller-generated, non-attacker-controlled identifier (e.g. a timestamp+pid), used only to namespace the private database. */
  stagingId: string;
}

export function preflightValidateBundle(options: PreflightValidateBundleOptions): void {
  const stage = `orbit_restore_stage_${options.stagingId}`;
  options.adapter.createStageDatabase(stage);
  try {
    if (!options.adapter.restoreDumpToDatabase(stage, options.databaseDumpPath)) {
      refuse("checkpoint-verification-failed", "preflight/database-stage failed; the PostgreSQL archive could not be restored transactionally.");
    }
    const reports = fetchCorrespondenceReports(options.adapter, stage);
    if (!checkCorrespondence(reports, options.stagedDocumentsRoot)) {
      refuse("preflight-correspondence-failed", "preflight/correspondence failed; the staged database and document tree do not correspond; use a complete backup and retry.");
    }
  } finally {
    options.adapter.dropStageDatabase(stage);
  }
}

// ---------------------------------------------------------------------------
// RestoreRun — the checkpoint/journal/rollback state machine itself.
// ---------------------------------------------------------------------------

export interface RestoreRunOptions {
  adapter: RestoreDockerAdapter;
  paths: RestorePaths;
  /** Caller-managed scratch directory for this run, matching recovery-bundle.ts's extractedDir convention. */
  workDir: string;
  /** ORBIT_RESTORE_ROLLBACK_KEK_FILE equivalent (import-recovery-bundle.sh's key-swap safety net, restore.sh:509). */
  rollbackDocumentKekFile?: string;
  hooks?: RestoreDurabilityHooks;
}

export type RestoreDisposeOutcome = "rolled-back" | "rollback-failed" | "manual-recovery-required" | "completed" | "no-checkpoint";

export interface RestoreDisposeResult {
  outcome: RestoreDisposeOutcome;
  checkpointDirectory?: string;
}

export class RestoreRun {
  readonly restoreId: string;
  readonly checkpointDirectory: string;

  private checkpointVerified = false;
  private appStopped = false;
  private completed = false;
  private manualRecoveryRequired = false;
  private disposed = false;
  private stageDatabase: string | undefined;
  private checkpointDigests: RestoreCheckpointDigests | undefined;

  private constructor(
    private readonly adapter: RestoreDockerAdapter,
    private readonly paths: RestorePaths,
    private readonly workDir: string,
    private readonly rollbackDocumentKekFile: string | undefined,
    private readonly hooks: RestoreDurabilityHooks,
    checkpointDirectory: string,
    restoreId: string,
  ) {
    this.checkpointDirectory = checkpointDirectory;
    this.restoreId = restoreId;
  }

  /** create_checkpoint's directory setup (restore.sh:516-524), before any capture begins. */
  static prepare(options: RestoreRunOptions): RestoreRun {
    mkdirSync(options.paths.restoreRoot, { recursive: true });
    chmodSync(options.paths.restoreRoot, SECURE_DIRECTORY_MODE);
    const checkpointDirectory = mkdtempSync(join(options.paths.restoreRoot, "checkpoint-"));
    chmodSync(checkpointDirectory, SECURE_DIRECTORY_MODE);
    const marker = "checkpoint-";
    const restoreId = checkpointDirectory.slice(checkpointDirectory.lastIndexOf(marker) + marker.length);
    return new RestoreRun(
      options.adapter,
      options.paths,
      options.workDir,
      options.rollbackDocumentKekFile,
      options.hooks ?? {},
      checkpointDirectory,
      restoreId,
    );
  }

  /** Reconstructs a RestoreRun over an already-loaded, already-integrity-verified checkpoint (recoverRestore's `--recover` path). */
  static resume(options: Omit<RestoreRunOptions, "rollbackDocumentKekFile">, checkpointDirectory: string, restoreId: string, digests: RestoreCheckpointDigests): RestoreRun {
    const run = new RestoreRun(options.adapter, options.paths, options.workDir, undefined, options.hooks ?? {}, checkpointDirectory, restoreId);
    run.checkpointVerified = true;
    run.checkpointDigests = digests;
    return run;
  }

  isCheckpointVerified(): boolean {
    return this.checkpointVerified;
  }

  isCompleted(): boolean {
    return this.completed;
  }

  markManualRecoveryRequired(): void {
    this.manualRecoveryRequired = true;
  }

  /**
   * create_checkpoint (restore.sh:516-566): stops the app for a consistent
   * recovery point (#19), captures and validates the database dump (#20) and
   * document archive, checkpoints the current document key (#18), self-
   * verifies the whole checkpoint end-to-end against a private stage
   * database before trusting it (#22), computes and durably syncs its
   * digests (#13-14), and only then durably journals `checkpointed` (#15-17)
   * — `checkpointVerified` (governing every later rollback/cleanup decision)
   * is set true only after all of that succeeds (#23), establishing the
   * strict "point of no return" ordering.
   */
  createCheckpoint(): void {
    if (!this.adapter.stopApp()) {
      refuse("app-stop-failed", "checkpoint/stop failed; Orbit was not stopped for a consistent recovery point.");
    }
    this.appStopped = true;

    const checkpointDump = join(this.checkpointDirectory, "database.dump");
    const checkpointDocuments = join(this.checkpointDirectory, "documents.tar");

    this.adapter.dumpDatabase(checkpointDump);
    if (!this.adapter.pgRestoreListOk(checkpointDump)) {
      refuse("checkpoint-database-invalid", "checkpoint/database failed; the captured PostgreSQL archive is invalid.");
    }

    this.adapter.collectDocumentsArchive(checkpointDocuments);
    validateDocumentArchiveEntries(listTarEntriesVerbose(checkpointDocuments));

    this.copyCheckpointKey();
    this.verifyCheckpointArtifactsCorrespond("orbit_restore_checkpoint_stage_");

    this.checkpointDigests = computeCheckpointDigests(this.checkpointDirectory);
    syncCheckpointArtifacts(this.checkpointDirectory, this.hooks);
    writeRestoreJournal(this.paths, { restoreId: this.restoreId, state: "checkpointed", ...this.checkpointDigests }, this.hooks);

    this.checkpointVerified = true;
  }

  private copyCheckpointKey(): void {
    const source = this.rollbackDocumentKekFile ?? this.paths.documentKekFile;
    if (!isRegularNonSymlinkFile(source)) {
      refuse("checkpoint-key-invalid", "checkpoint/key failed; the current document key could not be checkpointed safely.");
    }
    let content: string;
    try {
      content = readFileNoFollow(source)
        .toString("utf8")
        .replace(/[\r\n]+$/, "");
    } catch {
      refuse("checkpoint-key-invalid", "checkpoint/key failed; the current document key could not be checkpointed safely.");
    }
    if (!isValidDocumentKekHex(content)) {
      refuse("checkpoint-key-invalid", "checkpoint/key failed; the current document key could not be checkpointed safely.");
    }
    writeSecretFile(join(this.checkpointDirectory, "document-kek"), `${content}\n`, SECURE_FILE_MODE);
  }

  /**
   * Shared by createCheckpoint's self-verification (restore.sh:544-556) and
   * reverifyCheckpointForRecovery's re-verification (restore.sh:806-820) —
   * both restore checkpointDirectory's database.dump into a private stage
   * database, extract its documents.tar, and run checkCorrespondence; they
   * differ only in the stage-database name prefix Bash uses for operator log
   * clarity.
   */
  private verifyCheckpointArtifactsCorrespond(stageNamePrefix: string): void {
    const stage = `${stageNamePrefix}${this.restoreId}`;
    const databaseDumpPath = join(this.checkpointDirectory, "database.dump");
    const documentsTarPath = join(this.checkpointDirectory, "documents.tar");
    try {
      this.adapter.createStageDatabase(stage);
      this.stageDatabase = stage;
      if (!this.adapter.restoreDumpToDatabase(stage, databaseDumpPath)) {
        refuse("checkpoint-verification-failed", "checkpoint/verification failed; the durable database checkpoint is invalid.");
      }
      const extractedDocuments = join(this.workDir, "checkpoint-documents");
      rmSync(extractedDocuments, { recursive: true, force: true });
      mkdirSync(extractedDocuments, { recursive: true });
      validateDocumentArchiveEntries(listTarEntriesVerbose(documentsTarPath));
      extractTar(documentsTarPath, extractedDocuments);
      const reports = fetchCorrespondenceReports(this.adapter, stage);
      if (!checkCorrespondence(reports, extractedDocuments)) {
        refuse("checkpoint-verification-failed", "checkpoint/verification failed; the durable rollback database and document tree do not correspond.");
      }
    } finally {
      if (this.stageDatabase) {
        this.adapter.dropStageDatabase(this.stageDatabase);
        this.stageDatabase = undefined;
      }
    }
  }

  /** cutover step 1 (restore.sh:919-920): the first live mutation, immediately journaled once it completes. */
  cutoverDocuments(newDocumentsArchivePath: string): void {
    if (!this.adapter.replaceDocumentsFromArchive(newDocumentsArchivePath)) {
      refuse("cutover-documents-failed", "cutover/documents failed; the staged document tree could not replace active state.");
    }
    writeRestoreJournal(this.paths, { restoreId: this.restoreId, state: "documents-replaced", ...this.checkpointDigests! }, this.hooks);
  }

  /** cutover step 2 (restore.sh:924-926): the second live mutation, immediately journaled once it and the lease reset complete. */
  cutoverDatabase(newDatabaseDumpPath: string): void {
    if (!this.adapter.restoreActiveDatabase(newDatabaseDumpPath)) {
      refuse("cutover-database-failed", "cutover/database failed; the staged PostgreSQL archive was rejected transactionally.");
    }
    if (!this.adapter.resetScanRecoveryLeases()) {
      refuse("cutover-recovery-jobs-failed", "cutover/recovery-jobs failed; recoverable scanner jobs could not be safely requeued.");
    }
    writeRestoreJournal(this.paths, { restoreId: this.restoreId, state: "database-restored", ...this.checkpointDigests! }, this.hooks);
  }

  /** restore.sh:927-932: re-validates active correspondence, waits for health, and only then marks the restore complete and purges the journal/checkpoint. */
  finalize(): void {
    if (!captureAndCheckActiveCorrespondence(this.adapter, this.workDir)) {
      refuse("active-correspondence-failed", "cutover/correspondence failed; active database and documents do not correspond.");
    }
    if (!this.adapter.startApp() || !this.adapter.waitForHealth()) {
      refuse("health-check-failed", "cutover/health failed; Orbit did not become healthy after restore.");
    }
    this.appStopped = false;
    this.completed = true;
    this.removeJournalAndCheckpoint();
  }

  /** rollback_checkpoint (restore.sh:764-770): reapplies the verified checkpoint. Never throws — returns whether it succeeded. */
  rollback(): boolean {
    if (!this.checkpointDigests || !validateCheckpointIntegrity(this.checkpointDirectory, this.checkpointDigests)) {
      return false;
    }
    this.adapter.stopApp();
    this.appStopped = true;
    if (!applyCheckpointState(this.adapter, this.checkpointDirectory, this.paths.documentKekFile, this.workDir)) {
      return false;
    }
    if (!this.adapter.startApp() || !this.adapter.waitForHealth()) {
      return false;
    }
    this.appStopped = false;
    return true;
  }

  /** recover_restore's own re-verification of the checkpoint before trusting it (restore.sh:802-820). */
  reverifyCheckpointForRecovery(): void {
    this.verifyCheckpointArtifactsCorrespond("orbit_recover_checkpoint_stage_");
  }

  /** recover_restore's application step (restore.sh:822-826), once re-verification has already passed. */
  recoverFromCheckpoint(): void {
    if (!this.adapter.stopApp()) {
      refuse("app-stop-failed", "recovery/stop failed; keep Orbit stopped and retry recovery.");
    }
    this.appStopped = true;
    if (!applyCheckpointState(this.adapter, this.checkpointDirectory, this.paths.documentKekFile, this.workDir)) {
      refuse("recovery-restore-failed", "recovery/restore failed; Orbit remains stopped and the checkpoint is preserved for another explicit recovery attempt.");
    }
    if (!this.adapter.startApp() || !this.adapter.waitForHealth()) {
      refuse("recovery-health-failed", "recovery/health failed; Orbit remains stopped and the checkpoint is preserved for another explicit recovery attempt.");
    }
    this.appStopped = false;
  }

  markCompleted(): void {
    this.completed = true;
    this.removeJournalAndCheckpoint();
  }

  private removeJournalAndCheckpoint(): void {
    rmSafely(this.paths.journalPath);
    rmSync(this.checkpointDirectory, { recursive: true, force: true });
  }

  /**
   * cleanup (restore.sh:833-860, the `EXIT` trap): if a checkpoint was
   * verified but the restore did not complete, either preserves recovery
   * evidence (`manualRecoveryRequired`, i.e. mid-`--recover`) or attempts an
   * automatic rollback — on rollback failure it durably records
   * `rollback-failed` and leaves Orbit stopped rather than guessing further
   * (#38-39); on rollback success it purges the journal/checkpoint (#40).
   * Otherwise, if the app was stopped, it is restarted best-effort. Any
   * leftover stage database is always dropped, an unverified checkpoint is
   * always removed (#42), and the caller-owned scratch directory is always
   * removed. Idempotent, like InstallTransaction.dispose().
   */
  dispose(): RestoreDisposeResult {
    if (this.disposed) {
      return { outcome: this.completed ? "completed" : "no-checkpoint" };
    }
    this.disposed = true;

    let result: RestoreDisposeResult;
    if (this.checkpointVerified && !this.completed) {
      if (this.manualRecoveryRequired) {
        this.adapter.stopApp();
        this.appStopped = true;
        this.writeRollbackFailedJournalBestEffort();
        result = { outcome: "manual-recovery-required", checkpointDirectory: this.checkpointDirectory };
      } else if (this.rollback()) {
        this.removeJournalAndCheckpoint();
        result = { outcome: "rolled-back" };
      } else {
        this.adapter.stopApp();
        this.appStopped = true;
        this.writeRollbackFailedJournalBestEffort();
        result = { outcome: "rollback-failed", checkpointDirectory: this.checkpointDirectory };
      }
    } else {
      if (this.appStopped) this.adapter.startApp();
      result = { outcome: this.completed ? "completed" : "no-checkpoint" };
    }

    if (this.stageDatabase) {
      this.adapter.dropStageDatabase(this.stageDatabase);
      this.stageDatabase = undefined;
    }
    if (!this.checkpointVerified) {
      rmSync(this.checkpointDirectory, { recursive: true, force: true });
    }
    rmSync(this.workDir, { recursive: true, force: true });
    return result;
  }

  private writeRollbackFailedJournalBestEffort(): void {
    if (!this.checkpointDigests) return;
    try {
      writeRestoreJournal(this.paths, { restoreId: this.restoreId, state: "rollback-failed", ...this.checkpointDigests }, this.hooks);
    } catch {
      // Best-effort, matches restore.sh:840,845's own `write_journal rollback-failed >/dev/null 2>&1 || true`.
    }
  }
}

// ---------------------------------------------------------------------------
// recoverRestore — the `bash scripts/restore.sh --recover` entry point
// equivalent (restore.sh:798-831).
// ---------------------------------------------------------------------------

export interface RecoverRestoreOptions {
  adapter: RestoreDockerAdapter;
  paths: RestorePaths;
  workDir: string;
  hooks?: RestoreDurabilityHooks;
}

/**
 * recover_restore (restore.sh:798-831): loads and validates the journal
 * (which already re-checks checkpoint-artifact presence), re-verifies
 * checkpoint digest integrity and key validity from scratch (never trusting
 * the journal's claims alone, #34), re-runs the full checkpoint self-
 * verification (#35), and only then reapplies it. `manualRecoveryRequired`
 * is set before the apply attempt (mirroring restore.sh:821's ordering), so
 * a failure here routes RestoreRun.dispose() into the "preserve evidence,
 * try `--recover` again" branch rather than a fresh automatic rollback
 * attempt — recovery is safely retriable from any partial failure (#36).
 */
export function recoverRestore(options: RecoverRestoreOptions): RestoreDisposeResult {
  const { fields, checkpointDirectory } = loadRestoreJournal(options.paths.journalPath, options.paths.restoreRoot);
  const digests: RestoreCheckpointDigests = {
    databaseSha256: fields.databaseSha256,
    documentsSha256: fields.documentsSha256,
    documentKekSha256: fields.documentKekSha256,
  };
  if (!validateCheckpointIntegrity(checkpointDirectory, digests)) {
    refuse("checkpoint-integrity-failed", "recovery/integrity failed; a durable checkpoint artifact changed; keep Orbit stopped and preserve the recovery evidence.");
  }
  if (!isValidCheckpointKeyFile(checkpointDirectory)) {
    refuse("checkpoint-key-invalid", "recovery/key failed; the durable checkpoint key is invalid; keep Orbit stopped and preserve the recovery evidence.");
  }

  const run = RestoreRun.resume(
    { adapter: options.adapter, paths: options.paths, workDir: options.workDir, hooks: options.hooks },
    checkpointDirectory,
    fields.restoreId,
    digests,
  );

  let succeeded = false;
  try {
    run.reverifyCheckpointForRecovery();
    run.markManualRecoveryRequired();
    run.recoverFromCheckpoint();
    succeeded = true;
  } finally {
    if (succeeded) run.markCompleted();
    run.dispose();
  }
  return { outcome: "completed" };
}

// ---------------------------------------------------------------------------
// createDockerComposeRestoreAdapter — the real RestoreDockerAdapter,
// spawning the exact `docker compose ...` argument lists restore.sh uses.
// PATH-shim-testable with no live daemon required, mirroring
// createDockerComposeBackupAdapter.
// ---------------------------------------------------------------------------

export interface RestoreDockerComposeAdapterOptions extends DockerComposeAdapterOptions {
  healthUrl?: string;
  curlBinary?: string;
}

function sleepSync(milliseconds: number): void {
  const signal = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(signal, 0, 0, milliseconds);
}

export function createDockerComposeRestoreAdapter(options: RestoreDockerComposeAdapterOptions): RestoreDockerAdapter {
  const dockerBinary = options.dockerBinary ?? "docker";
  const cwd = options.cwd;
  const env = options.env ?? process.env;
  const composeArgs = (...args: string[]): string[] => ["compose", "--env-file", options.envFile, ...args];
  const backupOps = createDockerComposeBackupAdapter(options);

  return {
    dumpDatabase: backupOps.dumpDatabase,
    pgRestoreListOk: backupOps.pgRestoreListOk,
    collectDocumentsArchive: backupOps.collectDocumentsArchive,

    stopApp(): boolean {
      const result = spawnSync(dockerBinary, composeArgs("stop", "orbit-app"), { cwd, env, stdio: ["ignore", "ignore", "inherit"] });
      return result.status === 0;
    },
    startApp(): boolean {
      const result = spawnSync(dockerBinary, composeArgs("start", "orbit-app"), { cwd, env, stdio: ["ignore", "ignore", "inherit"] });
      return result.status === 0;
    },
    createStageDatabase(name: string): void {
      const result = spawnSync(
        dockerBinary,
        composeArgs(
          "exec",
          "-T",
          "orbit-db",
          "sh",
          "-c",
          'exec psql --username="$POSTGRES_USER" --dbname=postgres --set=ON_ERROR_STOP=1 --command="CREATE DATABASE \\"$1\\";"',
          "sh",
          name,
        ),
        { cwd, env, stdio: ["ignore", "ignore", "inherit"] },
      );
      if (result.status !== 0) refuse("stage-database-failed", "preflight/database-stage failed; a private staging database could not be created.");
    },
    dropStageDatabase(name: string): void {
      spawnSync(
        dockerBinary,
        composeArgs(
          "exec",
          "-T",
          "orbit-db",
          "sh",
          "-c",
          'psql --username="$POSTGRES_USER" --dbname=postgres --set=ON_ERROR_STOP=1 --command="DROP DATABASE IF EXISTS \\"$1\\";"',
          "sh",
          name,
        ),
        { cwd, env, stdio: ["ignore", "ignore", "ignore"] },
      );
    },
    restoreDumpToDatabase(name: string, dumpPath: string): boolean {
      const descriptor = openSync(dumpPath, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const result = spawnSync(
          dockerBinary,
          composeArgs(
            "exec",
            "-T",
            "orbit-db",
            "sh",
            "-c",
            'exec pg_restore --single-transaction --exit-on-error --no-owner --no-acl --username="$POSTGRES_USER" --dbname="$1"',
            "sh",
            name,
          ),
          { cwd, env, stdio: [descriptor, "ignore", "inherit"] },
        );
        return result.status === 0;
      } finally {
        closeSync(descriptor);
      }
    },
    restoreActiveDatabase(dumpPath: string): boolean {
      const descriptor = openSync(dumpPath, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const result = spawnSync(
          dockerBinary,
          composeArgs(
            "exec",
            "-T",
            "orbit-db",
            "sh",
            "-c",
            'exec pg_restore --single-transaction --clean --if-exists --no-owner --no-acl --exit-on-error --username="$POSTGRES_USER" --dbname="$POSTGRES_DB"',
          ),
          { cwd, env, stdio: [descriptor, "ignore", "inherit"] },
        );
        return result.status === 0;
      } finally {
        closeSync(descriptor);
      }
    },
    replaceDocumentsFromArchive(archivePath: string): boolean {
      const descriptor = openSync(archivePath, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const result = spawnSync(
          dockerBinary,
          composeArgs(
            "run",
            "--rm",
            "--no-deps",
            "--entrypoint",
            "sh",
            "orbit-app",
            "-c",
            "set -eu; find /var/lib/orbit/documents -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +; exec tar -C /var/lib/orbit/documents -xf -",
          ),
          { cwd, env, stdio: [descriptor, "ignore", "inherit"] },
        );
        return result.status === 0;
      } finally {
        closeSync(descriptor);
      }
    },
    resetScanRecoveryLeases(): boolean {
      const result = spawnSync(dockerBinary, composeArgs("exec", "-T", "orbit-db", "sh", "-c", SCAN_RECOVERY_LEASES_SQL, "sh"), {
        cwd,
        env,
        stdio: ["ignore", "ignore", "inherit"],
      });
      return result.status === 0;
    },
    queryReport(name: string, query: string): string {
      const result = spawnSync(
        dockerBinary,
        composeArgs(
          "exec",
          "-T",
          "orbit-db",
          "sh",
          "-c",
          'exec psql --username="$POSTGRES_USER" --dbname="$1" --tuples-only --no-align --field-separator="|" --command="$2"',
          "sh",
          name,
          query,
        ),
        { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] },
      );
      if (result.status !== 0) refuse("query-report-failed", "The staged database could not be queried for correspondence checking.");
      return result.stdout ?? "";
    },
    queryActiveReport(query: string): string {
      const result = spawnSync(
        dockerBinary,
        composeArgs(
          "exec",
          "-T",
          "orbit-db",
          "sh",
          "-c",
          'exec psql --username="$POSTGRES_USER" --dbname="$POSTGRES_DB" --tuples-only --no-align --field-separator="|" --command="$1"',
          "sh",
          query,
        ),
        { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] },
      );
      if (result.status !== 0) refuse("query-report-failed", "The active database could not be queried for correspondence checking.");
      return result.stdout ?? "";
    },
    waitForHealth(): boolean {
      const url = options.healthUrl ?? "http://127.0.0.1:3000/api/health";
      const curlBinary = options.curlBinary ?? "curl";
      const deadline = Date.now() + 45_000;
      for (;;) {
        const result = spawnSync(curlBinary, ["--fail", "--silent", "--max-time", "2", url], { cwd, env, stdio: "ignore" });
        if (result.status === 0) return true;
        if (Date.now() >= deadline) return false;
        sleepSync(1000);
      }
    },
  };
}

// Re-exported for tests that need to assert on raw filesystem/predicate
// facts without duplicating the logic above.
export const internal = {
  isSymlinkPath,
  isRealNonSymlinkDirectory,
  regularFileSizeNoFollow,
  walkFiles,
  isValidCheckpointKeyFile,
  applyCheckpointState,
  captureAndCheckActiveCorrespondence,
};
