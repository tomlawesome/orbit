import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PROCESS_TEST_TIMEOUT_MS } from "../../scripts/process-budget.mjs";
import { BackupRestoreCliRefusal, runBackup, runExportRecoveryBundle, runImportRecoveryBundle, runRecoverRestore, runRestore } from "./backup-restore-cli";
import { type BackupDockerAdapter, createTar } from "./recovery-bundle";
import { type RestoreDockerAdapter, RestoreEngineRefusal, deriveRestorePaths } from "./restore-engine";

// Behaviour the retired bash suites (scripts/restore.test.mjs,
// scripts/import-recovery-bundle.test.mjs, scripts/backup-restore-lock.test.mjs)
// proved of restore.sh, import-recovery-bundle.sh and backup.sh, ported to
// the engine that now does the work (#1211, build note D10). The coverage
// table is docs/adr-notes/1211-bash-test-retirement.md.

vi.setConfig({ testTimeout: PROCESS_TEST_TIMEOUT_MS });

const LIVE_KEK = "e".repeat(64);
const sandboxes: string[] = [];
afterEach(() => {
  for (const sandbox of sandboxes.splice(0)) rmSync(sandbox, { recursive: true, force: true });
});
function sandbox(): string {
  const directory = mkdtempSync(join(tmpdir(), "orbit-retired-bash-"));
  sandboxes.push(directory);
  return directory;
}

/** A deployment with a live key and no bundle worth restoring: runRestore gets past its first checks and stops at the bundle. */
function deployment(): { root: string; paths: ReturnType<typeof deriveRestorePaths>; missingBundle: string } {
  const root = sandbox();
  mkdirSync(join(root, ".orbit-secrets"), { mode: 0o700 });
  const documentKekFile = join(root, ".orbit-secrets", "document-kek");
  writeFileSync(documentKekFile, `${LIVE_KEK}\n`, { mode: 0o600 });
  return { root, paths: deriveRestorePaths(join(root, "backups"), documentKekFile), missingBundle: join(root, "absent.tar") };
}

/** Never reached: every case here refuses before the adapter is used. */
const untouchableAdapter = new Proxy({} as RestoreDockerAdapter, {
  get: (_target, name) => () => {
    throw new Error(`adapter.${String(name)} must not be reached`);
  },
});

function restoreError(paths: ReturnType<typeof deriveRestorePaths>, bundle: string): Error {
  try {
    runRestore({ backupTarPath: bundle, documentKekHex: LIVE_KEK, paths, adapter: untouchableAdapter, workDir: sandbox(), confirm: () => true });
  } catch (error) {
    return error as Error;
  }
  throw new Error("runRestore unexpectedly succeeded");
}

function abandonedCheckpoint(restoreRoot: string, restoreId: string): string {
  const directory = join(restoreRoot, `checkpoint-${restoreId}`);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  writeFileSync(join(directory, ".preparing"), "");
  writeFileSync(join(directory, "database.dump"), "a full-size dump");
  return directory;
}

describe("abandoned checkpoints (restore.sh's sweep_orphaned_checkpoints, #1151 O2-R6)", () => {
  it("removes an abandoned checkpoint directory when no journal exists", () => {
    const { paths, missingBundle } = deployment();
    const abandoned = abandonedCheckpoint(paths.restoreRoot, "AbC123");
    restoreError(paths, missingBundle);
    expect(existsSync(abandoned)).toBe(false);
  });

  it("leaves every checkpoint alone when a journal exists (the restore refuses instead)", () => {
    const { paths, missingBundle } = deployment();
    const abandoned = abandonedCheckpoint(paths.restoreRoot, "AbC123");
    writeFileSync(paths.journalPath, "format_version=1\n", { mode: 0o600 });
    expect(restoreError(paths, missingBundle).message).toContain("preflight/journal failed");
    expect(existsSync(abandoned)).toBe(true);
  });

  it("leaves every checkpoint alone when the journal path is a symlink, which counts as an unfinished restore", () => {
    const { paths, missingBundle } = deployment();
    const abandoned = abandonedCheckpoint(paths.restoreRoot, "AbC123");
    symlinkSync(join(paths.restoreRoot, "nowhere"), paths.journalPath);
    expect(restoreError(paths, missingBundle).message).toContain("preflight/journal failed");
    expect(existsSync(abandoned)).toBe(true);
  });

  it("does nothing when the restore root does not exist yet", () => {
    const { paths, missingBundle } = deployment();
    expect(restoreError(paths, missingBundle).message).toBe("The bundle must be a regular, non-symbolic-link file.");
    expect(existsSync(paths.restoreRoot)).toBe(false);
  });
});

describe("an open document-KEK rotation (restore.sh's refuse_if_rotation_open, #1151 RANGE-S1)", () => {
  it("refuses before reading the key or staging the bundle", () => {
    const { paths, missingBundle } = deployment();
    writeFileSync(join(paths.backupDirectory, "..", ".orbit-secrets", "document-kek-next"), `${"b".repeat(64)}\n`);
    const error = restoreError(paths, missingBundle);
    expect(error).toBeInstanceOf(RestoreEngineRefusal);
    expect(error.message).toMatch(/^preflight\/rotation failed/);
  });

  it("does not treat a symlinked document-kek-next as an open rotation", () => {
    const { root, paths, missingBundle } = deployment();
    symlinkSync(join(root, "elsewhere"), join(root, ".orbit-secrets", "document-kek-next"));
    expect(restoreError(paths, missingBundle).message).not.toContain("rotation");
  });
});

// --- the backup/restore lock ---------------------------------------------

function lockIsFree(lockPath: string): boolean {
  return spawnSync("flock", ["-n", lockPath, "true"]).status === 0;
}

function holdLock(lockPath: string): ChildProcess {
  const holder = spawn("flock", [lockPath, "-c", "sleep 30"], { detached: true, stdio: "ignore" });
  const deadline = Date.now() + 10_000;
  while (lockIsFree(lockPath)) {
    if (Date.now() > deadline) throw new Error("the lock was never taken");
  }
  return holder;
}

describe("the backup/restore lock (scripts/backup-restore-lock.test.mjs, #1151 O2-R3/RANGE-R7)", () => {
  it("a backup reads the live key only once it holds the lock", () => {
    const backupDirectory = join(sandbox(), "backups");
    let lockHeldWhenRead: boolean | undefined;
    expect(() =>
      runBackup({
        backupDirectory,
        documentKekHex: () => {
          lockHeldWhenRead = !lockIsFree(join(backupDirectory, ".orbit-backup-restore.lock"));
          throw new Error("stop here");
        },
        adapter: untouchableAdapter as unknown as BackupDockerAdapter,
        now: new Date(),
      }),
    ).toThrow("stop here");
    expect(lockHeldWhenRead).toBe(true);
  });

  it("restore --recover refuses while another backup or restore holds the lock", () => {
    const { paths } = deployment();
    mkdirSync(paths.backupDirectory, { recursive: true, mode: 0o700 });
    const lockPath = join(paths.backupDirectory, ".orbit-backup-restore.lock");
    const holder = holdLock(lockPath);
    try {
      let caught: unknown;
      try {
        runRecoverRestore({ adapter: untouchableAdapter, paths, workDir: sandbox() });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(BackupRestoreCliRefusal);
      expect((caught as BackupRestoreCliRefusal).code).toBe("restore-locked");
    } finally {
      if (holder.pid !== undefined) process.kill(-holder.pid, "SIGKILL");
    }
  });
});

// --- import-recovery-bundle.sh ---------------------------------------------

const STORAGE_KEY = "9".repeat(64);

function fakeBackupAdapter(documentsRoot: string): BackupDockerAdapter {
  return {
    stopApp: () => undefined,
    startApp: () => undefined,
    dumpDatabase: (outputPath) => writeFileSync(outputPath, "{}"),
    pgRestoreListOk: () => true,
    collectDocumentsArchive: (outputPath) => createTar(documentsRoot, outputPath, ["."]),
    recordRecoveryBundleExported: () => undefined,
  };
}

/** A real recovery bundle for LIVE_KEK, built the way `orbit export-recovery-bundle` builds one. */
function recoveryBundle(passphrase: string): string {
  const root = sandbox();
  const documentsRoot = join(root, "docs");
  mkdirSync(join(documentsRoot, "objects", STORAGE_KEY.slice(0, 2), STORAGE_KEY.slice(2, 4)), { recursive: true });
  writeFileSync(join(documentsRoot, "objects", STORAGE_KEY.slice(0, 2), STORAGE_KEY.slice(2, 4), `${STORAGE_KEY}.bin`), "x");
  const source = runBackup({ backupDirectory: join(root, "b"), documentKekHex: LIVE_KEK, adapter: fakeBackupAdapter(documentsRoot), now: new Date() });
  return runExportRecoveryBundle({
    sourceBundlePath: source.finalTarPath,
    documentKekHex: LIVE_KEK,
    passphrase,
    passphraseConfirmation: passphrase,
    backupDirectory: join(root, "r"),
    adapter: fakeBackupAdapter(documentsRoot),
    now: new Date(),
  }).finalPath;
}

describe("import-recovery-bundle.sh's own refusals (scripts/import-recovery-bundle.test.mjs)", () => {
  it("refuses outright when .orbit-secrets/document-kek-next is present, before touching anything", () => {
    const { root, paths } = deployment();
    const nextKey = join(root, ".orbit-secrets", "document-kek-next");
    writeFileSync(nextKey, `${"b".repeat(64)}\n`);
    const bundle = join(root, "garbage.tar");
    writeFileSync(bundle, "never read");
    let passphraseAsked = false;
    expect(() =>
      runImportRecoveryBundle({
        recoveryBundlePath: bundle,
        passphrase: () => {
          passphraseAsked = true;
          return "never asked for";
        },
        liveDocumentKekFile: paths.documentKekFile,
        backupDirectory: paths.backupDirectory,
        adapter: untouchableAdapter,
        importConfirmed: true,
        confirmRestore: () => true,
      }),
    ).toThrow(/^preflight\/rotation failed/);
    expect(passphraseAsked).toBe(false);
    expect(readFileSync(paths.documentKekFile, "utf8")).toBe(`${LIVE_KEK}\n`);
    expect(existsSync(paths.backupDirectory)).toBe(false);
  });

  it("takes the backup/restore lock before it stops the app or swaps the key", () => {
    const { paths } = deployment();
    const passphrase = "correct horse battery staple";
    const bundle = recoveryBundle(passphrase);
    let lockHeld: boolean | undefined;
    expect(() =>
      runImportRecoveryBundle({
        recoveryBundlePath: bundle,
        passphrase,
        liveDocumentKekFile: paths.documentKekFile,
        backupDirectory: paths.backupDirectory,
        adapter: untouchableAdapter,
        importConfirmed: true,
        confirmRestore: () => true,
        beforeRestore: () => {
          lockHeld = !lockIsFree(join(paths.backupDirectory, ".orbit-backup-restore.lock"));
          throw new Error("stop before the swap");
        },
      }),
    ).toThrow("stop before the swap");
    expect(lockHeld).toBe(true);
    expect(readFileSync(paths.documentKekFile, "utf8")).toBe(`${LIVE_KEK}\n`);
  });

  it("checks the archive before asking for the passphrase, and decrypts before asking to confirm", () => {
    const { root, paths } = deployment();
    const asked: string[] = [];
    const garbage = join(root, "garbage.tar");
    writeFileSync(garbage, "not a tar archive\n");
    const options = {
      liveDocumentKekFile: paths.documentKekFile,
      backupDirectory: paths.backupDirectory,
      adapter: untouchableAdapter,
      confirmRestore: () => true,
    };
    expect(() =>
      runImportRecoveryBundle({
        ...options,
        recoveryBundlePath: garbage,
        passphrase: () => {
          asked.push("passphrase");
          return "x";
        },
        importConfirmed: () => {
          asked.push("confirm");
          return true;
        },
      }),
    ).toThrow("preflight/archive failed; the recovery bundle archive is invalid.");
    expect(asked).toEqual([]);

    expect(() =>
      runImportRecoveryBundle({
        ...options,
        recoveryBundlePath: recoveryBundle("correct horse battery staple"),
        passphrase: () => {
          asked.push("passphrase");
          return "a different passphrase entirely";
        },
        importConfirmed: () => {
          asked.push("confirm");
          return true;
        },
      }),
    ).toThrow("preflight/decryption failed; the recovery key could not be decrypted.");
    expect(asked).toEqual(["passphrase"]);
  });
});
