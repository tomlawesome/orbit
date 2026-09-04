import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  BackupRestoreCliRefusal,
  runBackup,
  runExportRecoveryBundle,
  runImportRecoveryBundle,
  runRestore,
  stageAndPreflightRestoreBundle,
  verifyBackupBundle,
} from "./backup-restore-cli";
import {
  RecoveryBundleRefusal,
  createTar,
  decryptDocumentKek,
  extractTar,
  isValidDocumentKekHex,
  validateRecoveryBundleLayout,
  validateRecoveryManifestFormatVersion,
  verifyRecoveryBundleChecksums,
} from "./recovery-bundle";
import { CORRESPONDENCE_QUERIES, type CorrespondenceReports, type RestoreDockerAdapter, RestoreEngineRefusal, deriveRestorePaths } from "./restore-engine";

// Orchestration coverage for issue #296 slice 4
// (docs/adr-notes/296-backup-port-plan.md): every function in
// backup-restore-cli.ts exercised end-to-end against a trivial in-memory
// fake adapter (no process spawning, no Docker daemon — same "(1) in-memory
// fake adapter" layer recovery-bundle.docker-adapter.test.ts and
// restore-engine.docker-adapter.test.ts already established), proving the
// pieces are actually wired together and that every live mutation still
// goes through RestoreRun's journal/checkpoint machinery.

const DOCUMENT_ID = "11111111-1111-4111-8111-111111111111";
const LIVE_KEK = "a".repeat(64);
const ORIGINAL_KEY = "c".repeat(64);
const UPDATED_KEY = "d".repeat(64);

function reportsFor(storageKey: string, contentLength: number): CorrespondenceReports {
  return {
    crypto: `${DOCUMENT_ID}|${storageKey}|${contentLength}|available\n`,
    visible: `${DOCUMENT_ID}|available|${storageKey}|${contentLength}\n`,
    attachments: "",
    staging: "",
    documentStaging: "",
    transientCount: "0",
  };
}

function lookupReportField(reports: CorrespondenceReports, query: string): string {
  const entry = (Object.entries(CORRESPONDENCE_QUERIES) as Array<[keyof CorrespondenceReports, string]>).find(([, text]) => text === query);
  if (!entry) throw new Error(`unrecognised correspondence query: ${query}`);
  return reports[entry[0]];
}

function buildDocumentTree(root: string, storageKey: string, contentLength: number, fillByte = 5): void {
  rmSync(root, { recursive: true, force: true });
  const objectDir = join(root, "objects", storageKey.slice(0, 2), storageKey.slice(2, 4));
  mkdirSync(objectDir, { recursive: true });
  mkdirSync(join(root, "staging"), { recursive: true });
  writeFileSync(join(objectDir, `${storageKey}.bin`), Buffer.alloc(contentLength, fillByte));
}

/**
 * Satisfies both BackupDockerAdapter (so a real bundle can be built via
 * runBackup) and RestoreDockerAdapter (so runRestore/runImportRecoveryBundle
 * can drive a full checkpoint/cutover/finalize lifecycle against it) — the
 * "Docker/Postgres" it stands in for is a real on-disk document tree plus an
 * in-memory CorrespondenceReports map, never a live daemon.
 */
class FakeAdapter implements RestoreDockerAdapter {
  appRunning = true;
  healthOk = true;
  replaceDocumentsOk = true;
  restoreActiveDatabaseOk = true;
  restoreDumpToDatabaseOk = true;
  resetScanLeasesOk = true;
  corruptStagePreflight = false;
  currentDatabaseBytes = 1024;
  currentDocumentKib = 1;
  volumeAvailableKib = 1_000_000;
  private liveReports: CorrespondenceReports;
  private readonly stageContents = new Map<string, CorrespondenceReports>();

  constructor(
    private liveDocumentsRoot: string,
    initialStorageKey: string,
    initialContentLength: number,
  ) {
    this.liveReports = reportsFor(initialStorageKey, initialContentLength);
  }

  stopApp(): boolean {
    this.appRunning = false;
    return true;
  }
  startApp(): boolean {
    this.appRunning = true;
    return true;
  }
  dumpDatabase(outputPath: string): void {
    writeFileSync(outputPath, JSON.stringify(this.liveReports));
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
  createStageDatabase(): void {
    // no-op
  }
  dropStageDatabase(name: string): void {
    this.stageContents.delete(name);
  }
  restoreDumpToDatabase(name: string, dumpPath: string): boolean {
    if (!this.restoreDumpToDatabaseOk) return false;
    if (this.corruptStagePreflight) {
      this.stageContents.set(name, reportsFor("f".repeat(64), 999));
      return true;
    }
    this.stageContents.set(name, JSON.parse(readFileSync(dumpPath, "utf8")) as CorrespondenceReports);
    return true;
  }
  restoreActiveDatabase(dumpPath: string): boolean {
    if (!this.restoreActiveDatabaseOk) return false;
    this.liveReports = JSON.parse(readFileSync(dumpPath, "utf8")) as CorrespondenceReports;
    return true;
  }
  replaceDocumentsFromArchive(archivePath: string): boolean {
    if (!this.replaceDocumentsOk) return false;
    rmSync(this.liveDocumentsRoot, { recursive: true, force: true });
    mkdirSync(this.liveDocumentsRoot, { recursive: true });
    extractTar(archivePath, this.liveDocumentsRoot);
    return true;
  }
  resetScanRecoveryLeases(): boolean {
    return this.resetScanLeasesOk;
  }
  queryReport(name: string, query: string): string {
    const reports = this.stageContents.get(name);
    if (!reports) throw new Error(`no staged content for ${name}`);
    return lookupReportField(reports, query);
  }
  queryActiveReport(query: string): string {
    return lookupReportField(this.liveReports, query);
  }
  waitForHealth(): boolean {
    return this.healthOk && this.appRunning;
  }
  measureLiveDatabaseSizeBytes(): number {
    return this.currentDatabaseBytes;
  }
  measureLiveDocumentTreeKib(): number {
    return this.currentDocumentKib;
  }
  measureDocumentVolumeAvailableKib(): number {
    return this.volumeAvailableKib;
  }
}

let sandbox: string;

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), "orbit-backup-restore-cli-"));
});

afterEach(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

/** Builds a real, fully-valid backup bundle via runBackup — the same path `orbit backup` itself uses. */
function buildBundle(documentsRoot: string, storageKey: string, contentLength: number, documentKekHex: string, backupDirectory: string): string {
  buildDocumentTree(documentsRoot, storageKey, contentLength);
  const adapter = new FakeAdapter(documentsRoot, storageKey, contentLength);
  return runBackup({ backupDirectory, documentKekHex, adapter, now: new Date("2026-01-01T00:00:00Z") }).finalTarPath;
}

describe("verifyBackupBundle (backup.sh's validate_bundle end-to-end)", () => {
  it("accepts a bundle produced by runBackup", () => {
    const documentsRoot = join(sandbox, "docs");
    const backupDirectory = join(sandbox, "backups");
    const bundlePath = buildBundle(documentsRoot, ORIGINAL_KEY, 10, LIVE_KEK, backupDirectory);
    const adapter = new FakeAdapter(documentsRoot, ORIGINAL_KEY, 10);

    const workDir = mkdtempSync(join(sandbox, "verify-"));
    const { manifestFields } = verifyBackupBundle(bundlePath, LIVE_KEK, workDir, adapter);
    expect(manifestFields.documentKekSha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it("refuses a bundle whose checksums were corrupted after creation", () => {
    const documentsRoot = join(sandbox, "docs");
    const backupDirectory = join(sandbox, "backups");
    const bundlePath = buildBundle(documentsRoot, ORIGINAL_KEY, 10, LIVE_KEK, backupDirectory);
    const adapter = new FakeAdapter(documentsRoot, ORIGINAL_KEY, 10);

    // Tamper: extract, corrupt the manifest's declared checksum algorithm
    // isn't easy to hand-edit inside a tar without a real tar round-trip, so
    // instead corrupt the *encrypted document archive* bytes directly in
    // the published tar via a byte-flip, which fails checksum verification.
    const raw = readFileSync(bundlePath);
    raw[Math.floor(raw.length / 2)] ^= 0xff;
    writeFileSync(bundlePath, raw);

    const workDir = mkdtempSync(join(sandbox, "verify-corrupt-"));
    expect(() => verifyBackupBundle(bundlePath, LIVE_KEK, workDir, adapter)).toThrow();
  });

  it("refuses with the wrong document KEK", () => {
    const documentsRoot = join(sandbox, "docs");
    const backupDirectory = join(sandbox, "backups");
    const bundlePath = buildBundle(documentsRoot, ORIGINAL_KEY, 10, LIVE_KEK, backupDirectory);
    const adapter = new FakeAdapter(documentsRoot, ORIGINAL_KEY, 10);

    const workDir = mkdtempSync(join(sandbox, "verify-wrongkey-"));
    expect(() => verifyBackupBundle(bundlePath, "b".repeat(64), workDir, adapter)).toThrow(RecoveryBundleRefusal);
  });
});

describe("runBackup", () => {
  it("creates the backup directory at mode 0700 and a valid, timestamped bundle", () => {
    const documentsRoot = join(sandbox, "docs");
    buildDocumentTree(documentsRoot, ORIGINAL_KEY, 10);
    const backupDirectory = join(sandbox, "backups");
    const adapter = new FakeAdapter(documentsRoot, ORIGINAL_KEY, 10);

    const result = runBackup({ backupDirectory, documentKekHex: LIVE_KEK, adapter, now: new Date("2026-03-04T05:06:07Z") });

    expect(result.finalTarPath).toBe(join(backupDirectory, "orbit-20260304-050607.tar"));
    expect(existsSync(result.finalTarPath)).toBe(true);
  });
});

describe("stageAndPreflightRestoreBundle (restore.sh's prepare_staged_bundle, guarantees #7-10)", () => {
  it("stages the document tree and passes the private correspondence check for a valid bundle", () => {
    const documentsRoot = join(sandbox, "docs");
    const backupDirectory = join(sandbox, "backups");
    const bundlePath = buildBundle(documentsRoot, ORIGINAL_KEY, 10, LIVE_KEK, backupDirectory);
    const adapter = new FakeAdapter(documentsRoot, ORIGINAL_KEY, 10);

    const workDir = mkdtempSync(join(sandbox, "stage-"));
    const staged = stageAndPreflightRestoreBundle(bundlePath, LIVE_KEK, workDir, adapter, "test-staging-id");
    expect(existsSync(join(staged.stagedDocumentsRoot, "objects", ORIGINAL_KEY.slice(0, 2), ORIGINAL_KEY.slice(2, 4), `${ORIGINAL_KEY}.bin`))).toBe(true);
  });

  it("refuses (preflight-correspondence-failed) when the staged database and document tree don't correspond", () => {
    const documentsRoot = join(sandbox, "docs");
    const backupDirectory = join(sandbox, "backups");
    const bundlePath = buildBundle(documentsRoot, ORIGINAL_KEY, 10, LIVE_KEK, backupDirectory);
    const adapter = new FakeAdapter(documentsRoot, ORIGINAL_KEY, 10);
    adapter.corruptStagePreflight = true;

    const workDir = mkdtempSync(join(sandbox, "stage-corrupt-"));
    expect(() => stageAndPreflightRestoreBundle(bundlePath, LIVE_KEK, workDir, adapter, "test-staging-id-2")).toThrow(RestoreEngineRefusal);
  });
});

describe("runRestore (restore.sh's main flow :897-933, including check_capacity #11-12)", () => {
  function setup(): { documentsRoot: string; backupDirectory: string; restorePaths: ReturnType<typeof deriveRestorePaths>; documentKekFile: string; adapter: FakeAdapter } {
    const documentsRoot = join(sandbox, "live-docs");
    buildDocumentTree(documentsRoot, ORIGINAL_KEY, 10);
    const backupDirectory = join(sandbox, "backups");
    mkdirSync(backupDirectory, { recursive: true, mode: 0o700 });
    const documentKekFile = join(sandbox, "document-kek");
    writeFileSync(documentKekFile, `${LIVE_KEK}\n`, { mode: 0o600 });
    const adapter = new FakeAdapter(documentsRoot, ORIGINAL_KEY, 10);
    const restorePaths = deriveRestorePaths(backupDirectory, documentKekFile);
    return { documentsRoot, backupDirectory, restorePaths, documentKekFile, adapter };
  }

  it("completes end-to-end, replacing live content and leaving no journal/checkpoint", () => {
    const { backupDirectory, restorePaths, adapter } = setup();
    const updatedDocumentsRoot = join(sandbox, "update-source");
    const updateBundlePath = buildBundle(updatedDocumentsRoot, UPDATED_KEY, 22, LIVE_KEK, join(sandbox, "update-backups"));

    const workDir = mkdtempSync(join(sandbox, "restore-run-"));
    const hooks = { checkpoint: 0, docs: 0, db: 0 };
    const result = runRestore({
      backupTarPath: updateBundlePath,
      documentKekHex: LIVE_KEK,
      paths: restorePaths,
      adapter,
      workDir,
      confirm: () => true,
      testHooks: {
        afterCheckpoint: () => hooks.checkpoint++,
        afterDocumentsReplaced: () => hooks.docs++,
        afterDatabaseRestored: () => hooks.db++,
      },
    });

    expect(result.outcome).toBe("completed");
    expect(hooks).toEqual({ checkpoint: 1, docs: 1, db: 1 });
    expect(existsSync(restorePaths.journalPath)).toBe(false);
    expect(existsSync(join(backupDirectory, ".orbit-restore"))).toBe(true); // directory persists, just emptied of checkpoints
  });

  it("refuses (restore-journal-exists) before touching anything if a journal already exists", () => {
    const { restorePaths, adapter } = setup();
    mkdirSync(restorePaths.restoreRoot, { recursive: true, mode: 0o700 });
    writeFileSync(restorePaths.journalPath, "format_version=1\n", { mode: 0o600 });

    const updatedDocumentsRoot = join(sandbox, "update-source-2");
    const updateBundlePath = buildBundle(updatedDocumentsRoot, UPDATED_KEY, 22, LIVE_KEK, join(sandbox, "update-backups-2"));
    const workDir = mkdtempSync(join(sandbox, "restore-run-journal-exists-"));

    let confirmCalled = false;
    expect(() =>
      runRestore({
        backupTarPath: updateBundlePath,
        documentKekHex: LIVE_KEK,
        paths: restorePaths,
        adapter,
        workDir,
        confirm: () => {
          confirmCalled = true;
          return true;
        },
      }),
    ).toThrow(BackupRestoreCliRefusal);
    expect(confirmCalled).toBe(false);
  });

  it("refuses (capacity-insufficient) before ever calling confirm(), when the document volume has no room", () => {
    const { restorePaths, adapter } = setup();
    adapter.volumeAvailableKib = 0; // staged (>0) can never fit with 0 available + tiny current usage
    const updatedDocumentsRoot = join(sandbox, "update-source-3");
    const updateBundlePath = buildBundle(updatedDocumentsRoot, UPDATED_KEY, 22, LIVE_KEK, join(sandbox, "update-backups-3"));
    const workDir = mkdtempSync(join(sandbox, "restore-run-capacity-"));

    let confirmCalled = false;
    expect(() =>
      runRestore({
        backupTarPath: updateBundlePath,
        documentKekHex: LIVE_KEK,
        paths: restorePaths,
        adapter,
        workDir,
        confirm: () => {
          confirmCalled = true;
          return true;
        },
      }),
    ).toThrow(RestoreEngineRefusal);
    expect(confirmCalled).toBe(false);
    expect(existsSync(restorePaths.journalPath)).toBe(false); // no checkpoint was ever attempted
  });

  it("refuses (restore-not-confirmed) and takes no checkpoint when confirm() returns false, only after preflight/capacity already passed", () => {
    const { restorePaths, adapter } = setup();
    const updatedDocumentsRoot = join(sandbox, "update-source-4");
    const updateBundlePath = buildBundle(updatedDocumentsRoot, UPDATED_KEY, 22, LIVE_KEK, join(sandbox, "update-backups-4"));
    const workDir = mkdtempSync(join(sandbox, "restore-run-unconfirmed-"));

    expect(() =>
      runRestore({
        backupTarPath: updateBundlePath,
        documentKekHex: LIVE_KEK,
        paths: restorePaths,
        adapter,
        workDir,
        confirm: () => false,
      }),
    ).toThrow(BackupRestoreCliRefusal);
    expect(existsSync(restorePaths.journalPath)).toBe(false);
    expect(existsSync(restorePaths.restoreRoot)).toBe(false); // createCheckpoint (which mkdirs restoreRoot) was never reached
  });
});

// Real bundles, real crypto: each test here builds an encrypted recovery
// bundle and then imports it, and on a busy runner that does not fit the
// 5 s default -- these are the tests that cost GitLab pipelines 176, 190 and
// 212 a rerun apiece, and #698 raised their budgets once already for the same
// reason on GitHub. 20 s still fails a hung test, which is what the timeout
// is for; it just stops measuring how loaded the box was.
describe("runExportRecoveryBundle (export-recovery-bundle.sh's orchestration)", { timeout: 20_000 }, () => {
  it("produces a recovery bundle whose wrapped KEK decrypts back to the original document KEK", () => {
    const documentsRoot = join(sandbox, "docs");
    const sourceBackupDirectory = join(sandbox, "source-backups");
    const sourceBundlePath = buildBundle(documentsRoot, ORIGINAL_KEY, 10, LIVE_KEK, sourceBackupDirectory);
    const adapter = new FakeAdapter(documentsRoot, ORIGINAL_KEY, 10);

    const recoveryDirectory = join(sandbox, "recovery-backups");
    const passphrase = "correct horse battery staple";
    const result = runExportRecoveryBundle({
      sourceBundlePath,
      documentKekHex: LIVE_KEK,
      passphrase,
      passphraseConfirmation: passphrase,
      backupDirectory: recoveryDirectory,
      adapter,
      now: new Date("2026-02-02T00:00:00Z"),
    });

    expect(result.finalPath).toBe(join(recoveryDirectory, "orbit-recovery-20260202-000000.tar"));
    const workDir = mkdtempSync(join(sandbox, "export-verify-"));
    validateRecoveryBundleLayout(result.finalPath);
    const extractedDir = join(workDir, "extracted");
    mkdirSync(extractedDir, { recursive: true });
    extractTar(result.finalPath, extractedDir);
    validateRecoveryManifestFormatVersion(extractedDir);
    verifyRecoveryBundleChecksums(extractedDir);
    const envelope = readFileSync(join(extractedDir, "document-kek.enc"));
    const recoveredHex = decryptDocumentKek(envelope, passphrase)
      .toString("utf8")
      .replace(/[\r\n]+$/, "");
    expect(recoveredHex).toBe(LIVE_KEK);
    expect(isValidDocumentKekHex(recoveredHex)).toBe(true);
    // The inner bundle is a byte-identical copy of the source.
    expect(readFileSync(join(extractedDir, "orbit-backup.tar"))).toEqual(readFileSync(sourceBundlePath));
  });

  it("publishes the recovery bundle at mode 0600 regardless of the ambient umask (issue #383 finding 5: export-recovery-bundle.sh's `umask 077` was never ported)", () => {
    const documentsRoot = join(sandbox, "docs-mode");
    const sourceBackupDirectory = join(sandbox, "source-backups-mode");
    const sourceBundlePath = buildBundle(documentsRoot, ORIGINAL_KEY, 10, LIVE_KEK, sourceBackupDirectory);
    const adapter = new FakeAdapter(documentsRoot, ORIGINAL_KEY, 10);
    const recoveryDirectory = join(sandbox, "recovery-backups-mode");
    const passphrase = "correct horse battery staple";

    const previousUmask = process.umask(0o022);
    let result: { finalPath: string };
    try {
      result = runExportRecoveryBundle({
        sourceBundlePath,
        documentKekHex: LIVE_KEK,
        passphrase,
        passphraseConfirmation: passphrase,
        backupDirectory: recoveryDirectory,
        adapter,
        now: new Date("2026-02-02T00:00:00Z"),
      });
    } finally {
      process.umask(previousUmask);
    }

    expect(lstatSync(result.finalPath).mode & 0o777).toBe(0o600);
  });

  it("refuses (guarantee #4) when the source bundle itself doesn't verify", () => {
    const documentsRoot = join(sandbox, "docs");
    const sourceBackupDirectory = join(sandbox, "source-backups-2");
    const sourceBundlePath = buildBundle(documentsRoot, ORIGINAL_KEY, 10, LIVE_KEK, sourceBackupDirectory);
    const adapter = new FakeAdapter(documentsRoot, ORIGINAL_KEY, 10);

    const raw = readFileSync(sourceBundlePath);
    raw[Math.floor(raw.length / 2)] ^= 0xff;
    writeFileSync(sourceBundlePath, raw);

    const passphrase = "correct horse battery staple";
    expect(() =>
      runExportRecoveryBundle({
        sourceBundlePath,
        documentKekHex: LIVE_KEK,
        passphrase,
        passphraseConfirmation: passphrase,
        backupDirectory: join(sandbox, "recovery-backups-2"),
        adapter,
        now: new Date(),
      }),
    ).toThrow();
  });

  it("refuses (guarantee #6-7) a too-short passphrase or a confirmation mismatch", () => {
    const documentsRoot = join(sandbox, "docs");
    const sourceBundlePath = buildBundle(documentsRoot, ORIGINAL_KEY, 10, LIVE_KEK, join(sandbox, "source-backups-3"));
    const adapter = new FakeAdapter(documentsRoot, ORIGINAL_KEY, 10);

    expect(() =>
      runExportRecoveryBundle({
        sourceBundlePath,
        documentKekHex: LIVE_KEK,
        passphrase: "short",
        passphraseConfirmation: "short",
        backupDirectory: join(sandbox, "recovery-backups-3"),
        adapter,
        now: new Date(),
      }),
    ).toThrow(RecoveryBundleRefusal);

    expect(() =>
      runExportRecoveryBundle({
        sourceBundlePath,
        documentKekHex: LIVE_KEK,
        passphrase: "correct horse battery staple",
        passphraseConfirmation: "different phrase entirely!!",
        backupDirectory: join(sandbox, "recovery-backups-4"),
        adapter,
        now: new Date(),
      }),
    ).toThrow(RecoveryBundleRefusal);
  });
});

describe("runImportRecoveryBundle (import-recovery-bundle.sh's orchestration, live-KEK-swap-with-rollback)", { timeout: 20_000 }, () => {
  function buildRecoveryBundle(storageKey: string, contentLength: number, documentKekHex: string, passphrase: string): { recoveryBundlePath: string; sourceDocumentsRoot: string } {
    const sourceDocumentsRoot = join(sandbox, `import-source-${storageKey}`);
    const sourceBundlePath = buildBundle(sourceDocumentsRoot, storageKey, contentLength, documentKekHex, join(sandbox, `import-source-backups-${storageKey}`));
    const adapter = new FakeAdapter(sourceDocumentsRoot, storageKey, contentLength);
    const result = runExportRecoveryBundle({
      sourceBundlePath,
      documentKekHex,
      passphrase,
      passphraseConfirmation: passphrase,
      backupDirectory: join(sandbox, `import-recovery-backups-${storageKey}`),
      adapter,
      now: new Date(),
    });
    return { recoveryBundlePath: result.finalPath, sourceDocumentsRoot };
  }

  it("completes: swaps the live KEK, restores the bundle's content, and removes the previous KEK", () => {
    const passphrase = "correct horse battery staple";
    const { recoveryBundlePath } = buildRecoveryBundle(UPDATED_KEY, 22, UPDATED_KEY, passphrase);

    const liveDocumentsRoot = join(sandbox, "live-docs-import");
    buildDocumentTree(liveDocumentsRoot, ORIGINAL_KEY, 10);
    const liveDocumentKekFile = join(sandbox, "live-document-kek");
    writeFileSync(liveDocumentKekFile, `${LIVE_KEK}\n`, { mode: 0o600 });
    const backupDirectory = join(sandbox, "import-target-backups");
    mkdirSync(backupDirectory, { recursive: true, mode: 0o700 });
    const adapter = new FakeAdapter(liveDocumentsRoot, ORIGINAL_KEY, 10);

    const result = runImportRecoveryBundle({
      recoveryBundlePath,
      passphrase,
      liveDocumentKekFile,
      backupDirectory,
      adapter,
      importConfirmed: true,
      confirmRestore: () => true,
    });

    expect(result.outcome).toBe("completed");
    const finalKek = readFileSync(liveDocumentKekFile, "utf8").trim();
    expect(finalKek).toBe(UPDATED_KEY);
    const paths = deriveRestorePaths(backupDirectory, liveDocumentKekFile);
    expect(existsSync(paths.journalPath)).toBe(false);
  });

  // `workDir` (mkdtempSync(join(tmpdir(), ...))) and the live deployment
  // directory are the same filesystem in every other test in this file,
  // since both `sandbox` and the OS tmpdir live under `/tmp`. These two
  // tests instead put the live deployment directory under `/var/tmp`,
  // which is a distinct filesystem from `/tmp` (tmpfs) on Debian/Ubuntu/
  // Fedora hosts (issue #383 finding 1) — skipping only if this particular
  // host doesn't actually expose two filesystems here, in which case the
  // original EXDEV bug is unreproducible and there is nothing to assert.
  const crossDeviceRoot = "/var/tmp";
  const crossDeviceAvailable = existsSync(crossDeviceRoot) && statSync(crossDeviceRoot).dev !== statSync(tmpdir()).dev;

  it.skipIf(!crossDeviceAvailable)(
    "swaps the live KEK across filesystems without crashing (issue #383 finding 1: renameSync throws EXDEV when the live deployment directory and the process's tmpdir are different filesystems)",
    () => {
      const passphrase = "correct horse battery staple";
      const { recoveryBundlePath } = buildRecoveryBundle(UPDATED_KEY, 22, UPDATED_KEY, passphrase);

      const crossSandbox = mkdtempSync(join(crossDeviceRoot, "orbit-backup-restore-cli-xdev-"));
      try {
        const liveDocumentsRoot = join(crossSandbox, "live-docs-import-xdev");
        buildDocumentTree(liveDocumentsRoot, ORIGINAL_KEY, 10);
        const liveDocumentKekFile = join(crossSandbox, "live-document-kek-xdev");
        writeFileSync(liveDocumentKekFile, `${LIVE_KEK}\n`, { mode: 0o600 });
        const backupDirectory = join(crossSandbox, "import-target-backups-xdev");
        mkdirSync(backupDirectory, { recursive: true, mode: 0o700 });
        const adapter = new FakeAdapter(liveDocumentsRoot, ORIGINAL_KEY, 10);

        const result = runImportRecoveryBundle({
          recoveryBundlePath,
          passphrase,
          liveDocumentKekFile,
          backupDirectory,
          adapter,
          importConfirmed: true,
          confirmRestore: () => true,
        });

        expect(result.outcome).toBe("completed");
        expect(readFileSync(liveDocumentKekFile, "utf8").trim()).toBe(UPDATED_KEY);
        // The cross-device fallback preserves the secret-file mode.
        expect(lstatSync(liveDocumentKekFile).mode & 0o777).toBe(0o600);
      } finally {
        rmSync(crossSandbox, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(!crossDeviceAvailable)(
    "reverts the live KEK and restarts the app across filesystems too, when the inner restore fails before leaving journal evidence",
    () => {
      const passphrase = "correct horse battery staple";
      const { recoveryBundlePath } = buildRecoveryBundle(UPDATED_KEY, 22, UPDATED_KEY, passphrase);

      const crossSandbox = mkdtempSync(join(crossDeviceRoot, "orbit-backup-restore-cli-xdev2-"));
      try {
        const liveDocumentsRoot = join(crossSandbox, "live-docs-import-xdev2");
        buildDocumentTree(liveDocumentsRoot, ORIGINAL_KEY, 10);
        const liveDocumentKekFile = join(crossSandbox, "live-document-kek-xdev2");
        writeFileSync(liveDocumentKekFile, `${LIVE_KEK}\n`, { mode: 0o600 });
        const backupDirectory = join(crossSandbox, "import-target-backups-xdev2");
        const adapter = new FakeAdapter(liveDocumentsRoot, ORIGINAL_KEY, 10);

        // Before the fix: the key swap (renameSync at the old line 424) ran
        // outside the try/catch that restarts the app, so an EXDEV here
        // crashed with a raw, un-refused Node error and left the app
        // stopped and the live KEK untouched but orbit-app down.
        expect(() =>
          runImportRecoveryBundle({
            recoveryBundlePath,
            passphrase,
            liveDocumentKekFile,
            backupDirectory,
            adapter,
            importConfirmed: true,
            // The inner restore.sh-equivalent confirmation is declined: no
            // checkpoint is ever taken, so no journal evidence is left
            // behind, and the key swap must be reverted.
            confirmRestore: () => false,
          }),
        ).toThrow();

        expect(readFileSync(liveDocumentKekFile, "utf8").trim()).toBe(LIVE_KEK);
        expect(adapter.appRunning).toBe(true);
        const paths = deriveRestorePaths(backupDirectory, liveDocumentKekFile);
        expect(existsSync(paths.journalPath)).toBe(false);
      } finally {
        rmSync(crossSandbox, { recursive: true, force: true });
      }
    },
  );

  it("refuses (import-not-confirmed) and never touches the live KEK when the operator doesn't confirm", () => {
    const passphrase = "correct horse battery staple";
    const { recoveryBundlePath } = buildRecoveryBundle(UPDATED_KEY, 22, UPDATED_KEY, passphrase);

    const liveDocumentsRoot = join(sandbox, "live-docs-import-2");
    buildDocumentTree(liveDocumentsRoot, ORIGINAL_KEY, 10);
    const liveDocumentKekFile = join(sandbox, "live-document-kek-2");
    writeFileSync(liveDocumentKekFile, `${LIVE_KEK}\n`, { mode: 0o600 });
    const backupDirectory = join(sandbox, "import-target-backups-2");
    const adapter = new FakeAdapter(liveDocumentsRoot, ORIGINAL_KEY, 10);

    expect(() =>
      runImportRecoveryBundle({
        recoveryBundlePath,
        passphrase,
        liveDocumentKekFile,
        backupDirectory,
        adapter,
        importConfirmed: false,
        confirmRestore: () => true,
      }),
    ).toThrow(BackupRestoreCliRefusal);
    expect(readFileSync(liveDocumentKekFile, "utf8").trim()).toBe(LIVE_KEK);
    expect(adapter.appRunning).toBe(true); // stopApp was never called
  });

  it("reverts the live KEK and restarts the app when the inner restore fails before leaving journal evidence", () => {
    const passphrase = "correct horse battery staple";
    const { recoveryBundlePath } = buildRecoveryBundle(UPDATED_KEY, 22, UPDATED_KEY, passphrase);

    const liveDocumentsRoot = join(sandbox, "live-docs-import-3");
    buildDocumentTree(liveDocumentsRoot, ORIGINAL_KEY, 10);
    const liveDocumentKekFile = join(sandbox, "live-document-kek-3");
    writeFileSync(liveDocumentKekFile, `${LIVE_KEK}\n`, { mode: 0o600 });
    const backupDirectory = join(sandbox, "import-target-backups-3");
    const adapter = new FakeAdapter(liveDocumentsRoot, ORIGINAL_KEY, 10);

    expect(() =>
      runImportRecoveryBundle({
        recoveryBundlePath,
        passphrase,
        liveDocumentKekFile,
        backupDirectory,
        adapter,
        importConfirmed: true,
        // The inner restore.sh-equivalent confirmation is declined: no
        // checkpoint is ever taken, so no journal evidence is left behind.
        confirmRestore: () => false,
      }),
    ).toThrow();

    expect(readFileSync(liveDocumentKekFile, "utf8").trim()).toBe(LIVE_KEK);
    expect(adapter.appRunning).toBe(true);
    const paths = deriveRestorePaths(backupDirectory, liveDocumentKekFile);
    expect(existsSync(paths.journalPath)).toBe(false);
  });

  it("preserves durable recovery evidence and leaves the new KEK in place when the inner restore fails after a checkpoint but rollback also fails", () => {
    const passphrase = "correct horse battery staple";
    const { recoveryBundlePath } = buildRecoveryBundle(UPDATED_KEY, 22, UPDATED_KEY, passphrase);

    const liveDocumentsRoot = join(sandbox, "live-docs-import-4");
    buildDocumentTree(liveDocumentsRoot, ORIGINAL_KEY, 10);
    const liveDocumentKekFile = join(sandbox, "live-document-kek-4");
    writeFileSync(liveDocumentKekFile, `${LIVE_KEK}\n`, { mode: 0o600 });
    const backupDirectory = join(sandbox, "import-target-backups-4");
    const adapter = new FakeAdapter(liveDocumentsRoot, ORIGINAL_KEY, 10);

    let checkpointsTaken = 0;
    expect(() =>
      runImportRecoveryBundle({
        recoveryBundlePath,
        passphrase,
        liveDocumentKekFile,
        backupDirectory,
        adapter,
        importConfirmed: true,
        confirmRestore: () => true,
        testHooks: {
          afterCheckpoint: () => {
            checkpointsTaken += 1;
            // Disable document replacement now that the checkpoint has been
            // taken and verified: both the forward cutover *and* the
            // automatic rollback (which reapplies the checkpoint the same
            // way) will fail, forcing dispose() into rollback-failed.
            adapter.replaceDocumentsOk = false;
          },
        },
      }),
    ).toThrow();

    expect(checkpointsTaken).toBe(1);
    // A checkpoint was taken, so the key swap must be left in place — the
    // operator runs `orbit restore --recover`, not a fresh import.
    expect(readFileSync(liveDocumentKekFile, "utf8").trim()).toBe(UPDATED_KEY);
    const paths = deriveRestorePaths(backupDirectory, liveDocumentKekFile);
    expect(existsSync(paths.journalPath)).toBe(true);
    expect(readFileSync(paths.journalPath, "utf8")).toContain("state=rollback-failed");
  });

  it("refuses (restore-journal-exists) up front if an unfinished restore already exists, before decrypting anything", () => {
    const passphrase = "correct horse battery staple";
    const { recoveryBundlePath } = buildRecoveryBundle(UPDATED_KEY, 22, UPDATED_KEY, passphrase);

    const liveDocumentsRoot = join(sandbox, "live-docs-import-5");
    buildDocumentTree(liveDocumentsRoot, ORIGINAL_KEY, 10);
    const liveDocumentKekFile = join(sandbox, "live-document-kek-5");
    writeFileSync(liveDocumentKekFile, `${LIVE_KEK}\n`, { mode: 0o600 });
    const backupDirectory = join(sandbox, "import-target-backups-5");
    const paths = deriveRestorePaths(backupDirectory, liveDocumentKekFile);
    mkdirSync(paths.restoreRoot, { recursive: true, mode: 0o700 });
    writeFileSync(paths.journalPath, "format_version=1\n", { mode: 0o600 });
    const adapter = new FakeAdapter(liveDocumentsRoot, ORIGINAL_KEY, 10);

    expect(() =>
      runImportRecoveryBundle({
        recoveryBundlePath,
        passphrase,
        liveDocumentKekFile,
        backupDirectory,
        adapter,
        importConfirmed: true,
        confirmRestore: () => true,
      }),
    ).toThrow(BackupRestoreCliRefusal);
    expect(readFileSync(liveDocumentKekFile, "utf8").trim()).toBe(LIVE_KEK);
  });

  it("refuses with a wrong passphrase", () => {
    const passphrase = "correct horse battery staple";
    const { recoveryBundlePath } = buildRecoveryBundle(UPDATED_KEY, 22, UPDATED_KEY, passphrase);

    const liveDocumentsRoot = join(sandbox, "live-docs-import-6");
    buildDocumentTree(liveDocumentsRoot, ORIGINAL_KEY, 10);
    const liveDocumentKekFile = join(sandbox, "live-document-kek-6");
    writeFileSync(liveDocumentKekFile, `${LIVE_KEK}\n`, { mode: 0o600 });
    const backupDirectory = join(sandbox, "import-target-backups-6");
    const adapter = new FakeAdapter(liveDocumentsRoot, ORIGINAL_KEY, 10);

    expect(() =>
      runImportRecoveryBundle({
        recoveryBundlePath,
        passphrase: "a completely different passphrase!!",
        liveDocumentKekFile,
        backupDirectory,
        adapter,
        importConfirmed: true,
        confirmRestore: () => true,
      }),
    ).toThrow(RecoveryBundleRefusal);
    expect(readFileSync(liveDocumentKekFile, "utf8").trim()).toBe(LIVE_KEK);
  });
});
