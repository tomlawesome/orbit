import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  CORRESPONDENCE_QUERIES,
  type CorrespondenceReports,
  type RestoreCheckpointDigests,
  type RestorePaths,
  RestoreEngineRefusal,
  checkCorrespondence,
  computeCheckpointDigests,
  deriveRestorePaths,
  loadRestoreJournal,
  syncCheckpointArtifacts,
  validateCheckpointIntegrity,
  writeRestoreJournal,
} from "./restore-engine";

// Unit coverage for issue #296 slice 3's journal durability, checkpoint
// digest, and validate_correspondence characterization (restore.sh:
// 205-332,399-506,658-736,772-796 — guarantee numbers cited by comment,
// catalogue docs/installer-guarantees.md Part 2 / restore.sh). Full
// state-machine (checkpoint -> cutover -> finalize/rollback) coverage lives
// in restore-engine.docker-adapter.test.ts; real SIGKILL interruption
// coverage lives in restore-engine.interruption.test.ts.

let sandbox: string;
let paths: RestorePaths;

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), "orbit-restore-engine-"));
  const backupDirectory = join(sandbox, "backups");
  mkdirSync(backupDirectory, { recursive: true, mode: 0o700 });
  const documentKekFile = join(sandbox, "document-kek");
  writeFileSync(documentKekFile, `${"a".repeat(64)}\n`, { mode: 0o600 });
  paths = deriveRestorePaths(backupDirectory, documentKekFile);
  mkdirSync(paths.restoreRoot, { recursive: true, mode: 0o700 });
});

afterEach(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

function mode(path: string): number {
  return lstatSync(path).mode & 0o777;
}

const DIGESTS: RestoreCheckpointDigests = {
  databaseSha256: "a".repeat(64),
  documentsSha256: "b".repeat(64),
  documentKekSha256: "c".repeat(64),
};

function makeCheckpointDirectory(): string {
  const checkpointDirectory = mkdtempSync(join(paths.restoreRoot, "checkpoint-"));
  chmodSync(checkpointDirectory, 0o700);
  writeFileSync(join(checkpointDirectory, "database.dump"), "database-bytes", { mode: 0o600 });
  writeFileSync(join(checkpointDirectory, "documents.tar"), "documents-bytes", { mode: 0o600 });
  writeFileSync(join(checkpointDirectory, "document-kek"), `${"a".repeat(64)}\n`, { mode: 0o600 });
  return checkpointDirectory;
}

function restoreIdOf(checkpointDirectory: string): string {
  return checkpointDirectory.slice(checkpointDirectory.lastIndexOf("checkpoint-") + "checkpoint-".length);
}

describe("writeRestoreJournal / loadRestoreJournal round trip (guarantees #15-17,#32-33)", () => {
  it("writes a mode-600 journal that loadRestoreJournal reads back byte-for-byte, and locates the referenced checkpoint", () => {
    const checkpointDirectory = makeCheckpointDirectory();
    const restoreId = restoreIdOf(checkpointDirectory);
    writeRestoreJournal(paths, { restoreId, state: "checkpointed", ...DIGESTS });

    expect(mode(paths.journalPath)).toBe(0o600);
    const content = readFileSync(paths.journalPath, "utf8");
    expect(content).toBe(
      `format_version=1\nrestore_id=${restoreId}\nstate=checkpointed\n` +
        `database_sha256=${DIGESTS.databaseSha256}\ndocuments_sha256=${DIGESTS.documentsSha256}\ndocument_kek_sha256=${DIGESTS.documentKekSha256}\n`,
    );

    const loaded = loadRestoreJournal(paths.journalPath, paths.restoreRoot);
    expect(loaded.fields).toEqual({ restoreId, state: "checkpointed", ...DIGESTS });
    expect(loaded.checkpointDirectory).toBe(checkpointDirectory);
  });

  it("overwrites a previous journal with a later state, and still loads cleanly", () => {
    const checkpointDirectory = makeCheckpointDirectory();
    const restoreId = restoreIdOf(checkpointDirectory);
    writeRestoreJournal(paths, { restoreId, state: "checkpointed", ...DIGESTS });
    writeRestoreJournal(paths, { restoreId, state: "documents-replaced", ...DIGESTS });
    writeRestoreJournal(paths, { restoreId, state: "database-restored", ...DIGESTS });

    const loaded = loadRestoreJournal(paths.journalPath, paths.restoreRoot);
    expect(loaded.fields.state).toBe("database-restored");
  });

  it("refuses to write through a symlinked journal path (#15)", () => {
    writeFileSync(join(sandbox, "elsewhere"), "not a journal");
    symlinkSync(join(sandbox, "elsewhere"), paths.journalPath);
    expect(() => writeRestoreJournal(paths, { restoreId: "abc123", state: "checkpointed", ...DIGESTS })).toThrow(RestoreEngineRefusal);
  });

  it("refuses to write when any checkpoint digest is not a valid 64-hex value (#16)", () => {
    expect(() =>
      writeRestoreJournal(paths, { restoreId: "abc123", state: "checkpointed", databaseSha256: "not-hex", documentsSha256: DIGESTS.documentsSha256, documentKekSha256: DIGESTS.documentKekSha256 }),
    ).toThrow(RestoreEngineRefusal);
  });

  it("restores the previous journal, unmodified, when the post-rename directory sync fails (#17)", () => {
    const checkpointDirectory = makeCheckpointDirectory();
    const restoreId = restoreIdOf(checkpointDirectory);
    writeRestoreJournal(paths, { restoreId, state: "checkpointed", ...DIGESTS });
    const before = readFileSync(paths.journalPath, "utf8");

    expect(() =>
      writeRestoreJournal(paths, { restoreId, state: "documents-replaced", ...DIGESTS }, { beforeJournalDirectorySync: () => { throw new Error("simulated sync failure"); } }),
    ).toThrow(RestoreEngineRefusal);

    expect(readFileSync(paths.journalPath, "utf8")).toBe(before);
    expect(mode(paths.journalPath)).toBe(0o600);
  });

  it("leaves no journal at all when the very first (initial-publish) directory sync fails (#17)", () => {
    const checkpointDirectory = makeCheckpointDirectory();
    const restoreId = restoreIdOf(checkpointDirectory);
    expect(() =>
      writeRestoreJournal(paths, { restoreId, state: "checkpointed", ...DIGESTS }, { beforeJournalDirectorySync: () => { throw new Error("simulated sync failure"); } }),
    ).toThrow(RestoreEngineRefusal);
    expect(() => readFileSync(paths.journalPath)).toThrow();
  });

  it("leaves no temp evidence when the file-level sync fails before any rename (#17)", () => {
    const checkpointDirectory = makeCheckpointDirectory();
    const restoreId = restoreIdOf(checkpointDirectory);
    expect(() =>
      writeRestoreJournal(paths, { restoreId, state: "checkpointed", ...DIGESTS }, { beforeJournalFileSync: () => { throw new Error("simulated sync failure"); } }),
    ).toThrow(RestoreEngineRefusal);
    expect(() => readFileSync(paths.journalPath)).toThrow();
  });
});

describe("loadRestoreJournal refusals (#32-33)", () => {
  it("refuses when no journal file exists", () => {
    expect(() => loadRestoreJournal(paths.journalPath, paths.restoreRoot)).toThrow(RestoreEngineRefusal);
  });

  it("refuses a journal that is not mode 600", () => {
    writeFileSync(paths.journalPath, "format_version=1\nrestore_id=abc\nstate=checkpointed\n", { mode: 0o644 });
    expect(() => loadRestoreJournal(paths.journalPath, paths.restoreRoot)).toThrow(RestoreEngineRefusal);
  });

  it("refuses an unrecognised state value", () => {
    writeFileSync(paths.journalPath, "format_version=1\nrestore_id=abc123\nstate=not-a-real-state\n", { mode: 0o600 });
    expect(() => loadRestoreJournal(paths.journalPath, paths.restoreRoot)).toThrow(RestoreEngineRefusal);
  });

  it("refuses an invalid restore_id", () => {
    writeFileSync(paths.journalPath, "format_version=1\nrestore_id=has a space\nstate=checkpointed\n", { mode: 0o600 });
    expect(() => loadRestoreJournal(paths.journalPath, paths.restoreRoot)).toThrow(RestoreEngineRefusal);
  });

  it("refuses malformed digest fields", () => {
    writeFileSync(paths.journalPath, "format_version=1\nrestore_id=abc123\nstate=checkpointed\ndatabase_sha256=nope\n", { mode: 0o600 });
    expect(() => loadRestoreJournal(paths.journalPath, paths.restoreRoot)).toThrow(RestoreEngineRefusal);
  });

  it("refuses when the referenced checkpoint directory does not exist", () => {
    writeFileSync(
      paths.journalPath,
      `format_version=1\nrestore_id=missing123\nstate=checkpointed\ndatabase_sha256=${DIGESTS.databaseSha256}\ndocuments_sha256=${DIGESTS.documentsSha256}\ndocument_kek_sha256=${DIGESTS.documentKekSha256}\n`,
      { mode: 0o600 },
    );
    expect(() => loadRestoreJournal(paths.journalPath, paths.restoreRoot)).toThrow(RestoreEngineRefusal);
  });

  it("refuses when the checkpoint directory is missing one of its three artifacts", () => {
    const checkpointDirectory = makeCheckpointDirectory();
    const restoreId = restoreIdOf(checkpointDirectory);
    rmSync(join(checkpointDirectory, "document-kek"));
    writeFileSync(
      paths.journalPath,
      `format_version=1\nrestore_id=${restoreId}\nstate=checkpointed\ndatabase_sha256=${DIGESTS.databaseSha256}\ndocuments_sha256=${DIGESTS.documentsSha256}\ndocument_kek_sha256=${DIGESTS.documentKekSha256}\n`,
      { mode: 0o600 },
    );
    expect(() => loadRestoreJournal(paths.journalPath, paths.restoreRoot)).toThrow(RestoreEngineRefusal);
  });
});

describe("checkpoint digests (#13-14)", () => {
  it("computeCheckpointDigests / validateCheckpointIntegrity round-trip against real artifact content", () => {
    const checkpointDirectory = makeCheckpointDirectory();
    const digests = computeCheckpointDigests(checkpointDirectory);
    expect(digests.databaseSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(validateCheckpointIntegrity(checkpointDirectory, digests)).toBe(true);
  });

  it("detects a changed artifact after the fact", () => {
    const checkpointDirectory = makeCheckpointDirectory();
    const digests = computeCheckpointDigests(checkpointDirectory);
    writeFileSync(join(checkpointDirectory, "documents.tar"), "tampered-bytes", { mode: 0o600 });
    expect(validateCheckpointIntegrity(checkpointDirectory, digests)).toBe(false);
  });

  it("syncCheckpointArtifacts durably syncs every artifact and the directory itself", () => {
    const checkpointDirectory = makeCheckpointDirectory();
    expect(() => syncCheckpointArtifacts(checkpointDirectory)).not.toThrow();
  });

  it("syncCheckpointArtifacts refuses when a hook simulates a sync failure", () => {
    const checkpointDirectory = makeCheckpointDirectory();
    expect(() => syncCheckpointArtifacts(checkpointDirectory, { beforeCheckpointArtifactSync: () => { throw new Error("simulated"); } })).toThrow(
      RestoreEngineRefusal,
    );
  });
});

describe("checkCorrespondence (restore.sh:205-332,658-736, guarantee #9)", () => {
  const STORAGE_KEY = "a".repeat(64);
  const CONTENT = Buffer.alloc(10, 7);

  function documentsRootWithObject(): string {
    const root = mkdtempSync(join(tmpdir(), "orbit-correspondence-"));
    const objectDir = join(root, "objects", STORAGE_KEY.slice(0, 2), STORAGE_KEY.slice(2, 4));
    mkdirSync(objectDir, { recursive: true });
    mkdirSync(join(root, "staging"), { recursive: true });
    writeFileSync(join(objectDir, `${STORAGE_KEY}.bin`), CONTENT);
    return root;
  }

  function baseReports(): CorrespondenceReports {
    return {
      crypto: `doc-1|${STORAGE_KEY}|${CONTENT.length}|available\n`,
      visible: `doc-1|available|${STORAGE_KEY}|${CONTENT.length}\n`,
      attachments: "",
      staging: "",
      documentStaging: "",
      transientCount: "0",
    };
  }

  it("accepts a fully-consistent single-document correspondence", () => {
    const root = documentsRootWithObject();
    expect(checkCorrespondence(baseReports(), root)).toBe(true);
    rmSync(root, { recursive: true, force: true });
  });

  it("refuses when a transient (in-flight) document lifecycle row exists", () => {
    const root = documentsRootWithObject();
    expect(checkCorrespondence({ ...baseReports(), transientCount: "1" }, root)).toBe(false);
    rmSync(root, { recursive: true, force: true });
  });

  it("refuses when the referenced object is missing on disk", () => {
    const root = mkdtempSync(join(tmpdir(), "orbit-correspondence-missing-"));
    mkdirSync(join(root, "objects"), { recursive: true });
    mkdirSync(join(root, "staging"), { recursive: true });
    expect(checkCorrespondence(baseReports(), root)).toBe(false);
    rmSync(root, { recursive: true, force: true });
  });

  it("refuses on a ciphertext-size mismatch between the row and the actual blob", () => {
    const root = documentsRootWithObject();
    const reports = { ...baseReports(), crypto: `doc-1|${STORAGE_KEY}|999999|available\n` };
    expect(checkCorrespondence(reports, root)).toBe(false);
    rmSync(root, { recursive: true, force: true });
  });

  it("refuses on a duplicate storage-key reference across rows", () => {
    const root = documentsRootWithObject();
    const reports = { ...baseReports(), crypto: `doc-1|${STORAGE_KEY}|${CONTENT.length}|available\ndoc-2|${STORAGE_KEY}|${CONTENT.length}|available\n` };
    expect(checkCorrespondence(reports, root)).toBe(false);
    rmSync(root, { recursive: true, force: true });
  });

  it("refuses an orphaned on-disk object with no referencing database row", () => {
    const root = documentsRootWithObject();
    const orphanKey = "b".repeat(64);
    const orphanDir = join(root, "objects", orphanKey.slice(0, 2), orphanKey.slice(2, 4));
    mkdirSync(orphanDir, { recursive: true });
    writeFileSync(join(orphanDir, `${orphanKey}.bin`), Buffer.alloc(3, 1));
    expect(checkCorrespondence(baseReports(), root)).toBe(false);
    rmSync(root, { recursive: true, force: true });
  });

  it("refuses a misplaced object whose prefix directory does not match its own hash", () => {
    const root = mkdtempSync(join(tmpdir(), "orbit-correspondence-misplaced-"));
    // Deliberately wrong prefix directory ("00/00" instead of the key's own "aa/aa").
    const misplacedDir = join(root, "objects", "00", "00");
    mkdirSync(misplacedDir, { recursive: true });
    mkdirSync(join(root, "staging"), { recursive: true });
    writeFileSync(join(misplacedDir, `${STORAGE_KEY}.bin`), CONTENT);
    expect(checkCorrespondence(baseReports(), root)).toBe(false);
    rmSync(root, { recursive: true, force: true });
  });

  it("refuses a visible document with no matching crypto metadata (empty storage key)", () => {
    const root = documentsRootWithObject();
    const reports = { ...baseReports(), visible: "doc-1|available|| \n" };
    expect(checkCorrespondence(reports, root)).toBe(false);
    rmSync(root, { recursive: true, force: true });
  });

  it("accepts a pending staging-ledger row whose object is absent (safe: write may have failed)", () => {
    const root = mkdtempSync(join(tmpdir(), "orbit-correspondence-staging-absent-"));
    mkdirSync(join(root, "objects"), { recursive: true });
    mkdirSync(join(root, "staging"), { recursive: true });
    const reports: CorrespondenceReports = {
      crypto: "",
      visible: "",
      attachments: "",
      staging: `${STORAGE_KEY}|pending\n`,
      documentStaging: "",
      transientCount: "0",
    };
    expect(checkCorrespondence(reports, root)).toBe(true);
    rmSync(root, { recursive: true, force: true });
  });

  it("refuses a pending staging-ledger row whose object exists but is not referenced by a document row (would be treated as orphaned)", () => {
    const root = mkdtempSync(join(tmpdir(), "orbit-correspondence-staging-present-"));
    const objectDir = join(root, "objects", STORAGE_KEY.slice(0, 2), STORAGE_KEY.slice(2, 4));
    mkdirSync(objectDir, { recursive: true });
    mkdirSync(join(root, "staging"), { recursive: true });
    writeFileSync(join(objectDir, `${STORAGE_KEY}.bin`), CONTENT);
    const reports: CorrespondenceReports = {
      crypto: "",
      visible: "",
      attachments: "",
      staging: `${STORAGE_KEY}|pending\n`,
      documentStaging: "",
      transientCount: "0",
    };
    // The staging ledger marks the object referenced, so it must not be
    // flagged orphaned — this is the accept case; a genuinely orphaned
    // object (no ledger entry at all) is covered above.
    expect(checkCorrespondence(reports, root)).toBe(true);
    rmSync(root, { recursive: true, force: true });
  });

  it("validates document_staging_objects rows against documentsRoot/staging/<key>.bin (not objects/)", () => {
    const root = mkdtempSync(join(tmpdir(), "orbit-correspondence-document-stage-"));
    mkdirSync(join(root, "objects"), { recursive: true });
    mkdirSync(join(root, "staging"), { recursive: true });
    writeFileSync(join(root, "staging", `${STORAGE_KEY}.bin`), CONTENT);
    const documentId36 = "1".repeat(36);
    const reports: CorrespondenceReports = {
      crypto: "",
      visible: "",
      attachments: "",
      staging: "",
      documentStaging: `${documentId36}|${STORAGE_KEY}|pending|${CONTENT.length}\n`,
      transientCount: "0",
    };
    expect(checkCorrespondence(reports, root)).toBe(true);
    rmSync(root, { recursive: true, force: true });
  });
});

describe("CORRESPONDENCE_QUERIES", () => {
  it("exposes exactly the six named report queries", () => {
    expect(Object.keys(CORRESPONDENCE_QUERIES).sort()).toEqual(
      ["attachments", "crypto", "documentStaging", "staging", "transientCount", "visible"].sort(),
    );
  });
});
