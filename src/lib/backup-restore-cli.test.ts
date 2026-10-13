import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// #1316 PR2-7: a test can make statfs report a small free space for one
// directory tree (the work directory) and the truth everywhere else. Inert
// unless `statfsOverride.directory` is set.
const statfsOverride = vi.hoisted(() => ({ directory: undefined as string | undefined, freeKib: 0 }));
//
// #1316 (publish durability): the same mock also records, in call order, every
// fsync, link and unlink, with the path each fsync'd descriptor was opened
// on. Everything still runs for real; the wrappers only observe.
const fsEvents = vi.hoisted(() => ({
  recording: false,
  log: [] as { op: "fsync" | "link" | "unlink"; path: string }[],
  fdPaths: new Map<number, string>(),
}));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    openSync: ((path: import("node:fs").PathLike, ...rest: unknown[]) => {
      const fd = (actual.openSync as (...args: unknown[]) => number)(path, ...rest);
      fsEvents.fdPaths.set(fd, String(path));
      return fd;
    }) as typeof actual.openSync,
    closeSync: ((fd: number) => {
      fsEvents.fdPaths.delete(fd);
      return actual.closeSync(fd);
    }) as typeof actual.closeSync,
    fsyncSync: ((fd: number) => {
      if (fsEvents.recording) fsEvents.log.push({ op: "fsync", path: fsEvents.fdPaths.get(fd) ?? `<unknown fd ${fd}>` });
      return actual.fsyncSync(fd);
    }) as typeof actual.fsyncSync,
    linkSync: ((existing: import("node:fs").PathLike, created: import("node:fs").PathLike) => {
      if (fsEvents.recording) fsEvents.log.push({ op: "link", path: String(existing) });
      return actual.linkSync(existing, created);
    }) as typeof actual.linkSync,
    unlinkSync: ((path: import("node:fs").PathLike) => {
      if (fsEvents.recording) fsEvents.log.push({ op: "unlink", path: String(path) });
      return actual.unlinkSync(path);
    }) as typeof actual.unlinkSync,
    statfsSync: ((path: import("node:fs").PathLike, ...rest: unknown[]) => {
      const real = (actual.statfsSync as (...args: unknown[]) => import("node:fs").StatsFs)(path, ...rest);
      const directory = statfsOverride.directory;
      return directory !== undefined && String(path).startsWith(directory) ? { ...real, bsize: 1024, bavail: statfsOverride.freeKib, bfree: statfsOverride.freeKib } : real;
    }) as typeof actual.statfsSync,
  };
});

import {
  BackupRestoreCliRefusal,
  runBackup,
  runExportRecoveryBundle,
  runFinishRestore,
  runImportRecoveryBundle,
  runRecoverRestore,
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
import { CORRESPONDENCE_QUERIES, type CorrespondenceReports, type RestoreDockerAdapter, RestoreEngineRefusal, deriveRestorePaths, loadRestoreJournal } from "./restore-engine";

// Orchestration coverage for issue #296 slice 4
// (docs/adr-notes/296-backup-port-plan.md): every function in
// backup-restore-cli.ts exercised end-to-end against a trivial in-memory
// fake adapter (no process spawning, no Docker daemon — same "(1) in-memory
// fake adapter" layer recovery-bundle.backup.test.ts and
// restore-engine.lifecycle.test.ts already established), proving the
// pieces are actually wired together and that every live mutation still
// goes through RestoreRun's journal/checkpoint machinery.

const DOCUMENT_ID = "11111111-1111-4111-8111-111111111111";
const LIVE_KEK = "a".repeat(64);
const ORIGINAL_KEY = "c".repeat(64);
const UPDATED_KEY = "d".repeat(64);

// The other party in the backup/restore lock tests is the real `flock`
// utility, used the way scripts/backup.sh and scripts/restore.sh use it.
function sleepMs(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** True when nobody holds the flock: `flock -n <file> true` exits 0. */
function lockIsFree(lockPath: string): boolean {
  return spawnSync("flock", ["-n", lockPath, "true"]).status === 0;
}

function waitForLock(lockPath: string, free: boolean): void {
  const deadline = Date.now() + 10_000;
  while (lockIsFree(lockPath) !== free) {
    if (Date.now() > deadline) throw new Error(`flock at ${lockPath} never became ${free ? "free" : "held"}`);
    sleepMs(20);
  }
}

/** Holds the flock from another process, as a running backup.sh/restore.sh does. */
function holdLockInAnotherProcess(lockPath: string): ChildProcess {
  const holder = spawn("flock", [lockPath, "-c", "sleep 30"], { detached: true, stdio: "ignore" });
  waitForLock(lockPath, false);
  return holder;
}

function killLockHolder(holder: ChildProcess, lockPath: string): void {
  // The process group: flock -c runs `sleep` in a child that shares the fd.
  if (holder.pid !== undefined) process.kill(-holder.pid, "SIGKILL");
  waitForLock(lockPath, true);
}

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
  stopOk = true;
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

  stopCalls = 0;
  /** Stage databases created and not yet dropped. */
  readonly openStageDatabases = new Set<string>();
  stageDatabasesCreated = 0;

  stopApp(): boolean {
    this.stopCalls += 1;
    if (!this.stopOk) return false;
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
  recordExportedCalls = 0;
  recordExportedOk = true;
  recordRecoveryBundleExported(): void {
    this.recordExportedCalls += 1;
    if (!this.recordExportedOk) throw new RecoveryBundleRefusal("record failed", "recovery-bundle-record-failed");
  }
  /** Every stage-database create and drop, in call order: "create:<name>" / "drop:<name>". */
  readonly stageEvents: string[] = [];
  /**
   * #1316 (leftover stage databases): the existing orbit_restore_stage_*
   * databases, by name (the ones this fake created and not yet dropped, plus
   * any a test seeds into openStageDatabases as a killed earlier run's leftovers).
   */
  listStageDatabases(): string[] {
    return [...this.openStageDatabases].filter((name) => name.startsWith("orbit_restore_stage_"));
  }
  createStageDatabase(name: string): void {
    this.stageEvents.push(`create:${name}`);
    this.openStageDatabases.add(name);
    this.stageDatabasesCreated += 1;
  }
  dropStageDatabase(name: string): void {
    this.stageEvents.push(`drop:${name}`);
    this.openStageDatabases.delete(name);
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

  // #1151 RANGE-R6/RANGE-S3: runBackup used to take no lock at all, so it
  // could race a concurrent orbit restore's stopApp/startApp and document-
  // tree/database cutover — the exact O2-R3 hazard the Bash scripts' shared
  // flock closes. RANGE-S4 is the same gap seen from the other direction:
  // the TS lock was a create-and-close marker file the Bash scripts'
  // `exec {fd}>file; flock -n $fd` neither saw nor respected, so the TS side
  // now takes that same flock on .orbit-backup-restore.lock.
  it("refuses while another process holds the shared flock, and runs once it is released (#1151 RANGE-R6/S3/S4)", () => {
    const documentsRoot = join(sandbox, "docs-backup-lock");
    buildDocumentTree(documentsRoot, ORIGINAL_KEY, 10);
    const backupDirectory = join(sandbox, "backup-lock-backups");
    const adapter = new FakeAdapter(documentsRoot, ORIGINAL_KEY, 10);
    mkdirSync(backupDirectory, { recursive: true, mode: 0o700 });
    const lockPath = join(backupDirectory, ".orbit-backup-restore.lock");
    const holder = holdLockInAnotherProcess(lockPath);

    try {
      let caught: unknown;
      try {
        runBackup({ backupDirectory, documentKekHex: LIVE_KEK, adapter, now: new Date("2026-03-04T05:06:07Z") });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(BackupRestoreCliRefusal);
      expect((caught as BackupRestoreCliRefusal).code).toBe("restore-locked");
      expect(adapter.appRunning).toBe(true); // stopApp was never reached.
      expect(readdirSync(backupDirectory)).toEqual([".orbit-backup-restore.lock"]); // Nothing written.
    } finally {
      killLockHolder(holder, lockPath);
    }

    const result = runBackup({ backupDirectory, documentKekHex: LIVE_KEK, adapter, now: new Date("2026-03-04T05:06:07Z") });
    expect(existsSync(result.finalTarPath)).toBe(true);
  });

  // #1316 R1-4: a restore that exited 0 keeps its journal until restore.sh has
  // seen Orbit healthy and run `restore --finish`, and the lock is free during
  // that wait. A scheduled backup landing then would take the lock and make
  // --finish fail, so backup refuses while a journal exists, before the lock
  // or any stop, and says how to finish it.
  it("R1-4: refuses with restore-unfinished, naming `bash scripts/restore.sh --finish`, while a restore journal exists and no process holds the lock", () => {
    const documentsRoot = join(sandbox, "docs-backup-journal");
    buildDocumentTree(documentsRoot, ORIGINAL_KEY, 10);
    const backupDirectory = join(sandbox, "backup-journal-backups");
    mkdirSync(backupDirectory, { recursive: true, mode: 0o700 });
    const { journalPath } = deriveRestorePaths(backupDirectory, join(sandbox, "document-kek-backup-journal"));
    expect(journalPath).toBe(join(backupDirectory, ".orbit-restore", "restore.journal"));
    mkdirSync(join(backupDirectory, ".orbit-restore"), { recursive: true, mode: 0o700 });
    writeFileSync(journalPath, "format_version=1\nstate=database-restored\n", { mode: 0o600 });
    const adapter = new FakeAdapter(documentsRoot, ORIGINAL_KEY, 10);

    let caught: unknown;
    try {
      runBackup({ backupDirectory, documentKekHex: LIVE_KEK, adapter, now: new Date("2026-03-04T05:06:07Z") });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(BackupRestoreCliRefusal);
    expect((caught as BackupRestoreCliRefusal).code).toBe("restore-unfinished");
    expect((caught as BackupRestoreCliRefusal).message).toContain("bash scripts/restore.sh --finish");
    expect(adapter.stopCalls).toBe(0);
    expect(adapter.appRunning).toBe(true);
    expect(existsSync(journalPath)).toBe(true); // Left alone.
    // Checked under the lock, so the lock file (left in place, as every run
    // leaves it) is there; nothing else: no bundle, no scratch directory.
    expect(readdirSync(backupDirectory).sort()).toEqual([".orbit-backup-restore.lock", ".orbit-restore"]);
  });

  it("holds the shared flock for the whole run and releases it afterwards, leaving the file in place", () => {
    const documentsRoot = join(sandbox, "docs-backup-lock-release");
    buildDocumentTree(documentsRoot, ORIGINAL_KEY, 10);
    const backupDirectory = join(sandbox, "backup-lock-release-backups");
    const adapter = new FakeAdapter(documentsRoot, ORIGINAL_KEY, 10);
    const lockPath = join(backupDirectory, ".orbit-backup-restore.lock");
    let freeDuringRun: boolean | undefined;
    const stopApp = adapter.stopApp.bind(adapter);
    adapter.stopApp = () => {
      freeDuringRun = lockIsFree(lockPath);
      return stopApp();
    };

    runBackup({ backupDirectory, documentKekHex: LIVE_KEK, adapter, now: new Date("2026-03-04T05:06:07Z") });

    expect(freeDuringRun).toBe(false); // A Bash `flock -n` would have refused.
    expect(lockIsFree(lockPath)).toBe(true);
    // Never unlinked: a Bash run blocked on the old inode would hold a lock nobody else sees.
    expect(existsSync(lockPath)).toBe(true);
  });

  it("takes the lock at once when the file exists but nobody holds it (what every Bash run leaves behind)", () => {
    const documentsRoot = join(sandbox, "docs-backup-lock-leftover");
    buildDocumentTree(documentsRoot, ORIGINAL_KEY, 10);
    const backupDirectory = join(sandbox, "backup-lock-leftover-backups");
    const adapter = new FakeAdapter(documentsRoot, ORIGINAL_KEY, 10);
    mkdirSync(backupDirectory, { recursive: true, mode: 0o700 });
    writeFileSync(join(backupDirectory, ".orbit-backup-restore.lock"), "");

    const result = runBackup({ backupDirectory, documentKekHex: LIVE_KEK, adapter, now: new Date("2026-03-04T05:06:07Z") });

    expect(existsSync(result.finalTarPath)).toBe(true);
  });

  // #1316 O2-R3: a backup killed mid-run leaves its scratch directory
  // (.orbit-backup.<random>) and possibly a half-installed
  // <bundle>.tar.installing behind. The next run must sweep both, whatever
  // they contain; today only the .installing file is swept and the stale
  // directory survives (it holds a plaintext database dump).
  it("O2-R3: removes a stale .orbit-backup.* scratch directory and a stale .tar.installing file left by an earlier killed run", () => {
    const documentsRoot = join(sandbox, "docs-backup-stale");
    buildDocumentTree(documentsRoot, ORIGINAL_KEY, 10);
    const backupDirectory = join(sandbox, "backup-stale-backups");
    const adapter = new FakeAdapter(documentsRoot, ORIGINAL_KEY, 10);
    mkdirSync(backupDirectory, { recursive: true, mode: 0o700 });
    const staleDirectory = join(backupDirectory, ".orbit-backup.stale");
    mkdirSync(staleDirectory, { mode: 0o700 });
    writeFileSync(join(staleDirectory, "database.dump"), "partial dump");
    const staleInstalling = join(backupDirectory, "orbit-x.tar.installing");
    writeFileSync(staleInstalling, "half a bundle");

    const result = runBackup({ backupDirectory, documentKekHex: LIVE_KEK, adapter, now: new Date("2026-03-04T05:06:07Z") });

    expect(existsSync(result.finalTarPath)).toBe(true);
    expect(existsSync(staleDirectory)).toBe(false);
    expect(existsSync(staleInstalling)).toBe(false);
  });

  // The backup runs in a real child process, signalled while the adapter is
  // dumping (a blocking call stands in for pg_dump), as a supervisor's stop
  // or Ctrl-C would. The engine is crash-only (#1316 note 35314): it installs
  // no signal handler, so the signal ends the process on the spot and the
  // scratch directory is left behind; the NEXT backup sweeps it.
  it("O2-R3: a SIGTERM while the adapter is dumping leaves the .orbit-backup.* scratch in place, and the next runBackup removes it", async () => {
    const documentsRoot = join(sandbox, "docs-backup-sigterm");
    buildDocumentTree(documentsRoot, ORIGINAL_KEY, 10);
    const backupDirectory = join(sandbox, "backup-sigterm-backups");
    mkdirSync(backupDirectory, { recursive: true, mode: 0o700 });

    const srcLib = import.meta.dirname;
    const childScript = join(sandbox, "backup-sigterm-child.mts");
    writeFileSync(
      childScript,
      `import { spawnSync } from "node:child_process";
import { writeFileSync, writeSync } from "node:fs";
import { runBackup } from ${JSON.stringify(join(srcLib, "backup-restore-cli.ts"))};
import { createTar } from ${JSON.stringify(join(srcLib, "recovery-bundle.ts"))};

const config = JSON.parse(process.argv[2]);
const reports = {
  crypto: config.documentId + "|" + config.storageKey + "|10|available\\n",
  visible: config.documentId + "|available|" + config.storageKey + "|10\\n",
  attachments: "",
  staging: "",
  documentStaging: "",
  transientCount: "0",
};
const adapter = {
  stopApp: () => true,
  startApp: () => true,
  dumpDatabase: (output) => {
    writeFileSync(output, JSON.stringify(reports));
    writeSync(1, "dumping\\n");
    spawnSync("sleep", ["1"]);
  },
  pgRestoreListOk: () => true,
  collectDocumentsArchive: (output) => createTar(config.documentsRoot, output, ["."]),
  recordRecoveryBundleExported: () => {},
};
runBackup({
  backupDirectory: config.backupDirectory,
  documentKekHex: config.kek,
  adapter,
  now: new Date("2026-03-04T05:06:07Z"),
});
`,
    );

    const { stdout, stderr, killedOnDeadline, status, signal } = await new Promise<{ stdout: string; stderr: string; killedOnDeadline: boolean; status: number | null; signal: NodeJS.Signals | null }>((resolvePromise, reject) => {
      const child = spawn(
        "node",
        [
          "--import",
          "tsx",
          childScript,
          JSON.stringify({ documentId: DOCUMENT_ID, storageKey: ORIGINAL_KEY, documentsRoot, backupDirectory, kek: LIVE_KEK }),
        ],
        { cwd: process.cwd(), detached: true, stdio: ["ignore", "pipe", "pipe"] },
      );
      let out = "";
      let err = "";
      let signalled = false;
      let killedOnDeadline = false;
      const deadline = setTimeout(() => {
        killedOnDeadline = true;
        process.kill(-child.pid!, "SIGKILL");
      }, 15_000);
      child.stdout.on("data", (chunk: Buffer) => {
        out += chunk.toString();
        if (!signalled && out.includes("dumping")) {
          signalled = true;
          // Let the blocking call start, then signal the backup process alone.
          setTimeout(() => process.kill(child.pid!, "SIGTERM"), 300);
        }
      });
      child.stderr.on("data", (chunk: Buffer) => {
        err += chunk.toString();
      });
      child.on("error", (error) => {
        clearTimeout(deadline);
        reject(error);
      });
      child.on("close", (closeStatus, closeSignal) => {
        clearTimeout(deadline);
        resolvePromise({ stdout: out, stderr: err, killedOnDeadline, status: closeStatus, signal: closeSignal });
      });
    });

    expect(stdout, `the child never reached the dump step (stderr: ${stderr})`).toContain("dumping");
    expect(killedOnDeadline).toBe(false);
    const scratchDirectories = () => readdirSync(backupDirectory).filter((name) => name.startsWith(".orbit-backup."));
    // The killed run left its scratch directory (with the plaintext dump) behind.
    expect(scratchDirectories()).toHaveLength(1);
    expect({ status, signal }).toEqual({ status: null, signal: "SIGTERM" });

    // A following backup sweeps it, whatever it holds.
    const result = runBackup({
      backupDirectory,
      documentKekHex: LIVE_KEK,
      adapter: new FakeAdapter(documentsRoot, ORIGINAL_KEY, 10),
      now: new Date("2026-03-04T06:06:07Z"),
    });
    expect(existsSync(result.finalTarPath)).toBe(true);
    expect(scratchDirectories()).toEqual([]);
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

  it("completes end-to-end, replacing live content (the journal and checkpoint stay until `restore --finish`, #1316 O2-S1)", () => {
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
    expect(existsSync(join(backupDirectory, ".orbit-restore"))).toBe(true);
  });

  // #1316 O2-S1 (owner decision, note 35310): the shell runs `restore --finish`
  // only after Orbit has passed its health check, so a successful runRestore
  // keeps the journal and checkpoint; a failed health check can then still be
  // undone with `restore --recover`. runFinishRestore is the new `--finish`.
  describe("the journal and checkpoint outlive a successful restore until --finish (#1316 O2-S1)", () => {
    const PRE_RESTORE_KEY = "e".repeat(64);
    const checkpointDirectories = (restoreRoot: string): string[] => readdirSync(restoreRoot).filter((name) => name.startsWith("checkpoint-"));

    /** A restore that succeeded over a live key that is not the pre-restore one (an import swapped it in; the rollback file holds the old one). */
    function restoreOverSwappedKey(): ReturnType<typeof setup> & { rollbackFile: string } {
      const context = setup();
      const rollbackFile = join(sandbox, "document-kek.import-rollback");
      writeFileSync(rollbackFile, `${PRE_RESTORE_KEY}\n`, { mode: 0o600 });
      const updateBundlePath = buildBundle(join(sandbox, "update-source-finish"), UPDATED_KEY, 22, LIVE_KEK, join(sandbox, "update-backups-finish"));
      const result = runRestore({
        backupTarPath: updateBundlePath,
        documentKekHex: LIVE_KEK,
        paths: context.restorePaths,
        adapter: context.adapter,
        workDir: mkdtempSync(join(sandbox, "restore-run-finish-")),
        confirm: () => true,
        rollbackDocumentKekFile: rollbackFile,
      });
      expect(result.outcome).toBe("completed");
      return { ...context, rollbackFile };
    }

    it("a successful runRestore leaves the journal and the checkpoint directory on disk", () => {
      const { restorePaths } = restoreOverSwappedKey();
      expect(existsSync(restorePaths.journalPath)).toBe(true);
      const { checkpointDirectory } = loadRestoreJournal(restorePaths.journalPath, restorePaths.restoreRoot);
      expect(existsSync(checkpointDirectory)).toBe(true);
      expect(checkpointDirectories(restorePaths.restoreRoot)).toHaveLength(1);
    });

    it("recoverRestore on them puts back the pre-restore database, documents and key", () => {
      const { documentsRoot, restorePaths, adapter, documentKekFile } = restoreOverSwappedKey();
      // The restore really did replace the live content first.
      expect(adapter.queryActiveReport(CORRESPONDENCE_QUERIES.crypto)).toBe(reportsFor(UPDATED_KEY, 22).crypto);
      expect(existsSync(join(documentsRoot, "objects", UPDATED_KEY.slice(0, 2), UPDATED_KEY.slice(2, 4), `${UPDATED_KEY}.bin`))).toBe(true);

      const result = runRecoverRestore({ adapter, paths: restorePaths, workDir: mkdtempSync(join(sandbox, "recover-after-restore-")) });

      expect(result.outcome).toBe("completed");
      expect(adapter.queryActiveReport(CORRESPONDENCE_QUERIES.crypto)).toBe(reportsFor(ORIGINAL_KEY, 10).crypto);
      expect(readFileSync(join(documentsRoot, "objects", ORIGINAL_KEY.slice(0, 2), ORIGINAL_KEY.slice(2, 4), `${ORIGINAL_KEY}.bin`))).toHaveLength(10);
      expect(existsSync(join(documentsRoot, "objects", UPDATED_KEY.slice(0, 2), UPDATED_KEY.slice(2, 4), `${UPDATED_KEY}.bin`))).toBe(false);
      expect(readFileSync(documentKekFile, "utf8").trim()).toBe(PRE_RESTORE_KEY);
      expect(existsSync(restorePaths.journalPath)).toBe(false);
    });

    it("runFinishRestore removes the journal and the checkpoint directory and leaves the restored content alone", () => {
      const { documentsRoot, restorePaths, adapter, documentKekFile } = restoreOverSwappedKey();

      runFinishRestore({ paths: restorePaths });

      expect(existsSync(restorePaths.journalPath)).toBe(false);
      expect(checkpointDirectories(restorePaths.restoreRoot)).toEqual([]);
      expect(adapter.queryActiveReport(CORRESPONDENCE_QUERIES.crypto)).toBe(reportsFor(UPDATED_KEY, 22).crypto);
      expect(existsSync(join(documentsRoot, "objects", UPDATED_KEY.slice(0, 2), UPDATED_KEY.slice(2, 4), `${UPDATED_KEY}.bin`))).toBe(true);
      expect(readFileSync(documentKekFile, "utf8").trim()).toBe(LIVE_KEK);
    });

    it("runFinishRestore is a no-op when there is no journal", () => {
      const { restorePaths } = setup();
      mkdirSync(restorePaths.restoreRoot, { recursive: true, mode: 0o700 });

      expect(() => runFinishRestore({ paths: restorePaths })).not.toThrow();
      expect(readdirSync(restorePaths.restoreRoot)).toEqual([]);
      // Twice in a row is just as quiet (the shell may be re-run).
      expect(() => runFinishRestore({ paths: restorePaths })).not.toThrow();
    });
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

  // Amendment E3a: restore.sh runs this while Orbit is still up, so it must
  // change nothing live and leave nothing behind for the journal rule to read.
  describe("preflightOnly (the shell's `restore --preflight`, amendment E3a)", () => {
    it("passes a good bundle and returns before confirm(): no stop, no journal, no checkpoint, stage database dropped, lock released", () => {
      const { backupDirectory, restorePaths, adapter } = setup();
      const updateBundlePath = buildBundle(join(sandbox, "preflight-source"), UPDATED_KEY, 22, LIVE_KEK, join(sandbox, "preflight-backups"));
      const workDir = mkdtempSync(join(sandbox, "restore-preflight-"));
      let confirmCalled = false;

      const result = runRestore({
        backupTarPath: updateBundlePath,
        documentKekHex: LIVE_KEK,
        paths: restorePaths,
        adapter,
        workDir,
        preflightOnly: true,
        confirm: () => {
          confirmCalled = true;
          return true;
        },
      });

      expect(result.outcome).toBe("preflight-passed");
      expect(confirmCalled).toBe(false);
      expect(adapter.stopCalls).toBe(0);
      expect(adapter.appRunning).toBe(true);
      expect(existsSync(restorePaths.journalPath)).toBe(false);
      expect(existsSync(restorePaths.restoreRoot)).toBe(false);
      expect(adapter.stageDatabasesCreated).toBeGreaterThan(0);
      expect([...adapter.openStageDatabases]).toEqual([]);
      expect(adapter.queryActiveReport(CORRESPONDENCE_QUERIES.crypto)).toBe(reportsFor(ORIGINAL_KEY, 10).crypto); // live database untouched
      expect(lockIsFree(join(backupDirectory, ".orbit-backup-restore.lock"))).toBe(true);
    });

    // #1316 PR2-7: the bundle used to be extracted into the work directory
    // (tmpdir(), on the Docker data disk under the live database) and only
    // then checked against free space. The free space of the work directory is
    // injected by answering statfs for paths under it; the bundle itself is an
    // ordinary small one whose listed member sizes exceed that answer.
    it("#1316 PR2-7: refuses a bundle whose listed sizes exceed the work directory's free space before extracting, stopping the app or creating a stage database", () => {
      const { restorePaths, adapter } = setup();
      const bundlePath = buildBundle(join(sandbox, "preflight-space-source"), UPDATED_KEY, 64 * 1024, LIVE_KEK, join(sandbox, "preflight-space-backups"));
      const workDir = mkdtempSync(join(sandbox, "restore-preflight-space-"));
      // 8 KiB free under the work directory; everything else answers truthfully.
      statfsOverride.directory = workDir;
      statfsOverride.freeKib = 8;
      let confirmCalled = false;
      let error: unknown;
      try {
        runRestore({
          backupTarPath: bundlePath,
          documentKekHex: LIVE_KEK,
          paths: restorePaths,
          adapter,
          workDir,
          preflightOnly: true,
          confirm: () => {
            confirmCalled = true;
            return true;
          },
        });
      } catch (caught) {
        error = caught;
      } finally {
        statfsOverride.directory = undefined;
      }

      expect(error, "the preflight accepted a bundle larger than the work directory's free space").toBeInstanceOf(Error);
      // The bundle's own extraction refuses, not the later decrypt-step check
      // ("Document archive decryption failed; not enough space ...").
      expect((error as Error).message).toMatch(/^Bundle archive could not be extracted; not enough space to stage/i);
      // Nothing was written into the work directory (empty directories do not count).
      const leftovers: string[] = [];
      const walk = (dir: string): void => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          if (entry.isDirectory()) walk(join(dir, entry.name));
          else leftovers.push(join(dir, entry.name));
        }
      };
      walk(workDir);
      expect(leftovers).toEqual([]);
      // Refused before the stage database and before anything live was touched.
      expect(adapter.stageDatabasesCreated).toBe(0);
      expect(adapter.stopCalls).toBe(0);
      expect(adapter.appRunning).toBe(true);
      expect(confirmCalled).toBe(false);
      expect(existsSync(restorePaths.journalPath)).toBe(false);
      expect(existsSync(restorePaths.restoreRoot)).toBe(false);
    });

    it("refuses a bundle sealed with another key with the full run's own message", () => {
      const { restorePaths, adapter } = setup();
      const otherKeyBundle = buildBundle(join(sandbox, "preflight-wrong-key-source"), UPDATED_KEY, 22, "b".repeat(64), join(sandbox, "preflight-wrong-key-backups"));
      const attempt = (preflightOnly: boolean): Error => {
        try {
          runRestore({
            backupTarPath: otherKeyBundle,
            documentKekHex: LIVE_KEK,
            paths: restorePaths,
            adapter,
            workDir: mkdtempSync(join(sandbox, "restore-preflight-wrong-key-")),
            preflightOnly,
            confirm: () => true,
          });
        } catch (error) {
          return error as Error;
        }
        throw new Error(`a ${preflightOnly ? "preflight" : "full"} run accepted a bundle sealed with another key`);
      };

      const preflightRefusal = attempt(true);
      expect(preflightRefusal.message).toBe(attempt(false).message);
      expect(adapter.stopCalls).toBe(0);
      expect([...adapter.openStageDatabases]).toEqual([]);
    });

    it("O2-F2: passes while another process holds the backup/restore lock (a preflight changes nothing, so it needs no lock)", () => {
      const { backupDirectory, restorePaths, adapter } = setup();
      const updateBundlePath = buildBundle(join(sandbox, "preflight-lock-source"), UPDATED_KEY, 22, LIVE_KEK, join(sandbox, "preflight-lock-backups"));
      const lockPath = join(backupDirectory, ".orbit-backup-restore.lock");
      const holder = holdLockInAnotherProcess(lockPath);
      try {
        const result = runRestore({
          backupTarPath: updateBundlePath,
          documentKekHex: LIVE_KEK,
          paths: restorePaths,
          adapter,
          workDir: mkdtempSync(join(sandbox, "restore-preflight-lock-")),
          preflightOnly: true,
          confirm: () => true,
        });
        expect(result.outcome).toBe("preflight-passed");
        expect(lockIsFree(lockPath)).toBe(false); // still the other process's
      } finally {
        killLockHolder(holder, lockPath);
      }
    });

    it("O2-F2: leaves a .preparing-marked orphan checkpoint untouched (only a full run may sweep it)", () => {
      const { restorePaths, adapter } = setup();
      const updateBundlePath = buildBundle(join(sandbox, "preflight-orphan-source"), UPDATED_KEY, 22, LIVE_KEK, join(sandbox, "preflight-orphan-backups"));
      const orphan = join(restorePaths.restoreRoot, "checkpoint-AbC123");
      mkdirSync(orphan, { recursive: true, mode: 0o700 });
      writeFileSync(join(orphan, ".preparing"), "");
      writeFileSync(join(orphan, "database.dump"), "a full-size dump");

      const result = runRestore({
        backupTarPath: updateBundlePath,
        documentKekHex: LIVE_KEK,
        paths: restorePaths,
        adapter,
        workDir: mkdtempSync(join(sandbox, "restore-preflight-orphan-")),
        preflightOnly: true,
        confirm: () => true,
      });

      expect(result.outcome).toBe("preflight-passed");
      expect(existsSync(join(orphan, ".preparing"))).toBe(true);
      expect(readFileSync(join(orphan, "database.dump"), "utf8")).toBe("a full-size dump");
    });
  });
});

// Real bundles, real crypto: each test here builds an encrypted recovery
// bundle and then imports it, and on a busy runner that does not fit the
// 5 s default -- these are the tests that cost GitLab pipelines 176, 190 and
// 212 a rerun apiece, and #698 raised their budgets once already for the same
// reason on GitHub. 20 s still fails a hung test, which is what the timeout
// is for; it just stops measuring how loaded the box was.
// #1316 (leftover stage databases): a restore killed between creating its
// private stage database and dropping it leaves orbit_restore_stage_<ms>_<pid>
// behind in the live Postgres, where it is never reclaimed. The name embeds
// the creating run's start time in milliseconds, so a later run drops the ones
// older than a day (a recent one may belong to a restore still running) before
// it creates its own. Only a run that can mutate does so: a preflight-only run
// drops nothing it did not create.
describe("leftover stage databases (#1316)", () => {
  const DAY_MS = 24 * 60 * 60 * 1000;
  const staleName = () => `orbit_restore_stage_${Date.now() - 2 * DAY_MS}_1`;
  const recentName = () => `orbit_restore_stage_${Date.now() - 60_000}_1`;

  function setup(): { documentsRoot: string; restorePaths: ReturnType<typeof deriveRestorePaths>; adapter: FakeAdapter } {
    const documentsRoot = join(sandbox, "live-docs");
    buildDocumentTree(documentsRoot, ORIGINAL_KEY, 10);
    const backupDirectory = join(sandbox, "backups");
    mkdirSync(backupDirectory, { recursive: true, mode: 0o700 });
    const documentKekFile = join(sandbox, "document-kek");
    writeFileSync(documentKekFile, `${LIVE_KEK}\n`, { mode: 0o600 });
    const adapter = new FakeAdapter(documentsRoot, ORIGINAL_KEY, 10);
    return { documentsRoot, restorePaths: deriveRestorePaths(backupDirectory, documentKekFile), adapter };
  }

  const restoreOptions = (context: ReturnType<typeof setup>, tag: string, extra: { preflightOnly?: boolean } = {}) => ({
    backupTarPath: buildBundle(join(sandbox, `leftover-source-${tag}`), UPDATED_KEY, 22, LIVE_KEK, join(sandbox, `leftover-backups-${tag}`)),
    documentKekHex: LIVE_KEK,
    paths: context.restorePaths,
    adapter: context.adapter,
    workDir: mkdtempSync(join(sandbox, `leftover-run-${tag}-`)),
    confirm: () => true,
    ...extra,
  });

  it("a full runRestore drops a stage database older than a day before creating its own", () => {
    const context = setup();
    const stale = staleName();
    context.adapter.openStageDatabases.add(stale);

    const result = runRestore(restoreOptions(context, "full"));

    expect(result.outcome).toBe("completed");
    expect(context.adapter.stageEvents).toContain(`drop:${stale}`);
    expect(context.adapter.openStageDatabases.has(stale)).toBe(false);
    const firstCreate = context.adapter.stageEvents.findIndex((event) => event.startsWith("create:"));
    expect(firstCreate).toBeGreaterThanOrEqual(0);
    expect(context.adapter.stageEvents.indexOf(`drop:${stale}`)).toBeLessThan(firstCreate);
  });

  it("runRecoverRestore drops a stage database older than a day", () => {
    const context = setup();
    expect(runRestore(restoreOptions(context, "recover")).outcome).toBe("completed"); // leaves the journal and checkpoint to recover from
    const stale = staleName();
    context.adapter.openStageDatabases.add(stale);

    const result = runRecoverRestore({ adapter: context.adapter, paths: context.restorePaths, workDir: mkdtempSync(join(sandbox, "leftover-recover-work-")) });

    expect(result.outcome).toBe("completed");
    expect(context.adapter.stageEvents).toContain(`drop:${stale}`);
    expect(context.adapter.openStageDatabases.has(stale)).toBe(false);
  });

  it("a preflight-only run drops no database it did not create", () => {
    const context = setup();
    const stale = staleName();
    context.adapter.openStageDatabases.add(stale);

    const result = runRestore(restoreOptions(context, "preflight", { preflightOnly: true }));

    expect(result.outcome).toBe("preflight-passed");
    expect(context.adapter.stageEvents).not.toContain(`drop:${stale}`);
    expect(context.adapter.openStageDatabases.has(stale)).toBe(true);
  });

  it("leaves a stage database with a recent timestamp alone, in a full run and in --recover", () => {
    const context = setup();
    const recent = recentName();
    context.adapter.openStageDatabases.add(recent);

    expect(runRestore(restoreOptions(context, "recent")).outcome).toBe("completed");
    expect(context.adapter.stageEvents).not.toContain(`drop:${recent}`);
    expect(context.adapter.openStageDatabases.has(recent)).toBe(true);

    runRecoverRestore({ adapter: context.adapter, paths: context.restorePaths, workDir: mkdtempSync(join(sandbox, "leftover-recent-recover-")) });
    expect(context.adapter.stageEvents).not.toContain(`drop:${recent}`);
    expect(context.adapter.openStageDatabases.has(recent)).toBe(true);
  });
});

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

  // #1316: a hard link and an unlink only reach the disk once the file's data
  // and then the directory entry are flushed; without fsync a power cut right
  // after "export complete" can leave a missing or empty recovery bundle.
  it("fsyncs the .installing file before linking it into place, and the backups directory after the link and unlink (#1316)", () => {
    const documentsRoot = join(sandbox, "docs-fsync");
    const sourceBundlePath = buildBundle(documentsRoot, ORIGINAL_KEY, 10, LIVE_KEK, join(sandbox, "source-backups-fsync"));
    const adapter = new FakeAdapter(documentsRoot, ORIGINAL_KEY, 10);
    const recoveryDirectory = join(sandbox, "recovery-backups-fsync");
    const passphrase = "correct horse battery staple";

    fsEvents.log.length = 0;
    fsEvents.recording = true;
    let finalPath: string;
    try {
      ({ finalPath } = runExportRecoveryBundle({
        sourceBundlePath,
        documentKekHex: LIVE_KEK,
        passphrase,
        passphraseConfirmation: passphrase,
        backupDirectory: recoveryDirectory,
        adapter,
        now: new Date("2026-02-02T00:00:00Z"),
      }));
    } finally {
      fsEvents.recording = false;
    }
    const log = fsEvents.log.splice(0);
    const describeLog = JSON.stringify(log, null, 1);
    const installingPath = `${finalPath}.installing`;

    const linkIndex = log.findIndex((event) => event.op === "link" && event.path === installingPath);
    expect(linkIndex, `linkSync of the .installing file not seen: ${describeLog}`).toBeGreaterThanOrEqual(0);
    const unlinkIndex = log.findIndex((event, index) => index > linkIndex && event.op === "unlink" && event.path === installingPath);
    expect(unlinkIndex, `unlinkSync of the .installing file not seen after the link: ${describeLog}`).toBeGreaterThan(linkIndex);

    const fileSyncIndexes = log.flatMap((event, index) => (event.op === "fsync" && event.path === installingPath ? [index] : []));
    expect(fileSyncIndexes.length, `no fsyncSync on a descriptor of ${installingPath}: ${describeLog}`).toBeGreaterThan(0);
    expect(fileSyncIndexes.some((index) => index < linkIndex), `the .installing file was not fsynced before linkSync: ${describeLog}`).toBe(true);

    const directorySyncIndexes = log.flatMap((event, index) => (event.op === "fsync" && event.path === recoveryDirectory ? [index] : []));
    expect(directorySyncIndexes.some((index) => index > linkIndex), `the backups directory was not fsynced after linkSync: ${describeLog}`).toBe(true);
    expect(directorySyncIndexes.some((index) => index > unlinkIndex), `the backups directory was not fsynced after the .installing unlink: ${describeLog}`).toBe(true);
  });

  it("records the export with the adapter once the bundle is published (#968: what clears the administration card)", () => {
    const documentsRoot = join(sandbox, "docs-record");
    const sourceBundlePath = buildBundle(documentsRoot, ORIGINAL_KEY, 10, LIVE_KEK, join(sandbox, "source-backups-record"));
    const adapter = new FakeAdapter(documentsRoot, ORIGINAL_KEY, 10);
    const passphrase = "correct horse battery staple";

    runExportRecoveryBundle({
      sourceBundlePath,
      documentKekHex: LIVE_KEK,
      passphrase,
      passphraseConfirmation: passphrase,
      backupDirectory: join(sandbox, "recovery-backups-record"),
      adapter,
      now: new Date("2026-02-02T00:00:00Z"),
    });

    expect(adapter.recordExportedCalls).toBe(1);
  });

  it("still throws when the export cannot be recorded, even though the bundle is already on disk (a false-positive administration card is worse than a resumable error)", () => {
    const documentsRoot = join(sandbox, "docs-record-fail");
    const sourceBundlePath = buildBundle(documentsRoot, ORIGINAL_KEY, 10, LIVE_KEK, join(sandbox, "source-backups-record-fail"));
    const adapter = new FakeAdapter(documentsRoot, ORIGINAL_KEY, 10);
    adapter.recordExportedOk = false;
    const passphrase = "correct horse battery staple";
    const recoveryDirectory = join(sandbox, "recovery-backups-record-fail");

    expect(() =>
      runExportRecoveryBundle({
        sourceBundlePath,
        documentKekHex: LIVE_KEK,
        passphrase,
        passphraseConfirmation: passphrase,
        backupDirectory: recoveryDirectory,
        adapter,
        now: new Date("2026-02-02T00:00:00Z"),
      }),
    ).toThrow(RecoveryBundleRefusal);
    expect(adapter.recordExportedCalls).toBe(1);
    // The bundle itself is not rolled back: it was already safely published.
    expect(existsSync(join(recoveryDirectory, "orbit-recovery-20260202-000000.tar"))).toBe(true);
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

  // #1316: publishing is stage-then-rename. When the final name is already
  // taken the publish refuses, and the staged <bundle>.installing file must
  // not be left behind in the backups directory.
  it("#1316: leaves no .installing file behind when the final bundle name already exists and publishing refuses", () => {
    const documentsRoot = join(sandbox, "docs-export-exists");
    const sourceBundlePath = buildBundle(documentsRoot, ORIGINAL_KEY, 10, LIVE_KEK, join(sandbox, "source-backups-export-exists"));
    const adapter = new FakeAdapter(documentsRoot, ORIGINAL_KEY, 10);
    const recoveryDirectory = join(sandbox, "recovery-backups-export-exists");
    mkdirSync(recoveryDirectory, { recursive: true, mode: 0o700 });
    const existingFinal = join(recoveryDirectory, "orbit-recovery-20260202-000000.tar");
    writeFileSync(existingFinal, "an earlier bundle");
    const passphrase = "correct horse battery staple";

    expect(() =>
      runExportRecoveryBundle({
        sourceBundlePath,
        documentKekHex: LIVE_KEK,
        passphrase,
        passphraseConfirmation: passphrase,
        backupDirectory: recoveryDirectory,
        adapter,
        now: new Date("2026-02-02T00:00:00Z"),
      }),
    ).toThrow();

    expect(readFileSync(existingFinal, "utf8")).toBe("an earlier bundle"); // Not overwritten.
    expect(readdirSync(recoveryDirectory).filter((name) => name.endsWith(".installing"))).toEqual([]);
  });

  // #1316: an export killed mid-run leaves its scratch directory
  // (.orbit-recovery.<random>) and maybe a half-installed .tar.installing; the
  // next successful export sweeps both.
  it("#1316: removes a stale .orbit-recovery.* scratch directory and a stale .tar.installing file after a later successful export", () => {
    const documentsRoot = join(sandbox, "docs-export-stale");
    const sourceBundlePath = buildBundle(documentsRoot, ORIGINAL_KEY, 10, LIVE_KEK, join(sandbox, "source-backups-export-stale"));
    const adapter = new FakeAdapter(documentsRoot, ORIGINAL_KEY, 10);
    const recoveryDirectory = join(sandbox, "recovery-backups-export-stale");
    mkdirSync(recoveryDirectory, { recursive: true, mode: 0o700 });
    const staleDirectory = join(recoveryDirectory, ".orbit-recovery.stale");
    mkdirSync(staleDirectory, { mode: 0o700 });
    writeFileSync(join(staleDirectory, "document-kek.enc"), "partial envelope");
    const staleInstalling = join(recoveryDirectory, "orbit-recovery-0.tar.installing");
    writeFileSync(staleInstalling, "half a bundle");
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

    expect(existsSync(result.finalPath)).toBe(true);
    expect(existsSync(staleDirectory)).toBe(false);
    expect(existsSync(staleInstalling)).toBe(false);
  });

  // #1316: export shares the backup/restore flock, so it cannot run while a
  // backup or restore is in progress against the same backups directory.
  it("#1316: refuses with restore-locked while another process holds the backup/restore lock", () => {
    const documentsRoot = join(sandbox, "docs-export-lock");
    const sourceBundlePath = buildBundle(documentsRoot, ORIGINAL_KEY, 10, LIVE_KEK, join(sandbox, "source-backups-export-lock"));
    const adapter = new FakeAdapter(documentsRoot, ORIGINAL_KEY, 10);
    const recoveryDirectory = join(sandbox, "recovery-backups-export-lock");
    mkdirSync(recoveryDirectory, { recursive: true, mode: 0o700 });
    const lockPath = join(recoveryDirectory, ".orbit-backup-restore.lock");
    const holder = holdLockInAnotherProcess(lockPath);
    const passphrase = "correct horse battery staple";

    try {
      let caught: unknown;
      try {
        runExportRecoveryBundle({
          sourceBundlePath,
          documentKekHex: LIVE_KEK,
          passphrase,
          passphraseConfirmation: passphrase,
          backupDirectory: recoveryDirectory,
          adapter,
          now: new Date("2026-02-02T00:00:00Z"),
        });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(BackupRestoreCliRefusal);
      expect((caught as BackupRestoreCliRefusal).code).toBe("restore-locked");
      expect(adapter.recordExportedCalls).toBe(0);
      expect(readdirSync(recoveryDirectory)).toEqual([".orbit-backup-restore.lock"]); // Nothing written.
    } finally {
      killLockHolder(holder, lockPath);
    }
  });

  // #1316: when another process holds the lock AND a journal exists, the
  // holder answers first: the journal may be that holder's own in-flight
  // restore, so "restore-unfinished" would be wrong.
  it("#1316: refuses with restore-locked, not restore-unfinished, when another process holds the lock and a restore journal exists", () => {
    const documentsRoot = join(sandbox, "docs-backup-lock-journal");
    buildDocumentTree(documentsRoot, ORIGINAL_KEY, 10);
    const backupDirectory = join(sandbox, "backup-lock-journal-backups");
    mkdirSync(join(backupDirectory, ".orbit-restore"), { recursive: true, mode: 0o700 });
    writeFileSync(join(backupDirectory, ".orbit-restore", "restore.journal"), "format_version=1\nstate=database-restored\n", { mode: 0o600 });
    const adapter = new FakeAdapter(documentsRoot, ORIGINAL_KEY, 10);
    const lockPath = join(backupDirectory, ".orbit-backup-restore.lock");
    const holder = holdLockInAnotherProcess(lockPath);

    try {
      let caught: unknown;
      try {
        runBackup({ backupDirectory, documentKekHex: LIVE_KEK, adapter, now: new Date("2026-03-04T05:06:07Z") });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(BackupRestoreCliRefusal);
      expect((caught as BackupRestoreCliRefusal).code).toBe("restore-locked");
      expect(adapter.stopCalls).toBe(0);
    } finally {
      killLockHolder(holder, lockPath);
    }
  });

  // #1316 (backup-busy): a backup that meets a running export is not meeting
  // another app-owning run. An export never stops orbit-app, so the shells must
  // restart it (exit 75 means "leave the app to the run that holds the lock").
  // The refusal therefore carries its own code, `backup-busy`, with a message
  // that says an export is in progress and to retry when it finishes.
  it("#1316: a backup started while an export waits at the passphrase prompt refuses with backup-busy, not restore-locked", () => {
    const documentsRoot = join(sandbox, "docs-export-busy");
    const sourceBundlePath = buildBundle(documentsRoot, ORIGINAL_KEY, 10, LIVE_KEK, join(sandbox, "source-backups-export-busy"));
    const exportAdapter = new FakeAdapter(documentsRoot, ORIGINAL_KEY, 10);
    const backupDocumentsRoot = join(sandbox, "docs-export-busy-backup");
    buildDocumentTree(backupDocumentsRoot, ORIGINAL_KEY, 10);
    const backupAdapter = new FakeAdapter(backupDocumentsRoot, ORIGINAL_KEY, 10);
    const sharedBackupDirectory = join(sandbox, "recovery-backups-export-busy");
    mkdirSync(sharedBackupDirectory, { recursive: true, mode: 0o700 });
    const passphrase = "correct horse battery staple";

    let caught: unknown;
    let backupDirectoryDuringPrompt: string[] = [];
    const result = runExportRecoveryBundle({
      sourceBundlePath,
      documentKekHex: LIVE_KEK,
      collectPassphrase: () => {
        // The export is paused here, holding the lock; the backup arrives now.
        try {
          runBackup({ backupDirectory: sharedBackupDirectory, documentKekHex: LIVE_KEK, adapter: backupAdapter, now: new Date("2026-03-04T05:06:07Z") });
        } catch (error) {
          caught = error;
        }
        backupDirectoryDuringPrompt = readdirSync(sharedBackupDirectory);
        return passphrase;
      },
      backupDirectory: sharedBackupDirectory,
      adapter: exportAdapter,
      now: new Date("2026-02-02T00:00:00Z"),
    });

    expect(existsSync(result.finalPath)).toBe(true); // The export itself is undisturbed.
    expect(caught).toBeInstanceOf(BackupRestoreCliRefusal);
    expect((caught as BackupRestoreCliRefusal).code).not.toBe("restore-locked");
    expect((caught as BackupRestoreCliRefusal).code).toBe("backup-busy");
    const message = (caught as BackupRestoreCliRefusal).message.toLowerCase();
    expect(message).toContain("export");
    expect(message).toContain("in progress");
    expect(message).toContain("retry");
    expect(message).toContain("finishes");
    expect(backupAdapter.stopCalls).toBe(0); // The backup never stopped the app.
    expect(backupAdapter.appRunning).toBe(true);
    expect(backupDirectoryDuringPrompt.some((name) => name.endsWith(".tar"))).toBe(false); // And wrote no bundle.
  });

  it("#1316: a second backup started while a backup holds the lock still refuses with restore-locked", () => {
    const documentsRoot = join(sandbox, "docs-backup-busy-first");
    buildDocumentTree(documentsRoot, ORIGINAL_KEY, 10);
    const secondDocumentsRoot = join(sandbox, "docs-backup-busy-second");
    buildDocumentTree(secondDocumentsRoot, ORIGINAL_KEY, 10);
    const secondAdapter = new FakeAdapter(secondDocumentsRoot, ORIGINAL_KEY, 10);
    const backupDirectory = join(sandbox, "backup-busy-backups");
    mkdirSync(backupDirectory, { recursive: true, mode: 0o700 });

    let caught: unknown;
    // The first backup owns the app (it stops it) and holds the lock while it
    // dumps the database; the second backup arrives at that moment.
    class FirstBackupAdapter extends FakeAdapter {
      override dumpDatabase(outputPath: string): void {
        try {
          runBackup({ backupDirectory, documentKekHex: LIVE_KEK, adapter: secondAdapter, now: new Date("2026-03-04T05:06:08Z") });
        } catch (error) {
          caught = error;
        }
        super.dumpDatabase(outputPath);
      }
    }
    const firstAdapter = new FirstBackupAdapter(documentsRoot, ORIGINAL_KEY, 10);

    const result = runBackup({ backupDirectory, documentKekHex: LIVE_KEK, adapter: firstAdapter, now: new Date("2026-03-04T05:06:07Z") });

    expect(existsSync(result.finalTarPath)).toBe(true);
    expect(caught).toBeInstanceOf(BackupRestoreCliRefusal);
    expect((caught as BackupRestoreCliRefusal).code).toBe("restore-locked");
    expect(secondAdapter.stopCalls).toBe(0);
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
    // The inner restore's journal stays until the shell has seen Orbit healthy and run `restore --finish` (#1316 O2-S1).
    const paths = deriveRestorePaths(backupDirectory, liveDocumentKekFile);
    expect(existsSync(paths.journalPath)).toBe(true);
  });

  // #1316 O2-S2: the full import must already hold the shared backup/restore
  // flock when it asks for the passphrase (a person may take minutes to
  // type it), so a backup or restore started in that window is refused
  // rather than racing the import. Today the lock is taken only after the
  // passphrase is in, so another process gets it during the prompt.
  it("O2-S2: already holds the backup/restore lock when it asks for the passphrase", () => {
    const passphrase = "correct horse battery staple";
    const { recoveryBundlePath } = buildRecoveryBundle(UPDATED_KEY, 22, UPDATED_KEY, passphrase);

    const liveDocumentsRoot = join(sandbox, "live-docs-import-s2");
    buildDocumentTree(liveDocumentsRoot, ORIGINAL_KEY, 10);
    const liveDocumentKekFile = join(sandbox, "live-document-kek-s2");
    writeFileSync(liveDocumentKekFile, `${LIVE_KEK}\n`, { mode: 0o600 });
    const backupDirectory = join(sandbox, "import-target-backups-s2");
    mkdirSync(backupDirectory, { recursive: true, mode: 0o700 });
    const adapter = new FakeAdapter(liveDocumentsRoot, ORIGINAL_KEY, 10);
    const lockPath = join(backupDirectory, ".orbit-backup-restore.lock");

    const asks: boolean[] = []; // Per ask: could another process take the lock?
    const result = runImportRecoveryBundle({
      recoveryBundlePath,
      passphrase: () => {
        asks.push(lockIsFree(lockPath)); // `flock -n`, taking and dropping it at once if it can.
        return passphrase;
      },
      liveDocumentKekFile,
      backupDirectory,
      adapter,
      importConfirmed: true,
      confirmRestore: () => true,
    });

    expect(asks).toEqual([false]); // Asked once, and the other process was refused.
    expect(result.outcome).toBe("completed");
    expect(lockIsFree(lockPath)).toBe(true); // Released when the run ends.
  });

  // #1316: the lock is contended before the bundle is examined. A full import
  // against a bundle that would fail its checksum check must still say
  // `restore-locked` while another process holds the lock, so the refusal tells
  // the operator what to wait for rather than a fault the bundle may not have.
  // Today the unpack and checksum preflight run first and win.
  it("#1316: refuses with restore-locked, not import-preflight-failed, when the lock is held and the bundle's inner checksum is wrong", () => {
    const passphrase = "correct horse battery staple";
    const { recoveryBundlePath: goodBundlePath } = buildRecoveryBundle(UPDATED_KEY, 22, UPDATED_KEY, passphrase);

    // Repack the bundle with one digit of its own checksums.sha256 changed.
    const unpacked = mkdtempSync(join(sandbox, "bad-checksum-unpacked-"));
    extractTar(goodBundlePath, unpacked);
    const checksumsPath = join(unpacked, "checksums.sha256");
    const original = readFileSync(checksumsPath, "utf8");
    writeFileSync(checksumsPath, `${original[0] === "0" ? "1" : "0"}${original.slice(1)}`);
    const recoveryBundlePath = join(sandbox, "bad-checksum-recovery-bundle.tar");
    createTar(unpacked, recoveryBundlePath, ["checksums.sha256", "document-kek.enc", "manifest", "orbit-backup.tar"]);
    // Control: with no lock contention this bundle is refused by the checksum preflight.
    expect(() => verifyRecoveryBundleChecksums(unpacked)).toThrow(RecoveryBundleRefusal);

    const liveDocumentsRoot = join(sandbox, "live-docs-import-lock-first");
    buildDocumentTree(liveDocumentsRoot, ORIGINAL_KEY, 10);
    const liveDocumentKekFile = join(sandbox, "live-document-kek-lock-first");
    writeFileSync(liveDocumentKekFile, `${LIVE_KEK}\n`, { mode: 0o600 });
    const backupDirectory = join(sandbox, "import-target-backups-lock-first");
    mkdirSync(backupDirectory, { recursive: true, mode: 0o700 });
    const adapter = new FakeAdapter(liveDocumentsRoot, ORIGINAL_KEY, 10);
    const lockPath = join(backupDirectory, ".orbit-backup-restore.lock");
    const holder = holdLockInAnotherProcess(lockPath);

    try {
      let caught: unknown;
      try {
        runImportRecoveryBundle({
          recoveryBundlePath,
          passphrase: () => {
            throw new Error("the passphrase must not be asked for while the lock is held elsewhere");
          },
          liveDocumentKekFile,
          backupDirectory,
          adapter,
          importConfirmed: true,
          confirmRestore: () => true,
        });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(BackupRestoreCliRefusal);
      expect((caught as BackupRestoreCliRefusal).code).toBe("restore-locked");
      expect(readFileSync(liveDocumentKekFile, "utf8").trim()).toBe(LIVE_KEK); // Nothing changed.
    } finally {
      killLockHolder(holder, lockPath);
    }
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
    ).toThrow("preflight/decryption failed; the recovery key could not be decrypted.");
    expect(readFileSync(liveDocumentKekFile, "utf8").trim()).toBe(LIVE_KEK);
  });

  // O2-F3: a failed stop must abort before the key swap, never run it anyway.
  it("O2-F3: aborts before the key swap when the app cannot be stopped", () => {
    const passphrase = "correct horse battery staple";
    const { recoveryBundlePath } = buildRecoveryBundle(UPDATED_KEY, 22, UPDATED_KEY, passphrase);

    const liveDocumentsRoot = join(sandbox, "live-docs-import-stopfail");
    buildDocumentTree(liveDocumentsRoot, ORIGINAL_KEY, 10);
    const liveDocumentKekFile = join(sandbox, "live-document-kek-stopfail");
    writeFileSync(liveDocumentKekFile, `${LIVE_KEK}\n`, { mode: 0o600 });
    const backupDirectory = join(sandbox, "import-target-backups-stopfail");
    const adapter = new FakeAdapter(liveDocumentsRoot, ORIGINAL_KEY, 10);
    adapter.stopOk = false;

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
    // The live KEK was never touched, and nothing was ever staged.
    expect(readFileSync(liveDocumentKekFile, "utf8").trim()).toBe(LIVE_KEK);
    expect(existsSync(`${liveDocumentKekFile}.import-rollback`)).toBe(false);
  });

  describe("O2-S3: key-swap staging and revert safety", () => {
    it("refuses up front when a leftover rollback file already exists, rather than silently reusing or overwriting it", () => {
      const passphrase = "correct horse battery staple";
      const { recoveryBundlePath } = buildRecoveryBundle(UPDATED_KEY, 22, UPDATED_KEY, passphrase);

      const liveDocumentsRoot = join(sandbox, "live-docs-import-leftover");
      buildDocumentTree(liveDocumentsRoot, ORIGINAL_KEY, 10);
      const liveDocumentKekFile = join(sandbox, "live-document-kek-leftover");
      writeFileSync(liveDocumentKekFile, `${LIVE_KEK}\n`, { mode: 0o600 });
      const backupDirectory = join(sandbox, "import-target-backups-leftover");
      const adapter = new FakeAdapter(liveDocumentsRoot, ORIGINAL_KEY, 10);
      const leftoverPath = `${liveDocumentKekFile}.import-rollback`;
      writeFileSync(leftoverPath, `${"f".repeat(64)}\n`, { mode: 0o600 });

      let caught: unknown;
      try {
        runImportRecoveryBundle({
          recoveryBundlePath,
          passphrase,
          liveDocumentKekFile,
          backupDirectory,
          adapter,
          importConfirmed: true,
          confirmRestore: () => true,
        });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(BackupRestoreCliRefusal);
      expect((caught as Error).message).toContain(leftoverPath);
      // Untouched — never reused, never overwritten.
      expect(readFileSync(leftoverPath, "utf8").trim()).toBe("f".repeat(64));
      expect(readFileSync(liveDocumentKekFile, "utf8").trim()).toBe(LIVE_KEK);
      expect(adapter.appRunning).toBe(true);
    });

    it("when the revert itself fails, the previous KEK is preserved (never deleted with the scratch workDir) and the refusal names where it is", () => {
      const passphrase = "correct horse battery staple";
      const { recoveryBundlePath } = buildRecoveryBundle(UPDATED_KEY, 22, UPDATED_KEY, passphrase);

      // Its own directory (not the shared `sandbox`), because the fault
      // injection below removes write permission on it for the duration of
      // the call — doing that to the shared sandbox would risk every other
      // test's cleanup in this file.
      const liveDir = mkdtempSync(join(sandbox, "live-document-kek-revertfail-dir-"));
      const liveDocumentsRoot = join(sandbox, "live-docs-import-revertfail");
      buildDocumentTree(liveDocumentsRoot, ORIGINAL_KEY, 10);
      const liveDocumentKekFile = join(liveDir, "live-document-kek-revertfail");
      writeFileSync(liveDocumentKekFile, `${LIVE_KEK}\n`, { mode: 0o600 });
      const backupDirectory = join(sandbox, "import-target-backups-revertfail");
      const adapter = new FakeAdapter(liveDocumentsRoot, ORIGINAL_KEY, 10);
      const previousKekPath = `${liveDocumentKekFile}.import-rollback`;

      let caught: unknown;
      try {
        runImportRecoveryBundle({
          recoveryBundlePath,
          passphrase,
          liveDocumentKekFile,
          backupDirectory,
          adapter,
          importConfirmed: true,
          // By the time this runs, the outer key swap has already happened
          // (runRestore's confirm() fires only after preflight/capacity, well
          // after runImportRecoveryBundle's own swap). Removing write
          // permission on liveDir here — a real fault, not a mock — means
          // the revert's own rename (previousKekPath -> liveDocumentKekFile,
          // both in liveDir) genuinely fails with EACCES, while every other
          // renameSync call in the run (elsewhere on disk) is unaffected.
          // No journal evidence is left behind either way, so the code
          // takes the revert branch rather than the restore-unfinished one.
          confirmRestore: () => {
            chmodSync(liveDir, 0o500);
            return false;
          },
        });
      } catch (error) {
        caught = error;
      } finally {
        chmodSync(liveDir, 0o700);
      }

      expect(caught).toBeInstanceOf(BackupRestoreCliRefusal);
      expect((caught as Error).message).toContain(previousKekPath);
      // The old key still exists, outside the (now-deleted) scratch workDir.
      expect(readFileSync(previousKekPath, "utf8").trim()).toBe(LIVE_KEK);
    });
  });

  // Amendment E3a: import-recovery-bundle.sh runs this while Orbit is still
  // up; the passphrase is asked once, in the full run that follows.
  // #1316 O2-R1 (design decided, note 35314): the engine is crash-only. It
  // installs no signal handler and undoes nothing in-process: a signal ends
  // the process at once, and the next run recovers from what is on disk (the
  // write-ahead journal and checkpoint, or the .import-rollback key file).
  describe("O2-R1: a signal ends the import where it stands; recovery is the next run's job", () => {
    /**
     * Runs the import in a real child process that stops at `pauseAt` (a
     * blocking call stands in for the docker/pg_restore work), signals it
     * with `signal`, and reports how it closed. "staging" pauses the inner
     * restore's staged-database step, with the recovered key already swapped
     * in and no checkpoint yet; "checkpoint" pauses straight after the
     * checkpoint is verified.
     */
    async function importKilledAt(
      pauseAt: "staging" | "checkpoint",
      signal: NodeJS.Signals,
      names: { recoveryBundlePath: string; passphrase: string; liveDocumentsRoot: string; liveDocumentKekFile: string; backupDirectory: string },
    ): Promise<{ stdout: string; stderr: string; killedOnDeadline: boolean; status: number | null; closeSignal: NodeJS.Signals | null }> {
      const rollbackFile = `${names.liveDocumentKekFile}.import-rollback`;
      const srcLib = import.meta.dirname;
      const childScript = join(sandbox, `import-${pauseAt}-child.mts`);
      writeFileSync(
        childScript,
        `import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { runImportRecoveryBundle } from ${JSON.stringify(join(srcLib, "backup-restore-cli.ts"))};
import { createTar, extractTar } from ${JSON.stringify(join(srcLib, "recovery-bundle.ts"))};
import { CORRESPONDENCE_QUERIES } from ${JSON.stringify(join(srcLib, "restore-engine.ts"))};

const config = JSON.parse(process.argv[2]);
const reports = {
  crypto: config.documentId + "|" + config.storageKey + "|10|available\\n",
  visible: config.documentId + "|available|" + config.storageKey + "|10\\n",
  attachments: "",
  staging: "",
  documentStaging: "",
  transientCount: "0",
};
const field = (query) => Object.entries(CORRESPONDENCE_QUERIES).find(([, text]) => text === query)[0];
let live = reports;
let blocked = false;
const stages = new Map();
const adapter = {
  stopApp: () => true,
  startApp: () => true,
  dumpDatabase: (output) => writeFileSync(output, JSON.stringify(live)),
  pgRestoreListOk: () => true,
  collectDocumentsArchive: (output) => createTar(config.documentsRoot, output, ["."]),
  createStageDatabase: () => {},
  dropStageDatabase: () => {},
  listStageDatabases: () => [],
  restoreDumpToDatabase: (name, dumpPath) => {
    if (config.pauseAt === "staging" && !blocked && existsSync(config.rollbackFile)) {
      blocked = true;
      // The step is a child that outlives the signal (docker stop signals
      // only the one-off's PID 1, never its pg_restore child), so a process
      // that handles the signal finishes the step with the signal pending.
      writeSync(1, "paused\\n");
      spawnSync("sleep", ["1"]);
    }
    stages.set(name, JSON.parse(readFileSync(dumpPath, "utf8")));
    return true;
  },
  restoreActiveDatabase: (dumpPath) => { live = JSON.parse(readFileSync(dumpPath, "utf8")); return true; },
  replaceDocumentsFromArchive: (archive) => {
    rmSync(config.documentsRoot, { recursive: true, force: true });
    mkdirSync(config.documentsRoot, { recursive: true });
    extractTar(archive, config.documentsRoot);
    return true;
  },
  resetScanRecoveryLeases: () => true,
  queryReport: (name, query) => stages.get(name)[field(query)],
  queryActiveReport: (query) => live[field(query)],
  waitForHealth: () => true,
  measureLiveDatabaseSizeBytes: () => 1024,
  measureLiveDocumentTreeKib: () => 1,
  measureDocumentVolumeAvailableKib: () => 1000000,
  recordRecoveryBundleExported: () => {},
};
runImportRecoveryBundle({
  recoveryBundlePath: config.recoveryBundlePath,
  passphrase: config.passphrase,
  liveDocumentKekFile: config.liveDocumentKekFile,
  backupDirectory: config.backupDirectory,
  adapter,
  importConfirmed: true,
  confirmRestore: () => true,
  testHooks: {
    afterCheckpoint: () => {
      if (config.pauseAt !== "checkpoint") return;
      writeSync(1, "paused\\n");
      spawnSync("sleep", ["30"]);
    },
  },
});
`,
      );

      return new Promise((resolvePromise, reject) => {
        const child = spawn(
          "node",
          [
            "--import",
            "tsx",
            childScript,
            JSON.stringify({ documentId: DOCUMENT_ID, storageKey: ORIGINAL_KEY, documentsRoot: names.liveDocumentsRoot, rollbackFile, pauseAt, ...names }),
          ],
          { cwd: process.cwd(), detached: true, stdio: ["ignore", "pipe", "pipe"] },
        );
        let out = "";
        let err = "";
        let signalled = false;
        let killedOnDeadline = false;
        const deadline = setTimeout(() => {
          killedOnDeadline = true;
          process.kill(-child.pid!, "SIGKILL");
        }, 20_000);
        child.stdout.on("data", (chunk: Buffer) => {
          out += chunk.toString();
          if (!signalled && out.includes("paused")) {
            signalled = true;
            // Let the blocking call start, then signal the import process
            // alone, as docker stop does to the one-off's PID 1.
            setTimeout(() => process.kill(child.pid!, signal), 300);
          }
        });
        child.stderr.on("data", (chunk: Buffer) => {
          err += chunk.toString();
        });
        child.on("error", (error) => {
          clearTimeout(deadline);
          reject(error);
        });
        child.on("close", (status, closeSignal) => {
          clearTimeout(deadline);
          // A grandchild (the blocking sleep) can outlive the child; reap it.
          try {
            process.kill(-child.pid!, "SIGKILL");
          } catch {
            // The group is already gone.
          }
          resolvePromise({ stdout: out, stderr: err, killedOnDeadline, status, closeSignal });
        });
      });
    }

    function importTarget(suffix: string): { liveDocumentsRoot: string; liveDocumentKekFile: string; backupDirectory: string; rollbackFile: string } {
      const liveDocumentsRoot = join(sandbox, `live-docs-import-${suffix}`);
      buildDocumentTree(liveDocumentsRoot, ORIGINAL_KEY, 10);
      const liveDocumentKekFile = join(sandbox, `live-document-kek-${suffix}`);
      writeFileSync(liveDocumentKekFile, `${LIVE_KEK}\n`, { mode: 0o600 });
      const backupDirectory = join(sandbox, `import-target-backups-${suffix}`);
      mkdirSync(backupDirectory, { recursive: true, mode: 0o700 });
      return { liveDocumentsRoot, liveDocumentKekFile, backupDirectory, rollbackFile: `${liveDocumentKekFile}.import-rollback` };
    }

    it("a SIGTERM while the inner restore is staging ends the import by the signal and leaves the original key in .import-rollback", async () => {
      const passphrase = "correct horse battery staple";
      const { recoveryBundlePath } = buildRecoveryBundle(UPDATED_KEY, 22, UPDATED_KEY, passphrase);
      const { liveDocumentsRoot, liveDocumentKekFile, backupDirectory, rollbackFile } = importTarget("sigterm");

      const { stdout, stderr, killedOnDeadline, status, closeSignal } = await importKilledAt("staging", "SIGTERM", {
        recoveryBundlePath,
        passphrase,
        liveDocumentsRoot,
        liveDocumentKekFile,
        backupDirectory,
      });

      expect(stdout, `the child never reached the staging step (stderr: ${stderr})`).toContain("paused");
      expect(killedOnDeadline).toBe(false);
      // Ended by the signal itself, not by an exit code from a handler.
      expect({ status, signal: closeSignal }).toEqual({ status: null, signal: "SIGTERM" });
      // Nothing undid the swap in-process: the live key is the bundle's, the
      // original sits in the rollback file, and no restore journal exists
      // (the checkpoint had not been taken yet).
      expect(readFileSync(liveDocumentKekFile, "utf8").trim()).toBe(UPDATED_KEY);
      expect(readFileSync(rollbackFile, "utf8").trim()).toBe(LIVE_KEK);
      expect(existsSync(deriveRestorePaths(backupDirectory, liveDocumentKekFile).journalPath)).toBe(false);
    });

    it("--recover after an import killed after the checkpoint restores the original key and removes .import-rollback", async () => {
      const passphrase = "correct horse battery staple";
      const { recoveryBundlePath } = buildRecoveryBundle(UPDATED_KEY, 22, UPDATED_KEY, passphrase);
      const { liveDocumentsRoot, liveDocumentKekFile, backupDirectory, rollbackFile } = importTarget("recover");

      const { stdout, stderr, killedOnDeadline, closeSignal } = await importKilledAt("checkpoint", "SIGKILL", {
        recoveryBundlePath,
        passphrase,
        liveDocumentsRoot,
        liveDocumentKekFile,
        backupDirectory,
      });

      expect(stdout, `the child never reached the checkpoint (stderr: ${stderr})`).toContain("paused");
      expect(killedOnDeadline).toBe(false);
      expect(closeSignal).toBe("SIGKILL");
      // The crash left the swapped key, the rollback file and a journal.
      const paths = deriveRestorePaths(backupDirectory, liveDocumentKekFile);
      expect(readFileSync(liveDocumentKekFile, "utf8").trim()).toBe(UPDATED_KEY);
      expect(readFileSync(rollbackFile, "utf8").trim()).toBe(LIVE_KEK);
      expect(existsSync(paths.journalPath)).toBe(true);

      // `orbit restore --recover` (runRecoverRestore) in a later process.
      const adapter = new FakeAdapter(liveDocumentsRoot, ORIGINAL_KEY, 10);
      const result = runRecoverRestore({ adapter, paths, workDir: mkdtempSync(join(sandbox, "recover-after-import-kill-")) });

      expect(result.outcome).toBe("completed");
      expect(readFileSync(liveDocumentKekFile, "utf8").trim()).toBe(LIVE_KEK);
      expect(existsSync(rollbackFile)).toBe(false);
      expect(existsSync(paths.journalPath)).toBe(false);
    });
  });

  describe("preflightOnly (the shell's `import-recovery-bundle --preflight`, amendment E3a)", () => {
    function importTarget(suffix: string): { liveDocumentKekFile: string; backupDirectory: string; adapter: FakeAdapter } {
      const liveDocumentsRoot = join(sandbox, `live-docs-import-preflight-${suffix}`);
      buildDocumentTree(liveDocumentsRoot, ORIGINAL_KEY, 10);
      const liveDocumentKekFile = join(sandbox, `live-document-kek-preflight-${suffix}`);
      writeFileSync(liveDocumentKekFile, `${LIVE_KEK}\n`, { mode: 0o600 });
      const backupDirectory = join(sandbox, `import-preflight-backups-${suffix}`);
      mkdirSync(backupDirectory, { recursive: true, mode: 0o700 });
      return { liveDocumentKekFile, backupDirectory, adapter: new FakeAdapter(liveDocumentsRoot, ORIGINAL_KEY, 10) };
    }

    it("passes a good bundle without asking for the passphrase or either confirmation, and changes nothing", () => {
      const { recoveryBundlePath } = buildRecoveryBundle(UPDATED_KEY, 22, UPDATED_KEY, "correct horse battery staple");
      const { liveDocumentKekFile, backupDirectory, adapter } = importTarget("pass");
      const asked: string[] = [];

      const result = runImportRecoveryBundle({
        recoveryBundlePath,
        passphrase: () => {
          asked.push("passphrase");
          return "correct horse battery staple";
        },
        liveDocumentKekFile,
        backupDirectory,
        adapter,
        preflightOnly: true,
        importConfirmed: () => {
          asked.push("import");
          return true;
        },
        confirmRestore: () => {
          asked.push("restore");
          return true;
        },
        beforeRestore: () => asked.push("beforeRestore"),
      });

      expect(result.outcome).toBe("preflight-passed");
      expect(asked).toEqual([]);
      expect(readFileSync(liveDocumentKekFile, "utf8").trim()).toBe(LIVE_KEK);
      expect(existsSync(`${liveDocumentKekFile}.import-rollback`)).toBe(false);
      expect(adapter.stopCalls).toBe(0);
      const paths = deriveRestorePaths(backupDirectory, liveDocumentKekFile);
      expect(existsSync(paths.journalPath)).toBe(false);
      expect(existsSync(paths.restoreRoot)).toBe(false);
      expect(lockIsFree(join(backupDirectory, ".orbit-backup-restore.lock"))).toBe(true);
    });

    it("refuses a corrupt bundle with the full run's message, before any callback", () => {
      const corrupt = join(sandbox, "corrupt-recovery.tar");
      writeFileSync(corrupt, "not a tar archive\n");
      const { liveDocumentKekFile, backupDirectory, adapter } = importTarget("corrupt");
      const never = (): never => {
        throw new Error("a callback was invoked");
      };
      const attempt = (preflightOnly: boolean): Error => {
        try {
          runImportRecoveryBundle({ recoveryBundlePath: corrupt, passphrase: never, liveDocumentKekFile, backupDirectory, adapter, preflightOnly, importConfirmed: never, confirmRestore: never });
        } catch (error) {
          return error as Error;
        }
        throw new Error("a corrupt recovery bundle was accepted");
      };
      const preflightRefusal = attempt(true);
      expect(preflightRefusal).toBeInstanceOf(BackupRestoreCliRefusal);
      expect(preflightRefusal.message).toBe(attempt(false).message);
    });

    it("refuses an unfinished restore, as the full run does", () => {
      const { recoveryBundlePath } = buildRecoveryBundle(UPDATED_KEY, 22, UPDATED_KEY, "correct horse battery staple");
      const { liveDocumentKekFile, backupDirectory, adapter } = importTarget("journal");
      const paths = deriveRestorePaths(backupDirectory, liveDocumentKekFile);
      mkdirSync(paths.restoreRoot, { recursive: true, mode: 0o700 });
      writeFileSync(paths.journalPath, "format_version=1\n", { mode: 0o600 });
      expect(() =>
        runImportRecoveryBundle({ recoveryBundlePath, passphrase: "x", liveDocumentKekFile, backupDirectory, adapter, preflightOnly: true, importConfirmed: true, confirmRestore: () => true }),
      ).toThrow(expect.objectContaining({ code: "restore-journal-exists" }));
    });

    it("O2-F2: passes while another process holds the backup/restore lock (a preflight changes nothing, so it needs no lock)", () => {
      const { recoveryBundlePath } = buildRecoveryBundle(UPDATED_KEY, 22, UPDATED_KEY, "correct horse battery staple");
      const { liveDocumentKekFile, backupDirectory, adapter } = importTarget("lock");
      const lockPath = join(backupDirectory, ".orbit-backup-restore.lock");
      const holder = holdLockInAnotherProcess(lockPath);
      try {
        const result = runImportRecoveryBundle({ recoveryBundlePath, passphrase: "x", liveDocumentKekFile, backupDirectory, adapter, preflightOnly: true, importConfirmed: true, confirmRestore: () => true });
        expect(result.outcome).toBe("preflight-passed");
        expect(lockIsFree(lockPath)).toBe(false); // still the other process's
      } finally {
        killLockHolder(holder, lockPath);
      }
    });

    it("O2-F2: leaves a .preparing-marked orphan checkpoint untouched (only a full run may sweep it)", () => {
      const { recoveryBundlePath } = buildRecoveryBundle(UPDATED_KEY, 22, UPDATED_KEY, "correct horse battery staple");
      const { liveDocumentKekFile, backupDirectory, adapter } = importTarget("orphan");
      const paths = deriveRestorePaths(backupDirectory, liveDocumentKekFile);
      const orphan = join(paths.restoreRoot, "checkpoint-AbC123");
      mkdirSync(orphan, { recursive: true, mode: 0o700 });
      writeFileSync(join(orphan, ".preparing"), "");
      writeFileSync(join(orphan, "database.dump"), "a full-size dump");

      const result = runImportRecoveryBundle({ recoveryBundlePath, passphrase: "x", liveDocumentKekFile, backupDirectory, adapter, preflightOnly: true, importConfirmed: true, confirmRestore: () => true });

      expect(result.outcome).toBe("preflight-passed");
      expect(existsSync(join(orphan, ".preparing"))).toBe(true);
      expect(readFileSync(join(orphan, "database.dump"), "utf8")).toBe("a full-size dump");
    });
  });
});

describe("runRestore cross-process lock (O2-R7, shared file name #1151 RANGE-S4)", () => {
  it("refuses while another process holds the shared flock against the same backup directory", () => {
    const liveDocumentsRoot = join(sandbox, "live-docs-restore-lock");
    buildDocumentTree(liveDocumentsRoot, ORIGINAL_KEY, 10);
    const backupDirectory = join(sandbox, "restore-lock-backups");
    const documentKekFile = join(sandbox, "restore-lock-document-kek");
    writeFileSync(documentKekFile, `${ORIGINAL_KEY}\n`, { mode: 0o600 });
    const backupTarPath = buildBundle(join(sandbox, "restore-lock-source"), ORIGINAL_KEY, 10, ORIGINAL_KEY, join(sandbox, "restore-lock-source-backups"));
    const adapter = new FakeAdapter(liveDocumentsRoot, ORIGINAL_KEY, 10);
    const paths = deriveRestorePaths(backupDirectory, documentKekFile);
    mkdirSync(backupDirectory, { recursive: true, mode: 0o700 });
    const lockPath = join(backupDirectory, ".orbit-backup-restore.lock");
    const holder = holdLockInAnotherProcess(lockPath);

    const workDir = mkdtempSync(join(sandbox, "restore-lock-work-"));
    try {
      expect(() =>
        runRestore({
          backupTarPath,
          documentKekHex: ORIGINAL_KEY,
          paths,
          adapter,
          workDir,
          confirm: () => true,
        }),
      ).toThrow(expect.objectContaining({ code: "restore-locked" }));
      // Refused before the journal-exists check even ran.
      expect(existsSync(paths.journalPath)).toBe(false);
      expect(adapter.appRunning).toBe(true);
    } finally {
      killLockHolder(holder, lockPath);
    }
  });
});

// #1316: orbit-db is a bundled Postgres. When the engine's environment names an
// external database (DATABASE_URL or DATABASE_URL_FILE), pg_dump/pg_restore/psql
// against orbit-db would dump or overwrite the wrong database and report
// success, so backup, restore and export-recovery-bundle must refuse by name
// before the adapter does anything (and so before orbit-app is stopped).
describe("external database refusal (#1316)", { timeout: 20_000 }, () => {
  const ENV_NAMES = ["DATABASE_URL", "DATABASE_URL_FILE"] as const;
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const name of ENV_NAMES) {
      savedEnv[name] = process.env[name];
      delete process.env[name];
    }
  });

  afterEach(() => {
    for (const name of ENV_NAMES) {
      if (savedEnv[name] === undefined) delete process.env[name];
      else process.env[name] = savedEnv[name];
    }
  });

  /** Wraps an adapter and records every method called on it. */
  function recordCalls<T extends object>(adapter: T): { adapter: T; calls: string[] } {
    const calls: string[] = [];
    const proxy = new Proxy(adapter, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver) as unknown;
        if (typeof value !== "function") return value;
        return (...args: unknown[]) => {
          calls.push(String(prop));
          return (value as (...a: unknown[]) => unknown).apply(target, args);
        };
      },
    });
    return { adapter: proxy, calls };
  }

  function setExternalDatabase(variable: (typeof ENV_NAMES)[number]): void {
    // A made-up value: the refusal must key on presence, not on the value.
    process.env[variable] = variable === "DATABASE_URL" ? "postgres://user:pw@db.example.invalid:5432/orbit" : join(sandbox, "database-url-secret");
  }

  function captureRefusal(run: () => unknown): BackupRestoreCliRefusal {
    let caught: unknown;
    try {
      run();
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(BackupRestoreCliRefusal);
    const refusal = caught as BackupRestoreCliRefusal;
    // Named: the message says which setting caused the refusal, and never echoes its value.
    expect(refusal.message).toMatch(/DATABASE_URL/);
    expect(refusal.message).not.toContain("pw@db.example.invalid");
    expect(refusal.code).toBe("database-url-unsupported");
    return refusal;
  }

  for (const variable of ENV_NAMES) {
    it(`runBackup refuses with ${variable} set, before the adapter dumps or stops anything`, () => {
      const documentsRoot = join(sandbox, "docs-ext-backup");
      buildDocumentTree(documentsRoot, ORIGINAL_KEY, 10);
      const backupDirectory = join(sandbox, "ext-backup-backups");
      const fake = new FakeAdapter(documentsRoot, ORIGINAL_KEY, 10);
      const { adapter, calls } = recordCalls(fake);
      setExternalDatabase(variable);

      captureRefusal(() => runBackup({ backupDirectory, documentKekHex: LIVE_KEK, adapter, now: new Date("2026-03-04T05:06:07Z") }));

      expect(calls).toEqual([]); // No pg_dump, no stopApp.
      expect(fake.appRunning).toBe(true);
      const tars = existsSync(backupDirectory) ? readdirSync(backupDirectory).filter((name) => name.endsWith(".tar")) : [];
      expect(tars).toEqual([]); // No bundle reported as success.
    });

    it(`runRestore refuses with ${variable} set, before the adapter restores or stops anything`, () => {
      const documentsRoot = join(sandbox, "live-docs-ext-restore");
      const bundlePath = buildBundle(join(sandbox, "ext-restore-source"), UPDATED_KEY, 22, LIVE_KEK, join(sandbox, "ext-restore-source-backups"));
      buildDocumentTree(documentsRoot, ORIGINAL_KEY, 10);
      const backupDirectory = join(sandbox, "ext-restore-backups");
      mkdirSync(backupDirectory, { recursive: true, mode: 0o700 });
      const documentKekFile = join(sandbox, "document-kek-ext-restore");
      writeFileSync(documentKekFile, `${LIVE_KEK}\n`, { mode: 0o600 });
      const fake = new FakeAdapter(documentsRoot, ORIGINAL_KEY, 10);
      const { adapter, calls } = recordCalls(fake);
      const paths = deriveRestorePaths(backupDirectory, documentKekFile);
      const workDir = mkdtempSync(join(sandbox, "ext-restore-run-"));
      let confirmed = 0;
      setExternalDatabase(variable);

      captureRefusal(() =>
        runRestore({
          backupTarPath: bundlePath,
          documentKekHex: LIVE_KEK,
          paths,
          adapter,
          workDir,
          confirm: () => {
            confirmed += 1;
            return true;
          },
        }),
      );

      expect(calls).toEqual([]); // No stage database, no psql/pg_restore, no stopApp.
      expect(confirmed).toBe(0);
      expect(fake.appRunning).toBe(true);
      expect(existsSync(join(backupDirectory, ".orbit-restore"))).toBe(false); // No journal or checkpoint.
    });

    it(`runExportRecoveryBundle refuses with ${variable} set, before the adapter verifies or records anything`, () => {
      const documentsRoot = join(sandbox, "docs-ext-export");
      const sourceBundlePath = buildBundle(documentsRoot, ORIGINAL_KEY, 10, LIVE_KEK, join(sandbox, "ext-export-source-backups"));
      const fake = new FakeAdapter(documentsRoot, ORIGINAL_KEY, 10);
      const { adapter, calls } = recordCalls(fake);
      const recoveryDirectory = join(sandbox, "ext-export-recovery-backups");
      const passphrase = "correct horse battery staple";
      setExternalDatabase(variable);

      captureRefusal(() =>
        runExportRecoveryBundle({
          sourceBundlePath,
          documentKekHex: LIVE_KEK,
          passphrase,
          passphraseConfirmation: passphrase,
          backupDirectory: recoveryDirectory,
          adapter,
          now: new Date("2026-02-02T00:00:00Z"),
        }),
      );

      expect(calls).toEqual([]); // No pg_restore --list, no export record.
      expect(fake.recordExportedCalls).toBe(0);
      expect(existsSync(join(recoveryDirectory, "orbit-recovery-20260202-000000.tar"))).toBe(false);
    });
  }

  it("control: with neither variable set, runBackup proceeds as before", () => {
    const documentsRoot = join(sandbox, "docs-ext-control");
    buildDocumentTree(documentsRoot, ORIGINAL_KEY, 10);
    const backupDirectory = join(sandbox, "ext-control-backups");
    const { adapter, calls } = recordCalls(new FakeAdapter(documentsRoot, ORIGINAL_KEY, 10));

    const result = runBackup({ backupDirectory, documentKekHex: LIVE_KEK, adapter, now: new Date("2026-03-04T05:06:07Z") });

    expect(existsSync(result.finalTarPath)).toBe(true);
    expect(calls).toContain("dumpDatabase");
  });
});

// #1316: restore and import already refuse while a document-KEK rotation is
// open (a regular `document-kek-next` file next to the live key). Backup and
// export-recovery-bundle must too: during a rotation the live key alone no
// longer decrypts every document, so a bundle sealed with it would be one
// that cannot be restored, and backup's stopApp would take down the app
// that is running the rotation. They refuse before the adapter does anything.
describe("an open document-KEK rotation (#1316)", { timeout: 20_000 }, () => {
  /** Wraps an adapter and records every method called on it. */
  function recordCalls<T extends object>(adapter: T): { adapter: T; calls: string[] } {
    const calls: string[] = [];
    const proxy = new Proxy(adapter, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver) as unknown;
        if (typeof value !== "function") return value;
        return (...args: unknown[]) => {
          calls.push(String(prop));
          return (value as (...a: unknown[]) => unknown).apply(target, args);
        };
      },
    });
    return { adapter: proxy, calls };
  }

  /**
   * A live key file in its own `.orbit-secrets` directory. The specification
   * says "next to the live key" without naming how a caller points the
   * function at that file, so the file is passed under both names the
   * module's other entry points use; the unused one is ignored.
   */
  function liveKey(name: string, rotationOpen: boolean): { documentKekFile: string; liveDocumentKekFile: string } {
    const secrets = join(sandbox, name, ".orbit-secrets");
    mkdirSync(secrets, { recursive: true, mode: 0o700 });
    const documentKekFile = join(secrets, "document-kek");
    writeFileSync(documentKekFile, `${LIVE_KEK}\n`, { mode: 0o600 });
    if (rotationOpen) writeFileSync(join(secrets, "document-kek-next"), `${"b".repeat(64)}\n`, { mode: 0o600 });
    return { documentKekFile, liveDocumentKekFile: documentKekFile };
  }

  function captureRotationRefusal(run: () => unknown): void {
    let caught: unknown;
    try {
      run();
    } catch (error) {
      caught = error;
    }
    expect(caught, "expected a kek-rotation-open refusal, but the call returned").toBeInstanceOf(Error);
    expect((caught as { code?: string }).code).toBe("kek-rotation-open");
    expect((caught as Error).message).toMatch(/rotation/);
  }

  it("runBackup refuses with document-kek-next present, before the adapter stops the app or dumps the database", () => {
    const documentsRoot = join(sandbox, "docs-rot-backup");
    buildDocumentTree(documentsRoot, ORIGINAL_KEY, 10);
    const backupDirectory = join(sandbox, "rot-backup-backups");
    const fake = new FakeAdapter(documentsRoot, ORIGINAL_KEY, 10);
    const { adapter, calls } = recordCalls(fake);
    const key = liveKey("rot-backup-open", true);

    captureRotationRefusal(() => runBackup({ backupDirectory, documentKekHex: LIVE_KEK, adapter, now: new Date("2026-03-04T05:06:07Z"), ...key } as Parameters<typeof runBackup>[0]));

    expect(calls).not.toContain("stopApp");
    expect(calls).not.toContain("dumpDatabase");
    expect(calls).toEqual([]);
    expect(fake.appRunning).toBe(true);
    const tars = existsSync(backupDirectory) ? readdirSync(backupDirectory).filter((name) => name.endsWith(".tar")) : [];
    expect(tars).toEqual([]);
  });

  it("control: runBackup without document-kek-next stops the app and dumps the database as before", () => {
    const documentsRoot = join(sandbox, "docs-rot-backup-control");
    buildDocumentTree(documentsRoot, ORIGINAL_KEY, 10);
    const backupDirectory = join(sandbox, "rot-backup-control-backups");
    const { adapter, calls } = recordCalls(new FakeAdapter(documentsRoot, ORIGINAL_KEY, 10));
    const key = liveKey("rot-backup-closed", false);

    const result = runBackup({ backupDirectory, documentKekHex: LIVE_KEK, adapter, now: new Date("2026-03-04T05:06:07Z"), ...key } as Parameters<typeof runBackup>[0]);

    expect(existsSync(result.finalTarPath)).toBe(true);
    expect(calls).toContain("stopApp");
    expect(calls).toContain("dumpDatabase");
  });

  it("runExportRecoveryBundle refuses with document-kek-next present, before the adapter verifies or records anything", () => {
    const documentsRoot = join(sandbox, "docs-rot-export");
    const sourceBundlePath = buildBundle(documentsRoot, ORIGINAL_KEY, 10, LIVE_KEK, join(sandbox, "rot-export-source-backups"));
    const fake = new FakeAdapter(documentsRoot, ORIGINAL_KEY, 10);
    const { adapter, calls } = recordCalls(fake);
    const recoveryDirectory = join(sandbox, "rot-export-recovery-backups");
    const passphrase = "correct horse battery staple";
    const key = liveKey("rot-export-open", true);

    captureRotationRefusal(() =>
      runExportRecoveryBundle({
        sourceBundlePath,
        documentKekHex: LIVE_KEK,
        passphrase,
        passphraseConfirmation: passphrase,
        backupDirectory: recoveryDirectory,
        adapter,
        now: new Date("2026-02-02T00:00:00Z"),
        ...key,
      } as Parameters<typeof runExportRecoveryBundle>[0]),
    );

    expect(calls).not.toContain("stopApp");
    expect(calls).not.toContain("dumpDatabase");
    expect(calls).toEqual([]); // No pg_restore --list, no export record.
    expect(fake.recordExportedCalls).toBe(0);
    expect(existsSync(join(recoveryDirectory, "orbit-recovery-20260202-000000.tar"))).toBe(false);
  });

  it("control: runExportRecoveryBundle without document-kek-next exports as before", () => {
    const documentsRoot = join(sandbox, "docs-rot-export-control");
    const sourceBundlePath = buildBundle(documentsRoot, ORIGINAL_KEY, 10, LIVE_KEK, join(sandbox, "rot-export-control-source-backups"));
    const { adapter } = recordCalls(new FakeAdapter(documentsRoot, ORIGINAL_KEY, 10));
    const recoveryDirectory = join(sandbox, "rot-export-control-recovery-backups");
    const passphrase = "correct horse battery staple";
    const key = liveKey("rot-export-closed", false);

    const result = runExportRecoveryBundle({
      sourceBundlePath,
      documentKekHex: LIVE_KEK,
      passphrase,
      passphraseConfirmation: passphrase,
      backupDirectory: recoveryDirectory,
      adapter,
      now: new Date("2026-02-02T00:00:00Z"),
      ...key,
    } as Parameters<typeof runExportRecoveryBundle>[0]);

    expect(existsSync(result.finalPath)).toBe(true);
  });
});
