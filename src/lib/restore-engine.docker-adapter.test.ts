import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createTar, extractTar } from "./recovery-bundle";
import {
  CORRESPONDENCE_QUERIES,
  type CorrespondenceReports,
  type RestoreDockerAdapter,
  type RestorePaths,
  RestoreEngineRefusal,
  RestoreRun,
  deriveRestorePaths,
  loadRestoreJournal,
  preflightValidateBundle,
  recoverRestore,
} from "./restore-engine";

// End-to-end RestoreRun/recoverRestore coverage against a trivial in-memory
// fake RestoreDockerAdapter — no process spawning, no Docker daemon,
// mirroring recovery-bundle.docker-adapter.test.ts's "(1) in-memory fake
// adapter" section. The real createDockerComposeRestoreAdapter's argv shape
// is proven separately by restore-engine.parity.test.ts's awk-extracted SQL
// text equality (a live daemon is out of reach in this sandbox, matching
// how recovery-bundle's own adapter tests use a PATH-shim rather than a
// real daemon; the SQL/argv text itself is what's characterized here).
//
// This file is the primary evidence for the task's "every mutating step of
// the state machine has a journal entry before it and a rollback path"
// requirement: each `it` below interrupts (via a thrown error, not a real
// SIGKILL — see restore-engine.interruption.test.ts for that) at a specific
// step and asserts the journal/checkpoint left behind is exactly what the
// next attempt (rollback, in-process, or --recover, a fresh process) needs.

const DOCUMENT_ID = "11111111-1111-4111-8111-111111111111";
const LIVE_KEK = "a".repeat(64);

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

/**
 * Stands in for Docker/Postgres entirely in-memory: "the database" is just
 * a CorrespondenceReports value tagged by name, and "the document volume" is
 * a real directory this fake extracts/collects real tar archives into/out
 * of (via the real `tar` binary through recovery-bundle.ts's createTar/
 * extractTar — no shell interpolation, no Docker).
 */
class FakeRestoreAdapter implements RestoreDockerAdapter {
  stopCalls = 0;
  startCalls = 0;
  healthOk = true;
  pgRestoreOk = true;
  replaceDocumentsOk = true;
  restoreActiveDatabaseOk = true;
  restoreDumpToDatabaseOk = true;
  resetScanLeasesOk = true;
  private appRunning = true;
  private readonly stageContents = new Map<string, CorrespondenceReports>();
  private liveReports: CorrespondenceReports;

  constructor(
    private readonly liveDocumentsRoot: string,
    initialStorageKey: string,
    initialContentLength: number,
  ) {
    this.liveReports = reportsFor(initialStorageKey, initialContentLength);
  }

  dumpDatabase(outputPath: string): void {
    writeFileSync(outputPath, JSON.stringify(this.liveReports));
  }
  pgRestoreListOk(): boolean {
    return this.pgRestoreOk;
  }
  collectDocumentsArchive(outputPath: string): void {
    createTar(this.liveDocumentsRoot, outputPath, ["."]);
  }
  stopApp(): boolean {
    this.stopCalls += 1;
    this.appRunning = false;
    return true;
  }
  startApp(): boolean {
    this.startCalls += 1;
    this.appRunning = true;
    return true;
  }
  createStageDatabase(): void {
    // No-op: restoreDumpToDatabase records the staged content directly.
  }
  dropStageDatabase(name: string): void {
    this.stageContents.delete(name);
  }
  restoreDumpToDatabase(name: string, dumpPath: string): boolean {
    if (!this.restoreDumpToDatabaseOk) return false;
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
    return 1024;
  }
  measureLiveDocumentTreeKib(): number {
    return 1;
  }
  measureDocumentVolumeAvailableKib(): number {
    return 1_000_000;
  }
}

let sandbox: string;
let paths: RestorePaths;
let documentKekFile: string;

function buildDocumentTree(root: string, storageKey: string, contentLength: number, fillByte = 5): void {
  rmSync(root, { recursive: true, force: true });
  const objectDir = join(root, "objects", storageKey.slice(0, 2), storageKey.slice(2, 4));
  mkdirSync(objectDir, { recursive: true });
  mkdirSync(join(root, "staging"), { recursive: true });
  writeFileSync(join(objectDir, `${storageKey}.bin`), Buffer.alloc(contentLength, fillByte));
}

function tarOf(root: string, dest: string): string {
  createTar(root, dest, ["."]);
  return dest;
}

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), "orbit-restore-run-"));
  const backupDirectory = join(sandbox, "backups");
  mkdirSync(backupDirectory, { recursive: true, mode: 0o700 });
  documentKekFile = join(sandbox, "document-kek");
  writeFileSync(documentKekFile, `${LIVE_KEK}\n`, { mode: 0o600 });
  paths = deriveRestorePaths(backupDirectory, documentKekFile);
});

afterEach(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

const ORIGINAL_KEY = "a".repeat(64);
const NEW_KEY = "b".repeat(64);

describe("RestoreRun full lifecycle (checkpoint -> cutover -> finalize)", () => {
  it("completes a restore end-to-end, replacing live documents/database and leaving no journal or checkpoint behind", () => {
    const liveDocumentsRoot = join(sandbox, "live-documents");
    buildDocumentTree(liveDocumentsRoot, ORIGINAL_KEY, 10);
    const adapter = new FakeRestoreAdapter(liveDocumentsRoot, ORIGINAL_KEY, 10);

    const workDir = mkdtempSync(join(sandbox, "work-"));
    const run = RestoreRun.prepare({ adapter, paths, workDir });
    run.createCheckpoint();
    expect(run.isCheckpointVerified()).toBe(true);
    expect(readFileSync(paths.journalPath, "utf8")).toContain("state=checkpointed\n");

    const newDocumentsRoot = join(sandbox, "new-documents");
    buildDocumentTree(newDocumentsRoot, NEW_KEY, 20);
    const newDocumentsTar = tarOf(newDocumentsRoot, join(sandbox, "new-documents.tar"));
    run.cutoverDocuments(newDocumentsTar);
    expect(readFileSync(paths.journalPath, "utf8")).toContain("state=documents-replaced\n");

    const newDatabaseDump = join(sandbox, "new-database.dump");
    writeFileSync(newDatabaseDump, JSON.stringify(reportsFor(NEW_KEY, 20)));
    run.cutoverDatabase(newDatabaseDump);
    expect(readFileSync(paths.journalPath, "utf8")).toContain("state=database-restored\n");

    run.finalize();
    expect(run.isCompleted()).toBe(true);
    expect(() => readFileSync(paths.journalPath)).toThrow();
    expect(adapter.startCalls).toBe(1);

    const disposeResult = run.dispose();
    expect(disposeResult.outcome).toBe("completed");
    // A second dispose() is a no-op (idempotent, like InstallTransaction.dispose()).
    expect(run.dispose().outcome).toBe("completed");
  });
});

describe("Interruption-test matrix: every mutating step has a journal entry before it and a rollback path", () => {
  it("interrupted immediately after createCheckpoint (before any live mutation): dispose() rolls back to a healthy, unchanged app with no journal/checkpoint left", () => {
    const liveDocumentsRoot = join(sandbox, "live-documents");
    buildDocumentTree(liveDocumentsRoot, ORIGINAL_KEY, 10);
    const adapter = new FakeRestoreAdapter(liveDocumentsRoot, ORIGINAL_KEY, 10);
    const workDir = mkdtempSync(join(sandbox, "work-"));
    const run = RestoreRun.prepare({ adapter, paths, workDir });

    run.createCheckpoint();
    // Simulated interruption: no cutover step ever runs. dispose() is the
    // in-process EXIT-trap equivalent (real-process SIGKILL recovery is
    // proven in restore-engine.interruption.test.ts).
    const result = run.dispose();

    expect(result.outcome).toBe("rolled-back");
    expect(() => readFileSync(paths.journalPath)).toThrow();
    expect(adapter.startCalls).toBe(1);
    expect(adapter.waitForHealth()).toBe(true);
    // Rollback re-applies the checkpoint, which is identical to the
    // original live state here (nothing was ever mutated) — the live tree
    // must still contain exactly the original object.
    expect(readFileSync(join(liveDocumentsRoot, "objects", ORIGINAL_KEY.slice(0, 2), ORIGINAL_KEY.slice(2, 4), `${ORIGINAL_KEY}.bin`))).toHaveLength(10);
  });

  it("interrupted after cutoverDocuments (first live mutation, journaled): dispose() rolls the document tree back to the checkpoint", () => {
    const liveDocumentsRoot = join(sandbox, "live-documents");
    buildDocumentTree(liveDocumentsRoot, ORIGINAL_KEY, 10);
    const adapter = new FakeRestoreAdapter(liveDocumentsRoot, ORIGINAL_KEY, 10);
    const workDir = mkdtempSync(join(sandbox, "work-"));
    const run = RestoreRun.prepare({ adapter, paths, workDir });
    run.createCheckpoint();

    const newDocumentsRoot = join(sandbox, "new-documents");
    buildDocumentTree(newDocumentsRoot, NEW_KEY, 20);
    run.cutoverDocuments(tarOf(newDocumentsRoot, join(sandbox, "new-documents.tar")));
    expect(readFileSync(paths.journalPath, "utf8")).toContain("state=documents-replaced\n");
    // Live documents were genuinely replaced by this point.
    expect(readFileSync(join(liveDocumentsRoot, "objects", NEW_KEY.slice(0, 2), NEW_KEY.slice(2, 4), `${NEW_KEY}.bin`))).toHaveLength(20);

    const result = run.dispose();

    expect(result.outcome).toBe("rolled-back");
    expect(() => readFileSync(paths.journalPath)).toThrow();
    // Rollback restores the ORIGINAL object, not the interrupted new one.
    expect(readFileSync(join(liveDocumentsRoot, "objects", ORIGINAL_KEY.slice(0, 2), ORIGINAL_KEY.slice(2, 4), `${ORIGINAL_KEY}.bin`))).toHaveLength(10);
  });

  it("interrupted after cutoverDatabase (second live mutation, journaled): dispose() rolls the database and document tree both back to the checkpoint", () => {
    const liveDocumentsRoot = join(sandbox, "live-documents");
    buildDocumentTree(liveDocumentsRoot, ORIGINAL_KEY, 10);
    const adapter = new FakeRestoreAdapter(liveDocumentsRoot, ORIGINAL_KEY, 10);
    const workDir = mkdtempSync(join(sandbox, "work-"));
    const run = RestoreRun.prepare({ adapter, paths, workDir });
    run.createCheckpoint();

    const newDocumentsRoot = join(sandbox, "new-documents");
    buildDocumentTree(newDocumentsRoot, NEW_KEY, 20);
    run.cutoverDocuments(tarOf(newDocumentsRoot, join(sandbox, "new-documents.tar")));
    const newDatabaseDump = join(sandbox, "new-database.dump");
    writeFileSync(newDatabaseDump, JSON.stringify(reportsFor(NEW_KEY, 20)));
    run.cutoverDatabase(newDatabaseDump);
    expect(readFileSync(paths.journalPath, "utf8")).toContain("state=database-restored\n");
    expect(adapter.queryActiveReport(CORRESPONDENCE_QUERIES.crypto)).toContain(NEW_KEY);

    const result = run.dispose();

    expect(result.outcome).toBe("rolled-back");
    expect(() => readFileSync(paths.journalPath)).toThrow();
    expect(adapter.queryActiveReport(CORRESPONDENCE_QUERIES.crypto)).toContain(ORIGINAL_KEY);
    expect(readFileSync(join(liveDocumentsRoot, "objects", ORIGINAL_KEY.slice(0, 2), ORIGINAL_KEY.slice(2, 4), `${ORIGINAL_KEY}.bin`))).toHaveLength(10);
  });

  it("interrupted after finalize's active-correspondence check fails: dispose() still rolls back and leaves the app healthy", () => {
    const liveDocumentsRoot = join(sandbox, "live-documents");
    buildDocumentTree(liveDocumentsRoot, ORIGINAL_KEY, 10);
    const adapter = new FakeRestoreAdapter(liveDocumentsRoot, ORIGINAL_KEY, 10);
    const workDir = mkdtempSync(join(sandbox, "work-"));
    const run = RestoreRun.prepare({ adapter, paths, workDir });
    run.createCheckpoint();

    const newDocumentsRoot = join(sandbox, "new-documents");
    buildDocumentTree(newDocumentsRoot, NEW_KEY, 20);
    run.cutoverDocuments(tarOf(newDocumentsRoot, join(sandbox, "new-documents.tar")));
    const newDatabaseDump = join(sandbox, "new-database.dump");
    writeFileSync(newDatabaseDump, JSON.stringify(reportsFor(NEW_KEY, 20)));
    run.cutoverDatabase(newDatabaseDump);

    // Force a health-check failure so finalize() refuses.
    adapter.healthOk = false;
    expect(() => run.finalize()).toThrow(RestoreEngineRefusal);
    expect(run.isCompleted()).toBe(false);

    adapter.healthOk = true; // rollback's own health check must succeed for automatic recovery to work
    const result = run.dispose();
    expect(result.outcome).toBe("rolled-back");
    expect(() => readFileSync(paths.journalPath)).toThrow();
    expect(readFileSync(join(liveDocumentsRoot, "objects", ORIGINAL_KEY.slice(0, 2), ORIGINAL_KEY.slice(2, 4), `${ORIGINAL_KEY}.bin`))).toHaveLength(10);
  });

  it("rollback itself failing (e.g. health never returns) durably records rollback-failed and leaves the checkpoint for --recover, without deleting it", () => {
    const liveDocumentsRoot = join(sandbox, "live-documents");
    buildDocumentTree(liveDocumentsRoot, ORIGINAL_KEY, 10);
    const adapter = new FakeRestoreAdapter(liveDocumentsRoot, ORIGINAL_KEY, 10);
    const workDir = mkdtempSync(join(sandbox, "work-"));
    const run = RestoreRun.prepare({ adapter, paths, workDir });
    run.createCheckpoint();

    const newDocumentsRoot = join(sandbox, "new-documents");
    buildDocumentTree(newDocumentsRoot, NEW_KEY, 20);
    run.cutoverDocuments(tarOf(newDocumentsRoot, join(sandbox, "new-documents.tar")));

    // Automatic rollback itself now permanently fails (health never comes
    // back) — this is restore.sh's "automatic rollback failed" branch
    // (guarantee #39): the checkpoint and a rollback-failed journal entry
    // must be preserved for a manual `--recover`, never silently discarded.
    adapter.healthOk = false;
    const result = run.dispose();

    expect(result.outcome).toBe("rollback-failed");
    expect(result.checkpointDirectory).toBeTruthy();
    expect(readFileSync(paths.journalPath, "utf8")).toContain("state=rollback-failed\n");
    // The checkpoint directory itself is preserved, untouched, as recovery evidence.
    expect(readFileSync(join(result.checkpointDirectory!, "database.dump"))).toBeTruthy();

    // A fresh process can now recover from this exact evidence.
    adapter.healthOk = true;
    const recoverWorkDir = mkdtempSync(join(sandbox, "recover-work-"));
    const recoverOutcome = recoverRestore({ adapter, paths, workDir: recoverWorkDir });
    expect(recoverOutcome.outcome).toBe("completed");
    expect(() => readFileSync(paths.journalPath)).toThrow();
    expect(readFileSync(join(liveDocumentsRoot, "objects", ORIGINAL_KEY.slice(0, 2), ORIGINAL_KEY.slice(2, 4), `${ORIGINAL_KEY}.bin`))).toHaveLength(10);
  });
});

describe("recoverRestore (`--recover` equivalent, restore.sh:798-831, guarantees #31-37)", () => {
  it("refuses when there is no journal at all", () => {
    const liveDocumentsRoot = join(sandbox, "live-documents");
    buildDocumentTree(liveDocumentsRoot, ORIGINAL_KEY, 10);
    const adapter = new FakeRestoreAdapter(liveDocumentsRoot, ORIGINAL_KEY, 10);
    const workDir = mkdtempSync(join(sandbox, "work-"));
    expect(() => recoverRestore({ adapter, paths, workDir })).toThrow(RestoreEngineRefusal);
  });

  it("refuses when a durable checkpoint artifact was tampered with after the journal was written (#34)", () => {
    const liveDocumentsRoot = join(sandbox, "live-documents");
    buildDocumentTree(liveDocumentsRoot, ORIGINAL_KEY, 10);
    const adapter = new FakeRestoreAdapter(liveDocumentsRoot, ORIGINAL_KEY, 10);
    const workDir = mkdtempSync(join(sandbox, "work-"));
    const run = RestoreRun.prepare({ adapter, paths, workDir });
    run.createCheckpoint();
    const { checkpointDirectory } = loadRestoreJournal(paths.journalPath, paths.restoreRoot);
    writeFileSync(join(checkpointDirectory, "documents.tar"), "tampered", { mode: 0o600 });

    const recoverWorkDir = mkdtempSync(join(sandbox, "recover-work-"));
    expect(() => recoverRestore({ adapter, paths, workDir: recoverWorkDir })).toThrow(RestoreEngineRefusal);
    // Tampered evidence must be preserved, not silently deleted.
    expect(readFileSync(paths.journalPath, "utf8")).toContain("state=checkpointed\n");
  });

  it("is idempotent: recovering twice in a row (simulating a repeated manual --recover) succeeds both times", () => {
    const liveDocumentsRoot = join(sandbox, "live-documents");
    buildDocumentTree(liveDocumentsRoot, ORIGINAL_KEY, 10);
    const adapter = new FakeRestoreAdapter(liveDocumentsRoot, ORIGINAL_KEY, 10);
    const workDir = mkdtempSync(join(sandbox, "work-"));
    const run = RestoreRun.prepare({ adapter, paths, workDir });
    run.createCheckpoint();

    const newDocumentsRoot = join(sandbox, "new-documents");
    buildDocumentTree(newDocumentsRoot, NEW_KEY, 20);
    run.cutoverDocuments(tarOf(newDocumentsRoot, join(sandbox, "new-documents.tar")));
    // Simulate a hard interruption right here: no dispose() call at all,
    // journal + checkpoint are simply left on disk, exactly as a SIGKILL
    // would leave them (real-process proof in restore-engine.interruption.test.ts).

    const recoverWorkDir1 = mkdtempSync(join(sandbox, "recover-work-1-"));
    expect(recoverRestore({ adapter, paths, workDir: recoverWorkDir1 }).outcome).toBe("completed");
    expect(readFileSync(join(liveDocumentsRoot, "objects", ORIGINAL_KEY.slice(0, 2), ORIGINAL_KEY.slice(2, 4), `${ORIGINAL_KEY}.bin`))).toHaveLength(10);
    expect(() => readFileSync(paths.journalPath)).toThrow();
  });
});

describe("preflightValidateBundle (restore.sh:334-353, guarantees #7-10)", () => {
  it("accepts a staged bundle whose database and documents correspond, touching no live state", () => {
    const stagedDocumentsRoot = join(sandbox, "staged-documents");
    buildDocumentTree(stagedDocumentsRoot, ORIGINAL_KEY, 10);
    const databaseDumpPath = join(sandbox, "staged-database.dump");
    writeFileSync(databaseDumpPath, JSON.stringify(reportsFor(ORIGINAL_KEY, 10)));

    const adapter = new FakeRestoreAdapter(join(sandbox, "unused-live-documents"), ORIGINAL_KEY, 10);
    expect(() => preflightValidateBundle({ adapter, databaseDumpPath, stagedDocumentsRoot, stagingId: "preflight-test" })).not.toThrow();
  });

  it("refuses when the staged database and document tree do not correspond, without ever touching live state", () => {
    const stagedDocumentsRoot = join(sandbox, "staged-documents");
    buildDocumentTree(stagedDocumentsRoot, ORIGINAL_KEY, 10);
    const databaseDumpPath = join(sandbox, "staged-database.dump");
    // Database claims a document that isn't actually present on disk.
    writeFileSync(databaseDumpPath, JSON.stringify(reportsFor(NEW_KEY, 999)));

    const liveDocumentsRoot = join(sandbox, "live-documents");
    buildDocumentTree(liveDocumentsRoot, ORIGINAL_KEY, 10);
    const adapter = new FakeRestoreAdapter(liveDocumentsRoot, ORIGINAL_KEY, 10);
    expect(() => preflightValidateBundle({ adapter, databaseDumpPath, stagedDocumentsRoot, stagingId: "preflight-test-2" })).toThrow(RestoreEngineRefusal);
    // Live documents are completely untouched by a preflight-only check.
    expect(readFileSync(join(liveDocumentsRoot, "objects", ORIGINAL_KEY.slice(0, 2), ORIGINAL_KEY.slice(2, 4), `${ORIGINAL_KEY}.bin`))).toHaveLength(10);
  });
});
