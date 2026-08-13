import {
  closeSync,
  constants,
  copyFileSync,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  BackupRestoreCliRefusal,
  runBackup,
  runExportRecoveryBundle,
  runImportRecoveryBundle,
  runRestore,
  verifyBackupBundle,
} from "../lib/backup-restore-cli";
import { evaluateReadiness, type OidcSecretFileFacts } from "../lib/config-contract";
import { parseEnvOrbitContent } from "../lib/env-orbit-file";
import { InstallTransaction, type ManagedPath } from "../lib/install-transaction";
import {
  type BackupDockerAdapter,
  RecoveryBundleRefusal,
  createDockerComposeBackupAdapter,
  createTar,
  extractTar,
  isValidDocumentKekHex,
  requireMatchingPassphrase,
  requireValidPassphrase,
} from "../lib/recovery-bundle";
import {
  IMPORT_CONFIRMATION_PHRASE,
  type MachinePromptDriver,
  RESTORE_CONFIRMATION_PHRASE,
  RecoveryPromptAbortedError,
  collectMachineImportConfirmation,
  collectMachineRecoveryPassphrase,
  collectMachineRecoveryPassphraseNoConfirm,
  collectMachineRestoreConfirmation,
} from "../lib/recovery-prompts";
import {
  CORRESPONDENCE_QUERIES,
  RestoreEngineRefusal,
  type CorrespondenceReports,
  type RestoreDockerAdapter,
  createDockerComposeRestoreAdapter,
  deriveRestorePaths,
  recoverRestore,
} from "../lib/restore-engine";

// The orbit engine CLI (ADR-0011, issue #294). First flow: `check` — the
// value-free readiness report, output-identical to `configure.sh --check`
// (proven by src/lib/config-contract.parity.test.ts). Non-interactive by
// design; interactive presentation belongs to orbit-launcher.

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function gatherOidcSecretFacts(deployDir: string): OidcSecretFileFacts {
  const secretsDirectory = join(deployDir, ".orbit-secrets");
  const secretFile = join(secretsDirectory, "oidc-client-secret");
  const directoryStat = statSync(secretsDirectory, { throwIfNoEntry: false });
  const directoryLstat = lstatSync(secretsDirectory, { throwIfNoEntry: false });
  const fileLstat = lstatSync(secretFile, { throwIfNoEntry: false });
  return {
    secretsDirectoryExists: directoryStat?.isDirectory() ?? false,
    secretsDirectoryIsSymlink: directoryLstat?.isSymbolicLink() ?? false,
    secretsDirectoryMode: directoryStat ? directoryStat.mode & 0o777 : null,
    secretFileExists: fileLstat !== undefined,
    secretFileIsRegular: fileLstat?.isFile() ?? false,
    secretFileIsSymlink: fileLstat?.isSymbolicLink() ?? false,
    secretFileMode: fileLstat ? fileLstat.mode & 0o777 : null,
    secretFileSize: fileLstat?.size ?? 0,
  };
}

function commandCheck(deployDir: string): never {
  const environmentFile = join(deployDir, ".env-orbit");
  // Open first with O_NOFOLLOW, then verify and read through the same
  // descriptor: the safety check and the content read cannot be split by a
  // file swap (CodeQL js/file-system-race).
  let descriptor: number;
  try {
    descriptor = openSync(environmentFile, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    fail("configuration_syntax");
  }
  let content: string;
  try {
    const stat = fstatSync(descriptor);
    if (!stat.isFile() || (stat.mode & 0o777) !== 0o600) {
      fail("configuration_syntax");
    }
    content = readFileSync(descriptor, "utf8");
  } finally {
    closeSync(descriptor);
  }

  const parsed = parseEnvOrbitContent(content);
  if (!parsed.ok) fail(parsed.code);

  const facts = gatherOidcSecretFacts(deployDir);
  const report = evaluateReadiness(parsed.record, facts);
  process.stdout.write(report.lines.join("\n") + "\n");
  process.exit(report.ok ? 0 : 1);
}

// ---------------------------------------------------------------------------
// orbit backup / orbit restore / orbit export-recovery-bundle /
// orbit import-recovery-bundle (issue #296 slice 4): real, explicit-
// invocation-only CLI entry points wired onto src/lib/recovery-bundle.ts
// (slices 1-2) and src/lib/restore-engine.ts (slice 3) via the orchestration
// in src/lib/backup-restore-cli.ts. None of these is reachable except by
// typing the command name — no default/implied execution from `main()`'s
// dispatch, no bootstrap wiring, and scripts/backup.sh / scripts/restore.sh
// / scripts/export-recovery-bundle.sh / scripts/import-recovery-bundle.sh
// remain entirely unmodified and are not invoked by anything here (see
// docs/adr-notes/296-backup-port-plan.md, Slice 4, "Non-goals").
// ---------------------------------------------------------------------------

interface BackupRestorePaths {
  envFile: string;
  backupDirectory: string;
  documentKekFile: string;
}

// The TS CLI's own path convention: everything is derived from `--dir`
// (matching `check`'s existing convention above), not from the Bash
// scripts' ORBIT_ENV_FILE/ORBIT_BACKUP_DIR/ORBIT_SECRETS_DIR environment
// variables — a deliberate, flagged simplification (see docs/adr-notes/
// 296-backup-port-plan.md, Slice 4 Flags), not a behavioral gap in what's
// characterized.
function resolveBackupRestorePaths(deployDir: string): BackupRestorePaths {
  return {
    envFile: join(deployDir, ".env-orbit"),
    backupDirectory: join(deployDir, "backups"),
    documentKekFile: join(deployDir, ".orbit-secrets", "document-kek"),
  };
}

/**
 * Reads the document KEK straight off the host filesystem (the slice 1
 * divergence docs/adr-notes/296-backup-port-plan.md's Flags already
 * flagged: every Bash script reads it the same way for its own format
 * checks). Single O_NOFOLLOW descriptor, mirroring commandCheck's own
 * discipline above and recovery-bundle.ts's readRegularFileNoFollow.
 */
function readDocumentKekHex(path: string): string {
  let descriptor: number;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    fail(`orbit: missing regular document KEK file at ${path}`);
  }
  let content: string;
  try {
    const stat = fstatSync(descriptor);
    if (!stat.isFile()) fail(`orbit: missing regular document KEK file at ${path}`);
    content = readFileSync(descriptor, "utf8");
  } finally {
    closeSync(descriptor);
  }
  const trimmed = content.replace(/[\r\n]+$/, "");
  if (!isValidDocumentKekHex(trimmed)) fail("orbit: the document KEK must be a 32-byte hexadecimal value");
  return trimmed;
}

// --- synchronous line I/O ---------------------------------------------------
//
// Everything else in this CLI is synchronous (no Promises anywhere in this
// file); prompt collection follows the same style rather than introducing
// async purely for stdin. fs.readSync on fd 0 performs a real blocking read
// syscall regardless of whether fd 0 is a TTY or a pipe — the same technique
// widely-used synchronous-stdin CLI libraries use — so this works both for a
// real terminal and for a spawned test harness's piped stdin.

function readSyncLine(fd: number): string | undefined {
  const bytes: number[] = [];
  const buffer = Buffer.alloc(1);
  for (;;) {
    const bytesRead = readSync(fd, buffer, 0, 1, null);
    if (bytesRead === 0) return bytes.length > 0 ? Buffer.from(bytes).toString("utf8") : undefined;
    const byte = buffer[0];
    if (byte === 10) return Buffer.from(bytes).toString("utf8");
    if (byte !== 13) bytes.push(byte);
  }
}

/**
 * A masked (no-echo) synchronous line read directly off fd 0 in raw mode —
 * the Node equivalent of `read -s`. Requires a real controlling terminal on
 * both stdin and stdout, matching export-recovery-bundle.sh/import-recovery-
 * bundle.sh's own `</dev/tty` requirement ("An interactive terminal is
 * required."), simplified to require stdin itself be that terminal (this
 * CLI never pipes a secret to a subprocess's stdin the way the Bash scripts
 * pipe the passphrase into `recovery-crypto.mjs`'s container invocation, so
 * — unlike Bash — nothing here needs stdin kept free for that; flagged in
 * docs/adr-notes/296-backup-port-plan.md).
 */
function readTtyMaskedLine(promptText: string): string {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    fail("orbit: an interactive terminal is required.");
  }
  process.stdout.write(promptText);
  process.stdin.setRawMode(true);
  const bytes: number[] = [];
  const buffer = Buffer.alloc(1);
  try {
    for (;;) {
      const bytesRead = readSync(0, buffer, 0, 1, null);
      if (bytesRead === 0) break;
      const byte = buffer[0];
      if (byte === 3) {
        // Ctrl-C: restore the terminal before exiting so the shell isn't left echo-less.
        process.stdin.setRawMode(false);
        process.stdout.write("\n");
        process.exit(130);
      }
      if (byte === 13 || byte === 10) break;
      if (byte === 127 || byte === 8) {
        if (bytes.length > 0) bytes.pop();
        continue;
      }
      bytes.push(byte);
    }
  } finally {
    process.stdin.setRawMode(false);
  }
  process.stdout.write("\n");
  return Buffer.from(bytes).toString("utf8");
}

function readTtyLine(promptText: string): string {
  if (!process.stdin.isTTY) fail("orbit: an interactive terminal is required.");
  process.stdout.write(promptText);
  const line = readSyncLine(0);
  if (line === undefined) fail("orbit: an interactive terminal is required.");
  return line;
}

function isMachinePromptMode(): boolean {
  return process.env.ORBIT_RECOVERY_PROMPTS === "machine";
}

function stdoutMachineDriver(): MachinePromptDriver {
  return {
    write(line: string): void {
      process.stdout.write(`${line}\n`);
    },
    readLine(): string | undefined {
      return readSyncLine(0);
    },
  };
}

/** export-recovery-bundle.sh:37-45 (guarantees #6-7): passphrase, then its confirmation, entered twice with no retry loop in TTY mode (matching the Bash original's single-attempt fail-closed behavior exactly); machine mode gets the bounded-3-attempt retry protocol docs/engine-events.md now documents. */
function collectRecoveryPassphraseWithConfirmation(): string {
  if (isMachinePromptMode()) return collectMachineRecoveryPassphrase(stdoutMachineDriver());
  const passphrase = readTtyMaskedLine("Recovery passphrase: ");
  requireValidPassphrase(passphrase);
  const confirmation = readTtyMaskedLine("Confirm recovery passphrase: ");
  requireMatchingPassphrase(passphrase, confirmation);
  return passphrase;
}

/** import-recovery-bundle.sh:73-74: a single passphrase entry, no confirmation (only IMPORT_CONFIRMATION below is a typed phrase). */
function collectImportPassphrase(): string {
  if (isMachinePromptMode()) return collectMachineRecoveryPassphraseNoConfirm(stdoutMachineDriver());
  return readTtyMaskedLine("Recovery passphrase: ");
}

/** import-recovery-bundle.sh:88-94 (guarantee #19): the literal "IMPORT RECOVERY" phrase, single attempt in TTY mode. */
function collectImportConfirmation(bundlePath: string): boolean {
  if (isMachinePromptMode()) {
    try {
      collectMachineImportConfirmation(stdoutMachineDriver());
      return true;
    } catch (error) {
      if (error instanceof RecoveryPromptAbortedError) return false;
      throw error;
    }
  }
  process.stdout.write(`This will replace the local document KEK and restore:\n  ${bundlePath}\n`);
  const answer = readTtyLine("Type IMPORT RECOVERY to continue: ");
  return answer === IMPORT_CONFIRMATION_PHRASE;
}

/** restore.sh guarantee #46: either `--yes` with `ORBIT_NONINTERACTIVE_RESTORE=true` (unattended automation — a single flag alone is never sufficient), or the literal "RESTORE" phrase (interactive/machine). Returns a callback: runRestore() calls it exactly once, at restore.sh's own confirmation point (after preflight/capacity, before the checkpoint), never eagerly. */
function makeRestoreConfirmer(useYesFlag: boolean): () => boolean {
  if (useYesFlag) {
    return () => process.env.ORBIT_NONINTERACTIVE_RESTORE === "true";
  }
  return () => {
    if (isMachinePromptMode()) {
      try {
        collectMachineRestoreConfirmation(stdoutMachineDriver());
        return true;
      } catch (error) {
        if (error instanceof RecoveryPromptAbortedError) return false;
        throw error;
      }
    }
    process.stdout.write("This will replace Orbit database contents and encrypted document bytes after a verified recovery checkpoint.\n");
    const answer = readTtyLine("Type RESTORE to continue: ");
    return answer === RESTORE_CONFIRMATION_PHRASE;
  };
}

function commandBackup(deployDir: string, args: string[]): never {
  const paths = resolveBackupRestorePaths(deployDir);
  const documentKekHex = readDocumentKekHex(paths.documentKekFile);
  const adapter: BackupDockerAdapter = createDockerComposeBackupAdapter({ envFile: paths.envFile, cwd: deployDir });

  if (args[0] === "--verify") {
    if (args.length !== 2 || !args[1]) fail("orbit: usage: orbit backup --verify <backup.tar>");
    const target = resolve(args[1]);
    const workDir = mkdtempSync(join(tmpdir(), "orbit-backup-verify-"));
    try {
      verifyBackupBundle(target, documentKekHex, workDir, adapter);
      process.stdout.write(`Orbit backup is valid: ${args[1]}\n`);
      process.exit(0);
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  }

  if (args.length !== 0) fail("orbit: usage: orbit backup [--verify <backup.tar>]");
  const result = runBackup({ backupDirectory: paths.backupDirectory, documentKekHex, adapter, now: new Date() });
  process.stdout.write(`Orbit backup created: ${result.finalTarPath}\n`);
  process.exit(0);
}

function commandRestore(deployDir: string, args: string[]): never {
  const paths = resolveBackupRestorePaths(deployDir);
  const restorePaths = deriveRestorePaths(paths.backupDirectory, paths.documentKekFile);
  const adapter = createDockerComposeRestoreAdapter({ envFile: paths.envFile, cwd: deployDir });

  let yesFlag = false;
  let recoverMode = false;
  let backupFile: string | undefined;
  for (const arg of args) {
    if (arg === "--yes") {
      yesFlag = true;
      continue;
    }
    if (arg === "--recover") {
      recoverMode = true;
      continue;
    }
    if (backupFile === undefined) {
      backupFile = arg;
      continue;
    }
    fail("orbit: usage: orbit restore [--yes] <backup.tar> | orbit restore --recover");
  }

  if (recoverMode) {
    if (backupFile !== undefined || yesFlag) fail("orbit: usage: --recover accepts no other arguments");
    const workDir = mkdtempSync(join(tmpdir(), "orbit-restore-recover-"));
    try {
      recoverRestore({ adapter, paths: restorePaths, workDir });
      process.stdout.write("Orbit recovery completed; the prior database, document tree, and key state were restored.\n");
      process.exit(0);
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  }

  if (backupFile === undefined) fail("orbit: usage: orbit restore [--yes] <backup.tar> | orbit restore --recover");
  const documentKekHex = readDocumentKekHex(paths.documentKekFile);
  const workDir = mkdtempSync(join(tmpdir(), "orbit-restore-"));
  try {
    runRestore({
      backupTarPath: resolve(backupFile),
      documentKekHex,
      paths: restorePaths,
      adapter,
      workDir,
      confirm: makeRestoreConfirmer(yesFlag),
    });
    process.stdout.write("Orbit restore completed successfully.\n");
    process.exit(0);
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

function commandExportRecoveryBundle(deployDir: string, args: string[]): never {
  if (args.length !== 1 || !args[0]) fail("orbit: usage: orbit export-recovery-bundle <backup.tar>");
  const paths = resolveBackupRestorePaths(deployDir);
  const documentKekHex = readDocumentKekHex(paths.documentKekFile);
  const adapter = createDockerComposeBackupAdapter({ envFile: paths.envFile, cwd: deployDir });
  const passphrase = collectRecoveryPassphraseWithConfirmation();
  const result = runExportRecoveryBundle({
    sourceBundlePath: resolve(args[0]),
    documentKekHex,
    passphrase,
    passphraseConfirmation: passphrase,
    backupDirectory: paths.backupDirectory,
    adapter,
    now: new Date(),
  });
  process.stdout.write(`Orbit recovery bundle created: ${result.finalPath}\n`);
  process.exit(0);
}

function commandImportRecoveryBundle(deployDir: string, args: string[]): never {
  if (args.length !== 1 || !args[0]) fail("orbit: usage: orbit import-recovery-bundle <recovery.tar>");
  const recoveryBundlePath = resolve(args[0]);
  const paths = resolveBackupRestorePaths(deployDir);
  const adapter = createDockerComposeRestoreAdapter({ envFile: paths.envFile, cwd: deployDir });
  const passphrase = collectImportPassphrase();
  const importConfirmed = collectImportConfirmation(recoveryBundlePath);
  runImportRecoveryBundle({
    recoveryBundlePath,
    passphrase,
    liveDocumentKekFile: paths.documentKekFile,
    backupDirectory: paths.backupDirectory,
    adapter,
    importConfirmed,
    confirmRestore: makeRestoreConfirmer(false),
  });
  process.stdout.write("Orbit recovery import completed successfully.\n");
  process.exit(0);
}

// Scenario shape for the hidden __install-transaction-rehearse subcommand
// below: JSON-serialisable so it can be handed to a child process for the
// SIGKILL interruption characterization test in
// src/lib/install-transaction.test.ts. Not a documented interface.
interface RehearsalScenario {
  targetDir: string;
  managedPaths: ManagedPath[];
  steps: RehearsalStep[];
}

type RehearsalStep =
  | { kind: "write"; path: string; contentBase64: string; mode?: number }
  | { kind: "commitMove"; path: string; type: "file" | "directory" }
  | { kind: "mkdir"; path: string }
  | { kind: "pause"; resumeSignalPath: string }
  | { kind: "commit" };

// Blocks the event loop synchronously (Node has no sync sleep primitive
// otherwise) so a test harness has a stable window to SIGKILL this process
// mid-transaction, mirroring how scripts/test-install-acceptance.sh waits
// for a known installer log line before its own kill -9.
function blockUntil(predicate: () => boolean, pollMs = 25): void {
  const signal = new Int32Array(new SharedArrayBuffer(4));
  while (!predicate()) {
    Atomics.wait(signal, 0, 0, pollMs);
  }
}

// Hidden/experimental: exercises InstallTransaction end-to-end for issue
// #295 slice 1's interruption characterization test. Never invoked by any
// shipped install/update/check flow, and deliberately undocumented in the
// usage message below.
function commandInstallTransactionRehearse(scenarioPath: string): never {
  const scenario = JSON.parse(readFileSync(scenarioPath, "utf8")) as RehearsalScenario;
  const transaction = InstallTransaction.begin(scenario.targetDir, scenario.managedPaths);
  try {
    for (const step of scenario.steps) {
      switch (step.kind) {
        case "write":
          transaction.writeStagedFile(step.path, Buffer.from(step.contentBase64, "base64"), step.mode);
          break;
        case "commitMove":
          transaction.commitMove(step.path, step.type);
          break;
        case "mkdir":
          transaction.ensureManagedDirectory(step.path);
          break;
        case "pause":
          process.stdout.write("phase=paused\n");
          blockUntil(() => existsSync(step.resumeSignalPath));
          break;
        case "commit":
          transaction.commit();
          break;
      }
    }
  } finally {
    transaction.dispose();
  }
  process.exit(0);
}

// Scenario shape and fake adapter for the hidden __restore-engine-rehearse
// subcommand below: exercises RestoreRun/recoverRestore (issue #296 slice 3)
// end-to-end, including a real, self-delivered SIGKILL at a chosen mutating
// step, for the interruption characterization test in
// src/lib/restore-engine.interruption.test.ts. Not a documented interface,
// and — unlike the install-transaction rehearsal, which pauses for an
// external kill — this mirrors restore.sh's own test harness
// (ORBIT_RESTORE_TEST_HARD_INTERRUPT_STAGE) by having the process signal
// itself once the target step completes: deterministic, no race window.
// The "Docker/Postgres" this fake adapter stands in for are a real
// on-disk document tree and a JSON file (never a live daemon) — restore.sh
// itself is not invoked or modified.
interface RestoreRehearsalDocumentSpec {
  storageKey: string;
  contentLength: number;
  fillByte: number;
}

interface RestoreRehearsalScenario {
  backupDirectory: string;
  documentKekFile: string;
  liveDocumentsRoot: string;
  liveDatabaseFile: string;
  original: RestoreRehearsalDocumentSpec;
  updated: RestoreRehearsalDocumentSpec;
  mode: "forward" | "recover";
  hardKillAfter?: "checkpoint" | "documents-replaced" | "database-restored";
}

const REHEARSAL_DOCUMENT_ID = "11111111-1111-4111-8111-111111111111";

function buildCorrespondenceReports(spec: RestoreRehearsalDocumentSpec): CorrespondenceReports {
  return {
    crypto: `${REHEARSAL_DOCUMENT_ID}|${spec.storageKey}|${spec.contentLength}|available\n`,
    visible: `${REHEARSAL_DOCUMENT_ID}|available|${spec.storageKey}|${spec.contentLength}\n`,
    attachments: "",
    staging: "",
    documentStaging: "",
    transientCount: "0",
  };
}

function buildDocumentTree(root: string, spec: RestoreRehearsalDocumentSpec): void {
  rmSync(root, { recursive: true, force: true });
  const objectDir = join(root, "objects", spec.storageKey.slice(0, 2), spec.storageKey.slice(2, 4));
  mkdirSync(objectDir, { recursive: true });
  mkdirSync(join(root, "staging"), { recursive: true });
  writeFileSync(join(objectDir, `${spec.storageKey}.bin`), Buffer.alloc(spec.contentLength, spec.fillByte));
}

function writeFakeDatabaseBlob(path: string, spec: RestoreRehearsalDocumentSpec): void {
  writeFileSync(path, JSON.stringify({ reports: buildCorrespondenceReports(spec) }), { mode: 0o600 });
}

function lookupReportField(reports: CorrespondenceReports, query: string): string {
  const entry = (Object.entries(CORRESPONDENCE_QUERIES) as Array<[keyof CorrespondenceReports, string]>).find(([, text]) => text === query);
  if (!entry) throw new Error("orbit: rehearsal fake adapter received an unrecognised correspondence query");
  return reports[entry[0]];
}

class RestoreRehearsalFakeAdapter implements RestoreDockerAdapter {
  private readonly stageContents = new Map<string, CorrespondenceReports>();
  private appRunning = true;

  constructor(
    private readonly liveDocumentsRoot: string,
    private readonly liveDatabaseFile: string,
  ) {}

  dumpDatabase(outputPath: string): void {
    copyFileSync(this.liveDatabaseFile, outputPath);
  }
  pgRestoreListOk(dumpPath: string): boolean {
    try {
      JSON.parse(readFileSync(dumpPath, "utf8"));
      return true;
    } catch {
      return false;
    }
  }
  collectDocumentsArchive(outputPath: string): void {
    createTar(this.liveDocumentsRoot, outputPath, ["."]);
  }
  stopApp(): boolean {
    this.appRunning = false;
    return true;
  }
  startApp(): boolean {
    this.appRunning = true;
    return true;
  }
  createStageDatabase(): void {
    // No real database in this fake: restoreDumpToDatabase records content
    // keyed by name, which is all queryReport needs.
  }
  dropStageDatabase(name: string): void {
    this.stageContents.delete(name);
  }
  restoreDumpToDatabase(name: string, dumpPath: string): boolean {
    const blob = JSON.parse(readFileSync(dumpPath, "utf8")) as { reports: CorrespondenceReports };
    this.stageContents.set(name, blob.reports);
    return true;
  }
  restoreActiveDatabase(dumpPath: string): boolean {
    copyFileSync(dumpPath, this.liveDatabaseFile);
    return true;
  }
  replaceDocumentsFromArchive(archivePath: string): boolean {
    rmSync(this.liveDocumentsRoot, { recursive: true, force: true });
    mkdirSync(this.liveDocumentsRoot, { recursive: true });
    extractTar(archivePath, this.liveDocumentsRoot);
    return true;
  }
  resetScanRecoveryLeases(): boolean {
    return true;
  }
  queryReport(name: string, query: string): string {
    const reports = this.stageContents.get(name);
    if (!reports) throw new Error("orbit: rehearsal fake adapter has no staged content for this database name");
    return lookupReportField(reports, query);
  }
  queryActiveReport(query: string): string {
    const blob = JSON.parse(readFileSync(this.liveDatabaseFile, "utf8")) as { reports: CorrespondenceReports };
    return lookupReportField(blob.reports, query);
  }
  waitForHealth(): boolean {
    return this.appRunning;
  }
  measureLiveDatabaseSizeBytes(): number {
    return 1024;
  }
  measureLiveDocumentTreeKib(): number {
    return 1;
  }
  measureDocumentVolumeAvailableKib(): number {
    return 1_000_000;
  }
}

/**
 * Builds a real, fully-valid backup bundle (five members, HMAC-signed,
 * encrypted document archive — everything verifyBackupBundle/runRestore
 * themselves require) from a document tree + fake database JSON blob, using
 * a throwaway BackupDockerAdapter pointed at that content — not the
 * scenario's own "live" adapter/state, which must stay untouched until
 * runRestore's real cutover mutates it. This is what makes the rehearsal
 * below exercise the true orchestrated flow (issue #296 slice 4): the
 * "updated" bundle runRestore() consumes is produced exactly the way
 * `orbit backup` would produce one, via the same createBackupBundle
 * (slice 2) the real command calls.
 */
function buildRehearsalUpdateBundle(spec: RestoreRehearsalDocumentSpec, documentKekHex: string, scratchRoot: string): string {
  const sourceRoot = join(scratchRoot, "source");
  const documentsRoot = join(sourceRoot, "documents");
  mkdirSync(documentsRoot, { recursive: true });
  buildDocumentTree(documentsRoot, spec);
  const databaseFile = join(sourceRoot, "database.json");
  writeFakeDatabaseBlob(databaseFile, spec);

  const sourceAdapter: BackupDockerAdapter = {
    stopApp(): void {},
    startApp(): void {},
    dumpDatabase(outputPath: string): void {
      copyFileSync(databaseFile, outputPath);
    },
    pgRestoreListOk(dumpPath: string): boolean {
      try {
        JSON.parse(readFileSync(dumpPath, "utf8"));
        return true;
      } catch {
        return false;
      }
    },
    collectDocumentsArchive(outputPath: string): void {
      createTar(documentsRoot, outputPath, ["."]);
    },
  };

  const bundleDirectory = join(scratchRoot, "bundle-source");
  const result = runBackup({ backupDirectory: bundleDirectory, documentKekHex, adapter: sourceAdapter, now: new Date() });
  return result.finalTarPath;
}

function commandRestoreEngineRehearse(scenarioPath: string): never {
  const scenario = JSON.parse(readFileSync(scenarioPath, "utf8")) as RestoreRehearsalScenario;
  const adapter = new RestoreRehearsalFakeAdapter(scenario.liveDocumentsRoot, scenario.liveDatabaseFile);
  const paths = deriveRestorePaths(scenario.backupDirectory, scenario.documentKekFile);

  if (scenario.mode === "recover") {
    const workDir = mkdtempSync(join(scenario.backupDirectory, ".rehearsal-recover-work."));
    try {
      recoverRestore({ adapter, paths, workDir });
      process.stdout.write("outcome=recovered\n");
      process.exit(0);
    } catch (error) {
      process.stdout.write(`outcome=failed message=${(error as Error).message}\n`);
      process.exit(1);
    }
  }

  buildDocumentTree(scenario.liveDocumentsRoot, scenario.original);
  writeFakeDatabaseBlob(scenario.liveDatabaseFile, scenario.original);

  const documentKekHex = readFileSync(scenario.documentKekFile, "utf8").replace(/[\r\n]+$/, "");
  const bundleScratchDir = mkdtempSync(join(scenario.backupDirectory, ".rehearsal-updated-bundle."));
  const updatedBundlePath = buildRehearsalUpdateBundle(scenario.updated, documentKekHex, bundleScratchDir);

  // Drives the real orchestrated flow (src/lib/backup-restore-cli.ts's
  // runRestore — the same function `orbit restore` itself calls), not a
  // hand-assembled sequence of RestoreRun calls: this is what "extends the
  // SIGKILL rehearsal matrix to cover the orchestrated flow" means in
  // practice — the staged-bundle preflight and check_capacity (#11-12) now
  // run for real ahead of the checkpoint, and the SIGKILL points below are
  // the same testHooks the orchestration itself exposes, not steps
  // duplicated here.
  const workDir = mkdtempSync(join(scenario.backupDirectory, ".rehearsal-work."));
  try {
    const result = runRestore({
      backupTarPath: updatedBundlePath,
      documentKekHex,
      paths,
      adapter,
      workDir,
      confirm: () => true,
      testHooks: {
        afterCheckpoint: () => {
          if (scenario.hardKillAfter === "checkpoint") process.kill(process.pid, "SIGKILL");
        },
        afterDocumentsReplaced: () => {
          if (scenario.hardKillAfter === "documents-replaced") process.kill(process.pid, "SIGKILL");
        },
        afterDatabaseRestored: () => {
          if (scenario.hardKillAfter === "database-restored") process.kill(process.pid, "SIGKILL");
        },
      },
    });
    process.stdout.write(`outcome=${result.outcome}\n`);
    process.exit(0);
  } catch (error) {
    process.stdout.write(`outcome=failed message=${(error as Error).message}\n`);
    process.exit(1);
  }
}

function main(): void {
  const [, , command, ...rest] = process.argv;

  if (command === "__install-transaction-rehearse") {
    const scenarioPath = rest[0];
    if (!scenarioPath) fail("orbit: __install-transaction-rehearse requires a scenario file path");
    commandInstallTransactionRehearse(scenarioPath);
    return;
  }

  if (command === "__restore-engine-rehearse") {
    const scenarioPath = rest[0];
    if (!scenarioPath) fail("orbit: __restore-engine-rehearse requires a scenario file path");
    commandRestoreEngineRehearse(scenarioPath);
    return;
  }

  let deployDir = process.cwd();
  const commandArgs: string[] = [];
  for (let index = 0; index < rest.length; index += 1) {
    if (rest[index] === "--dir" && rest[index + 1]) {
      deployDir = resolve(rest[index + 1]);
      index += 1;
    } else {
      commandArgs.push(rest[index]);
    }
  }

  try {
    switch (command) {
      case "check":
        if (commandArgs.length > 0) fail(`orbit: unknown option ${commandArgs[0]}`);
        commandCheck(deployDir);
        break;
      case "backup":
        commandBackup(deployDir, commandArgs);
        break;
      case "restore":
        commandRestore(deployDir, commandArgs);
        break;
      case "export-recovery-bundle":
        commandExportRecoveryBundle(deployDir, commandArgs);
        break;
      case "import-recovery-bundle":
        commandImportRecoveryBundle(deployDir, commandArgs);
        break;
      default:
        failUsage();
    }
  } catch (error) {
    // Every refusal class in the three modules this CLI wires together
    // throws a stable, category-only message (no secret material, no
    // attacker-controlled path/member names — asserted by each module's own
    // no-leak sweep), so surfacing `error.message` directly here is safe;
    // anything else is a genuine bug and should keep its stack trace.
    if (error instanceof RecoveryBundleRefusal || error instanceof RestoreEngineRefusal || error instanceof BackupRestoreCliRefusal) {
      fail(`orbit: ${error.message}`);
    }
    throw error;
  }
}

function failUsage(): never {
  fail("orbit: supported commands: check, backup, restore, export-recovery-bundle, import-recovery-bundle [--dir <deployment>]");
}

main();
