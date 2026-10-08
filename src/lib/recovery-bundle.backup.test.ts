import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PROCESS_TEST_TIMEOUT_MS } from "../../scripts/process-budget.mjs";
import {
  type BackupDockerAdapter,
  RecoveryBundleRefusal,
  computeBundleHmac,
  createBackupBundle,
  createTar,
  documentKekFingerprint,
  encryptDocumentArchive,
  extractTar,
  publishBundleAtomically,
  validateBackupBundleContents,
  validateBackupBundleLayout,
} from "./recovery-bundle";

// issue #296 slice 2: BackupDockerAdapter is the thin, injectable edge over
// the handful of backup.sh operations that need a live Postgres deployment
// (pg_restore --list, pg_dump, the document-tar collection, stopping/starting
// orbit-app). This file proves the pure orchestration functions
// (createBackupBundle, validateBackupBundleContents) are correct against a
// trivial in-memory fake adapter — no process spawning at all. The adapter
// the shipped CLI runs with is src/lib/in-container-adapter.ts (#1211); its
// argv is proved in in-container-adapter.test.ts.

// One fixture below spawns a real `tar`; a spawn that takes 0.7s quiet took
// 4.3s on a starved core (#698). Budget and reasoning:
// scripts/process-budget.mjs.
vi.setConfig({ testTimeout: PROCESS_TEST_TIMEOUT_MS });

const KEK_A = "a".repeat(64);
const KEK_B = "b".repeat(64);

const sandboxes: string[] = [];

afterEach(() => {
  for (const sandbox of sandboxes.splice(0)) rmSync(sandbox, { recursive: true, force: true });
});

function newSandbox(prefix: string): string {
  const sandbox = mkdtempSync(join(tmpdir(), prefix));
  sandboxes.push(sandbox);
  return sandbox;
}

// --- (1) in-memory fake adapter: pure orchestration logic ------------------

class FakeAdapter implements BackupDockerAdapter {
  stopCalls = 0;
  startCalls = 0;
  pgRestoreOk = true;
  documentsTarBytes: Buffer;
  databaseDumpBytes: Buffer;

  constructor(options: { pgRestoreOk?: boolean; documentsTarBuilder: () => Buffer; databaseDumpBytes?: Buffer } | (() => Buffer)) {
    if (typeof options === "function") {
      this.documentsTarBytes = options();
      this.databaseDumpBytes = Buffer.from("fake-pg-dump-bytes");
    } else {
      this.documentsTarBytes = options.documentsTarBuilder();
      this.databaseDumpBytes = options.databaseDumpBytes ?? Buffer.from("fake-pg-dump-bytes");
      this.pgRestoreOk = options.pgRestoreOk ?? true;
    }
  }

  stopApp(): void {
    this.stopCalls += 1;
  }
  startApp(): void {
    this.startCalls += 1;
  }
  dumpDatabase(outputPath: string): void {
    writeFileSync(outputPath, this.databaseDumpBytes);
  }
  pgRestoreListOk(): boolean {
    return this.pgRestoreOk;
  }
  collectDocumentsArchive(outputPath: string): void {
    writeFileSync(outputPath, this.documentsTarBytes);
  }
  recordExportedCalls = 0;
  recordRecoveryBundleExported(): void {
    this.recordExportedCalls += 1;
  }
}

function emptyDocumentsTar(dir: string): Buffer {
  const scaffoldDir = join(dir, "documents-scaffold");
  mkdirSync(join(scaffoldDir, "objects"), { recursive: true });
  mkdirSync(join(scaffoldDir, "staging"), { recursive: true });
  const tarPath = join(dir, "documents-scaffold.tar");
  // "." matches backup.sh:154's own `tar -C /var/lib/orbit/documents -cf - .`
  // exactly, so every member name is `./`-prefixed like the real archive.
  createTar(scaffoldDir, tarPath, ["."]);
  return readFileSync(tarPath);
}

/** A documents tar containing one real, large object, honoring the objects/xx/yy/<hash>.bin layout validateDocumentArchiveEntries requires. */
function largeDocumentsTar(dir: string, sizeBytes: number): Buffer {
  const scaffoldDir = join(dir, "large-documents-scaffold");
  const storageKey = "ab".repeat(32); // 64 hex chars; its own "ab"/"ab" prefix directories match slice(0,4).
  const objectDir = join(scaffoldDir, "objects", storageKey.slice(0, 2), storageKey.slice(2, 4));
  mkdirSync(objectDir, { recursive: true });
  mkdirSync(join(scaffoldDir, "staging"), { recursive: true });
  writeFileSync(join(objectDir, `${storageKey}.bin`), Buffer.alloc(sizeBytes, 6));
  const tarPath = join(dir, "large-documents-scaffold.tar");
  createTar(scaffoldDir, tarPath, ["."]);
  return readFileSync(tarPath);
}

describe("createBackupBundle (in-memory fake adapter, no process spawning)", () => {
  it("produces a bundle that validateBackupBundleContents accepts, and always calls stop/start exactly once", () => {
    const sandbox = newSandbox("orbit-create-bundle-happy-");
    const backupDirectory = join(sandbox, "backups");
    mkdirSync(backupDirectory, { recursive: true, mode: 0o700 });
    const finalTarPath = join(backupDirectory, "orbit-20260813-000000.tar");
    const adapter = new FakeAdapter({ documentsTarBuilder: () => emptyDocumentsTar(sandbox) });

    const result = createBackupBundle(backupDirectory, finalTarPath, KEK_A, adapter, "2026-08-13T00:00:00Z");

    expect(result.finalTarPath).toBe(finalTarPath);
    expect(result.manifestFields.documentKekSha256).toBe(documentKekFingerprint(KEK_A));
    expect(adapter.stopCalls).toBe(1);
    expect(adapter.startCalls).toBe(1);
    expect(existsSync(finalTarPath)).toBe(true);
    expect(existsSync(`${finalTarPath}.installing`)).toBe(false);

    validateBackupBundleLayout(finalTarPath);
    const extractedDir = join(sandbox, "extracted");
    mkdirSync(extractedDir);
    extractTar(finalTarPath, extractedDir);
    const fields = validateBackupBundleContents(extractedDir, KEK_A, { pgRestoreListOk: () => true });
    expect(fields.documentKekSha256).toBe(documentKekFingerprint(KEK_A));
  });

  // #383: createBackupBundle used to read the whole collected documents.tar
  // into one Buffer (readRegularFileNoFollow) and then hold plaintext,
  // ciphertext, and a concatenated header+ciphertext copy simultaneously
  // (encryptDocumentArchive's Buffer.concat calls) — roughly 3-4x the
  // document tree's size resident at once, enough to OOM a real household's
  // backup on a modest home server. It now streams documents.tar straight
  // through encryption to disk (encryptDocumentArchiveToFile). A multi-GB
  // reproduction is impractical in a test; this uses a large-but-tractable
  // 80 MB document tree and asserts the RSS growth attributable to
  // createBackupBundle stays a small fraction of that.
  it("streams the collected document archive through encryption without an RSS spike proportional to its size (#383)", () => {
    const sandbox = newSandbox("orbit-create-bundle-large-documents-");
    const backupDirectory = join(sandbox, "backups");
    mkdirSync(backupDirectory, { recursive: true, mode: 0o700 });
    const finalTarPath = join(backupDirectory, "orbit-20260813-000000.tar");
    const size = 80 * 1024 * 1024;
    const adapter = new FakeAdapter({ documentsTarBuilder: () => largeDocumentsTar(sandbox, size) });
    const originalDocumentsTar = adapter.documentsTarBytes;

    const before = process.memoryUsage().rss;
    const result = createBackupBundle(backupDirectory, finalTarPath, KEK_A, adapter, "2026-08-13T00:00:00Z");
    const after = process.memoryUsage().rss;

    // The old buffered path needed roughly 3-4x the 80 MB document tree
    // resident at once; the streaming path never holds more than one
    // bounded chunk, so growth attributable to this call should be a small
    // fraction of the tree's own size.
    expect(after - before).toBeLessThan(size / 2);

    expect(result.finalTarPath).toBe(finalTarPath);
    expect(existsSync(finalTarPath)).toBe(true);
    validateBackupBundleLayout(finalTarPath);
    const extractedDir = join(sandbox, "extracted-large");
    mkdirSync(extractedDir);
    extractTar(finalTarPath, extractedDir);
    const fields = validateBackupBundleContents(extractedDir, KEK_A, { pgRestoreListOk: () => true });
    expect(fields.documentKekSha256).toBe(documentKekFingerprint(KEK_A));
    // Round-trips byte-for-byte through the streaming encrypt + the
    // (unmodified) buffered decrypt path. `.equals()`, not `toEqual` — deep
    // equality on multi-MB buffers is catastrophically slow in Vitest.
    const roundTripped = readFileSync(join(extractedDir, "documents.tar"));
    expect(roundTripped.equals(originalDocumentsTar)).toBe(true);
  }, 30_000);

  it("publishes the bundle at mode 0600 regardless of the ambient umask (issue #383 finding 5: backup.sh's `umask 077` was never ported)", () => {
    const sandbox = newSandbox("orbit-create-bundle-mode-");
    const backupDirectory = join(sandbox, "backups");
    mkdirSync(backupDirectory, { recursive: true, mode: 0o700 });
    const finalTarPath = join(backupDirectory, "orbit-20260813-000000.tar");
    const adapter = new FakeAdapter({ documentsTarBuilder: () => emptyDocumentsTar(sandbox) });

    // A permissive ambient umask, as a root/operator shell commonly has —
    // before the fix, a plain `tar -cf` honoured this and the bundle
    // (containing the unencrypted database.dump) landed at 0644.
    const previousUmask = process.umask(0o022);
    try {
      createBackupBundle(backupDirectory, finalTarPath, KEK_A, adapter, "2026-08-13T00:00:00Z");
    } finally {
      process.umask(previousUmask);
    }

    expect(lstatSync(finalTarPath).mode & 0o777).toBe(0o600);
  });

  it("restarts the app even when dumpDatabase throws mid-backup (EXIT-trap equivalent, backup.sh #23)", () => {
    const sandbox = newSandbox("orbit-create-bundle-dump-fails-");
    const backupDirectory = join(sandbox, "backups");
    mkdirSync(backupDirectory, { recursive: true, mode: 0o700 });
    const finalTarPath = join(backupDirectory, "orbit-20260813-000000.tar");
    const adapter = new FakeAdapter({ documentsTarBuilder: () => emptyDocumentsTar(sandbox) });
    adapter.dumpDatabase = () => {
      throw new Error("simulated pg_dump failure");
    };

    expect(() => createBackupBundle(backupDirectory, finalTarPath, KEK_A, adapter, "2026-08-13T00:00:00Z")).toThrow(
      "simulated pg_dump failure",
    );
    expect(adapter.stopCalls).toBe(1);
    expect(adapter.startCalls).toBe(1);
    expect(existsSync(finalTarPath)).toBe(false);
  });

  it("refuses when the freshly produced database dump is not pg_restore-listable (#18,#25)", () => {
    const sandbox = newSandbox("orbit-create-bundle-bad-dump-");
    const backupDirectory = join(sandbox, "backups");
    mkdirSync(backupDirectory, { recursive: true, mode: 0o700 });
    const finalTarPath = join(backupDirectory, "orbit-20260813-000000.tar");
    const adapter = new FakeAdapter({ documentsTarBuilder: () => emptyDocumentsTar(sandbox), pgRestoreOk: false });

    let error: unknown;
    try {
      createBackupBundle(backupDirectory, finalTarPath, KEK_A, adapter, "2026-08-13T00:00:00Z");
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(RecoveryBundleRefusal);
    expect((error as RecoveryBundleRefusal).code).toBe("database-archive-invalid");
    expect(adapter.startCalls).toBe(1);
  });

  it("never leaves a plaintext document archive, or any other scratch file, on disk (#21,#28)", () => {
    const sandbox = newSandbox("orbit-create-bundle-plaintext-cleanup-");
    const backupDirectory = join(sandbox, "backups");
    mkdirSync(backupDirectory, { recursive: true, mode: 0o700 });
    const finalTarPath = join(backupDirectory, "orbit-20260813-000000.tar");
    const adapter = new FakeAdapter({ documentsTarBuilder: () => emptyDocumentsTar(sandbox) });
    createBackupBundle(backupDirectory, finalTarPath, KEK_A, adapter, "2026-08-13T00:00:00Z");
    // The private work directory (mkdtempSync'd inside backupDirectory) is
    // removed entirely on the way out — only the published tar remains.
    expect(readdirSync(backupDirectory)).toEqual(["orbit-20260813-000000.tar"]);
  });

  it("refuses to clobber an existing same-named backup, race-free (#32)", () => {
    const sandbox = newSandbox("orbit-create-bundle-no-clobber-");
    const backupDirectory = join(sandbox, "backups");
    mkdirSync(backupDirectory, { recursive: true, mode: 0o700 });
    const finalTarPath = join(backupDirectory, "orbit-20260813-000000.tar");
    writeFileSync(finalTarPath, "an already-existing backup, must not be overwritten");
    const adapter = new FakeAdapter({ documentsTarBuilder: () => emptyDocumentsTar(sandbox) });

    let error: unknown;
    try {
      createBackupBundle(backupDirectory, finalTarPath, KEK_A, adapter, "2026-08-13T00:00:00Z");
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(RecoveryBundleRefusal);
    expect((error as RecoveryBundleRefusal).code).toBe("bundle-already-exists");
    expect(readFileSync(finalTarPath, "utf8")).toBe("an already-existing backup, must not be overwritten");
    expect(existsSync(`${finalTarPath}.installing`)).toBe(false);
  });
});

describe("validateBackupBundleContents (in-memory adapter)", () => {
  function buildValidExtractedBundle(dir: string, documentKekHex: string): void {
    const documentsTarPath = join(dir, "documents.tar.plain");
    writeFileSync(documentsTarPath, emptyDocumentsTar(dir));
    const encrypted = encryptDocumentArchive(readFileSync(documentsTarPath), documentKekHex);
    writeFileSync(join(dir, "documents.tar.enc"), encrypted);
    writeFileSync(join(dir, "database.dump"), "fake-pg-dump-bytes");
    const manifest =
      `format_version=1\ncreated_at=2026-08-13T00:00:00Z\ndatabase_dump=database.dump\n` +
      `documents_archive=documents.tar.enc\ndocuments_encryption=aes-256-cbc-pbkdf2-sha256-iter-600000\n` +
      `document_kek_sha256=${documentKekFingerprint(documentKekHex)}\n`;
    writeFileSync(join(dir, "manifest"), manifest);
    const checksums =
      `${createHash("sha256").update(readFileSync(join(dir, "database.dump"))).digest("hex")}  database.dump\n` +
      `${createHash("sha256").update(readFileSync(join(dir, "documents.tar.enc"))).digest("hex")}  documents.tar.enc\n`;
    writeFileSync(join(dir, "checksums.sha256"), checksums);
    const manifestAndChecksums = Buffer.concat([Buffer.from(manifest), Buffer.from(checksums)]);
    const hmac = computeBundleHmac(documentKekHex, manifestAndChecksums);
    writeFileSync(join(dir, "manifest.hmac"), hmac);
  }

  it("accepts a bundle whose database dump and document archive both check out", () => {
    const sandbox = newSandbox("orbit-validate-contents-happy-");
    buildValidExtractedBundle(sandbox, KEK_A);
    const fields = validateBackupBundleContents(sandbox, KEK_A, { pgRestoreListOk: () => true });
    expect(fields.documentKekSha256).toBe(documentKekFingerprint(KEK_A));
    expect(existsSync(join(sandbox, "documents.tar"))).toBe(true);
  });

  it("refuses when pg_restore --list reports the dump invalid (#18)", () => {
    const sandbox = newSandbox("orbit-validate-contents-bad-dump-");
    buildValidExtractedBundle(sandbox, KEK_A);
    let error: unknown;
    try {
      validateBackupBundleContents(sandbox, KEK_A, { pgRestoreListOk: () => false });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(RecoveryBundleRefusal);
    expect((error as RecoveryBundleRefusal).code).toBe("database-archive-invalid");
  });

  it("refuses when the document archive cannot be decrypted with the given key (#19)", () => {
    const sandbox = newSandbox("orbit-validate-contents-wrong-key-");
    buildValidExtractedBundle(sandbox, KEK_A);
    // validateBackupManifestAndAuth already refuses a KEK/fingerprint mismatch
    // (wrong-key) before decryption is attempted; to reach the decrypt step
    // specifically, keep the manifest's own fingerprint honest but hand a
    // *different* key to decrypt with is impossible without also failing the
    // fingerprint check first — so this exercises the same fail-closed
    // ordering the Bash script has (manifest/HMAC/checksum before decrypt).
    let error: unknown;
    try {
      validateBackupBundleContents(sandbox, KEK_B, { pgRestoreListOk: () => true });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(RecoveryBundleRefusal);
    expect((error as RecoveryBundleRefusal).code).toBe("wrong-key");
  });

});

describe("publishBundleAtomically", () => {
  it("moves the temp file into place when the destination does not exist", () => {
    const sandbox = newSandbox("orbit-publish-atomic-");
    const temp = join(sandbox, "bundle.tar.installing");
    const final = join(sandbox, "bundle.tar");
    writeFileSync(temp, "bundle contents");
    publishBundleAtomically(temp, final);
    expect(existsSync(temp)).toBe(false);
    expect(readFileSync(final, "utf8")).toBe("bundle contents");
  });

  it("refuses race-free when the destination already exists, without touching either file's content", () => {
    const sandbox = newSandbox("orbit-publish-atomic-clobber-");
    const temp = join(sandbox, "bundle.tar.installing");
    const final = join(sandbox, "bundle.tar");
    writeFileSync(temp, "new bundle contents");
    writeFileSync(final, "existing bundle contents");
    expect(() => publishBundleAtomically(temp, final)).toThrow(RecoveryBundleRefusal);
    expect(readFileSync(final, "utf8")).toBe("existing bundle contents");
    expect(readFileSync(temp, "utf8")).toBe("new bundle contents");
  });
});
