/**
 * Characterization baseline for issue #299 (document worker module split).
 *
 * These tests pin the CURRENT behaviour of `src/server/document-worker.ts`
 * before it is split along its scan / publish / reconcile seams, so the split
 * has to keep them green without a single assertion changing. They are written
 * against the module's exported surface only — `runDocumentMaintenanceCycle`
 * and `reconcileDocumentStorage` — so they stay valid whichever file the
 * internals end up in.
 *
 * What they pin, in ADR-0010 terms (docs/adr/0010-outage-recoverable-document-
 * scanning.md):
 *
 *  - the fixed order of one maintenance cycle;
 *  - the lease and fencing shape of both claim statements (ten-minute lease,
 *    fresh lease token, attempt increment, `for update ... skip locked`,
 *    expired-lease reclaim only, five automatic scan attempts);
 *  - the fail-closed scanning order: every non-clean scanner outcome, every
 *    staging failure and every lost lease ends without an `available`
 *    document, and the publish transaction only ever runs after a clean scan;
 *  - the purge job's irreversible ordering: ciphertext is removed before the
 *    metadata is finalized.
 *
 * Shape copied from src/server/document-content-boundary.test.ts, which
 * already fakes `@/db`, `@/server/documents/config`, `@/server/documents/
 * crypto` and `@/server/documents/storage` the same way; the naming follows
 * src/server/imap-characterization.test.ts, the equivalent baseline written
 * for the #298 mail-in split.
 *
 * The fake database records the order of every statement and never evaluates
 * a `where` clause, so a row set is only ever a "present" or "absent" signal.
 * The real fencing predicates are asserted separately, as SQL text, and
 * behaviourally by making an ownership check come back empty.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const DOCUMENT = "11111111-1111-4111-8111-111111111111";
const HOUSEHOLD = "33333333-3333-4333-8333-333333333333";
const ITEM = "22222222-2222-4222-8222-222222222222";
const JOB = "44444444-4444-4444-8444-444444444444";
const LEASE = "55555555-5555-4555-8555-555555555555";
const STAGING_KEY = "a".repeat(64);
const FINAL_KEY = "b".repeat(64);

const mocks = vi.hoisted(() => ({
  steps: [] as string[],
  executed: [] as string[],
  writes: [] as Array<{ operation: string; table: string; values?: Record<string, unknown> }>,
  /** Row sets returned by `execute`, keyed by the classifier below. */
  executeRows: {} as Record<string, unknown[]>,
  /** Row sets returned by the drizzle `select` builder. */
  selectRows: (() => []) as (context: { table: string; fields: string[] }) => unknown[],
  /** Row sets returned by `.returning()`. */
  returningRows: (() => [{ id: "row" }]) as (context: { table: string; values?: Record<string, unknown> }) => unknown[],
  config: vi.fn(),
  decryptDocument: vi.fn(),
  encryptDocument: vi.fn(),
  scanFile: vi.fn(),
  readStagingCiphertext: vi.fn(),
  writeQuarantineBytes: vi.fn(),
  discardQuarantine: vi.fn(),
  createStorageKey: vi.fn(),
  writeCiphertext: vi.fn(),
  deleteCiphertext: vi.fn(),
  deleteStagingCiphertext: vi.fn(),
  ciphertextExists: vi.fn(),
  listCiphertextObjects: vi.fn(),
  listStagingObjects: vi.fn(),
  listQuarantineFiles: vi.fn(),
  purgeExpiredPortableArchives: vi.fn(),
  reconcilePortableArchiveStorage: vi.fn(),
  purgeExpiredHouseholds: vi.fn(),
}));

/** Reconstructs the static text of a drizzle `sql` template; parameters become `?`. */
function sqlText(query: unknown): string {
  const chunks = (query as { queryChunks?: unknown[] }).queryChunks ?? [];
  return chunks
    .map((chunk) => {
      const value = (chunk as { value?: unknown }).value;
      return Array.isArray(value) && value.every((entry) => typeof entry === "string") ? value.join("") : " ? ";
    })
    .join("");
}

/** Names the call site of a raw statement from its text, so traces stay readable. */
function classifyExecute(text: string): string {
  if (/pg_advisory_xact_lock/u.test(text)) return "advisoryLock";
  if (/skip locked/u.test(text)) return /kind = 'scan'/u.test(text) ? "claimScanJobs" : "claimPurgeJobs";
  if (/recovery_expires_at as "recoveryExpiresAt"/u.test(text)) return "readOwnedScanRecord";
  if (/crypto\.storage_key as "storageKey"/u.test(text)) return "readOwnedPurgeRecord";
  if (/select lifecycle, version as generation/u.test(text)) return "readPurgeDocumentState";
  if (/select lifecycle\s+from documents/u.test(text)) return "readCurrentLifecycle";
  if (/select id\s+from document_jobs/u.test(text)) {
    if (/kind = 'scan'/u.test(text)) return "fenceScanJob";
    if (/kind = 'purge'/u.test(text)) return "fenceStalePurgeClaim";
    return "fencePurgeJob";
  }
  return "other";
}

vi.mock("@/db", async () => {
  const { getTableName } = await import("drizzle-orm");
  const step = (name: string) => mocks.steps.push(name);

  function fields(selection: unknown): string[] {
    return selection && typeof selection === "object" ? Object.keys(selection as object) : [];
  }

  function makeSelectBuilder(selection: unknown) {
    let table = "";
    const builder: PromiseLike<unknown[]> & Record<string, unknown> = {
      from(source: unknown) {
        table = getTableName(source as never);
        step(`select:${table}`);
        return builder;
      },
      innerJoin: () => builder,
      leftJoin: () => builder,
      where: () => builder,
      orderBy: () => builder,
      for: () => builder,
      limit: () => builder,
      then: (onFulfilled: (value: unknown[]) => unknown, onRejected?: (reason: unknown) => unknown) =>
        Promise.resolve(mocks.selectRows({ table, fields: fields(selection) })).then(onFulfilled, onRejected),
    } as never;
    return builder;
  }

  function makeUpdateBuilder(source: unknown) {
    const table = getTableName(source as never);
    let values: Record<string, unknown> | undefined;
    let recorded = false;
    const record = () => {
      if (recorded) return;
      recorded = true;
      step(`update:${table}`);
      mocks.writes.push({ operation: "update", table, values });
    };
    const builder: PromiseLike<unknown> & Record<string, unknown> = {
      set(next: Record<string, unknown>) {
        values = next;
        return builder;
      },
      where: () => builder,
      returning: () => {
        record();
        return Promise.resolve(mocks.returningRows({ table, values }));
      },
      then: (onFulfilled: (value: unknown) => unknown, onRejected?: (reason: unknown) => unknown) => {
        record();
        return Promise.resolve(undefined).then(onFulfilled, onRejected);
      },
    } as never;
    return builder;
  }

  function makeDeleteBuilder(source: unknown) {
    const table = getTableName(source as never);
    let recorded = false;
    const record = () => {
      if (recorded) return;
      recorded = true;
      step(`delete:${table}`);
      mocks.writes.push({ operation: "delete", table });
    };
    const builder: PromiseLike<unknown> & Record<string, unknown> = {
      where: () => builder,
      returning: () => {
        record();
        return Promise.resolve(mocks.returningRows({ table }));
      },
      then: (onFulfilled: (value: unknown) => unknown, onRejected?: (reason: unknown) => unknown) => {
        record();
        return Promise.resolve(undefined).then(onFulfilled, onRejected);
      },
    } as never;
    return builder;
  }

  function makeInsertBuilder(source: unknown) {
    const table = getTableName(source as never);
    return {
      values(next: Record<string, unknown>) {
        step(`insert:${table}`);
        mocks.writes.push({ operation: "insert", table, values: next });
        const inserted: PromiseLike<unknown> & Record<string, unknown> = {
          onConflictDoUpdate: () => Promise.resolve(undefined),
          then: (onFulfilled: (value: unknown) => unknown, onRejected?: (reason: unknown) => unknown) =>
            Promise.resolve(undefined).then(onFulfilled, onRejected),
        } as never;
        return inserted;
      },
    };
  }

  const fakeDb: Record<string, unknown> = {
    select: (selection: unknown) => makeSelectBuilder(selection),
    update: (source: unknown) => makeUpdateBuilder(source),
    delete: (source: unknown) => makeDeleteBuilder(source),
    insert: (source: unknown) => makeInsertBuilder(source),
    execute: (query: unknown) => {
      const text = sqlText(query);
      const label = classifyExecute(text);
      mocks.executed.push(text);
      step(`execute:${label}`);
      return Promise.resolve(mocks.executeRows[label] ?? []);
    },
    transaction: async (work: (transaction: unknown) => unknown) => {
      step("tx:begin");
      const outcome = await work(fakeDb);
      step("tx:commit");
      return outcome;
    },
  };

  return { getDb: () => fakeDb };
});

vi.mock("@/lib/logger", async () => ({
  ...await vi.importActual<typeof import("@/lib/logger")>("@/lib/logger"),
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("@/server/documents/config", () => ({ getDocumentConfig: mocks.config }));

vi.mock("@/server/documents/crypto", () => ({
  decryptDocument: mocks.decryptDocument,
  encryptDocument: mocks.encryptDocument,
}));

vi.mock("@/server/documents/scanner", () => ({ scanFileWithClamAv: mocks.scanFile }));

vi.mock("@/server/documents/storage", () => ({
  LocalDocumentStorage: class {
    readStagingCiphertext = mocks.readStagingCiphertext;
    writeQuarantineBytes = mocks.writeQuarantineBytes;
    discardQuarantine = mocks.discardQuarantine;
    createStorageKey = mocks.createStorageKey;
    writeCiphertext = mocks.writeCiphertext;
    deleteCiphertext = mocks.deleteCiphertext;
    deleteStagingCiphertext = mocks.deleteStagingCiphertext;
    ciphertextExists = mocks.ciphertextExists;
    listCiphertextObjects = mocks.listCiphertextObjects;
    listStagingObjects = mocks.listStagingObjects;
    listQuarantineFiles = mocks.listQuarantineFiles;
  },
}));

vi.mock("@/server/portable-archive-repository", () => ({
  purgeExpiredPortableArchives: mocks.purgeExpiredPortableArchives,
  reconcilePortableArchiveStorage: mocks.reconcilePortableArchiveStorage,
}));

vi.mock("@/server/household-lifecycle", () => ({ purgeExpiredHouseholds: mocks.purgeExpiredHouseholds }));

import { reconcileDocumentStorage, runDocumentMaintenanceCycle } from "./document-worker";

const documentConfig = {
  storageRoot: "/private/documents",
  quarantineRoot: "/private/quarantine",
  maxBytes: 25 * 1_048_576,
  householdQuotaBytes: 1_000_000,
  instanceQuotaBytes: 1_000_000,
  retentionDays: 30,
  scanRecoveryRetentionHours: 24,
  scanMode: "required" as const,
  clamAv: { host: "clamav", port: 3310, timeoutMs: 30_000 },
  tika: { url: null, timeoutMs: 45_000 },
  keyEncryptionKey: Buffer.alloc(32, 1),
  keyId: "test-key-id",
};

/** The mutable world the default row responders read; each test tweaks a field. */
const world = {
  stageExpiresAt: new Date(Date.now() + 3_600_000) as Date | string,
  jobAttempts: 1,
  reconcileRecords: [] as unknown[],
  pendingStageRows: [] as unknown[],
  pendingOperations: [] as unknown[],
};

function claimedScanJob() {
  return { id: JOB, documentId: DOCUMENT, generation: 3, leaseToken: LEASE, previousStatus: "pending" };
}

function scanRecoveryRecord() {
  return {
    householdId: HOUSEHOLD,
    itemId: ITEM,
    mediaType: "application/pdf",
    sizeBytes: 8,
    displayName: "policy.pdf",
    contentSha256: "c".repeat(64),
    stagingStorageKey: STAGING_KEY,
    ciphertextSize: 64,
    envelopeVersion: 1,
    contentIv: "iv",
    contentAuthTag: "tag",
    wrappedDek: "dek",
    wrapIv: "wrap-iv",
    wrapAuthTag: "wrap-tag",
    keyId: "test-key-id",
    recoveryExpiresAt: world.stageExpiresAt,
  };
}

/** Arms a cycle that claims exactly one scan job with a live lease and a live stage. */
function armScanJob(): void {
  mocks.executeRows.claimScanJobs = [claimedScanJob()];
  mocks.executeRows.readOwnedScanRecord = [scanRecoveryRecord()];
  mocks.executeRows.fenceScanJob = [{ id: JOB }];
  // Skip the reconciliation phase so the trace holds only the scan path.
  (globalThis as Record<string, unknown>).__orbitDocumentWorkerLastReconciliationAt = new Date().toISOString();
}

/** The trace from just after the named step, so a scan assertion ignores the sweep phases. */
function traceAfter(step: string): string[] {
  const index = mocks.steps.indexOf(step);
  expect(index, `expected the trace to contain ${step}`).toBeGreaterThanOrEqual(0);
  return mocks.steps.slice(index + 1);
}

function documentWrites(): Array<Record<string, unknown> | undefined> {
  return mocks.writes.filter((write) => write.table === "documents" && write.operation === "update").map((write) => write.values);
}

/**
 * The document writes a job made, without the two unconditional sweeps every
 * cycle opens with (`rejectInterruptedDocuments`, and the stranded-scanning
 * sweep inside reconciliation). Both are pinned separately below; leaving them
 * in every expectation would only obscure what the job itself did.
 */
function documentTransitions(): Array<Record<string, unknown> | undefined> {
  return documentWrites().filter((values) => values?.failureCode !== "processing_interrupted");
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.steps.length = 0;
  mocks.executed.length = 0;
  mocks.writes.length = 0;
  mocks.executeRows = {};
  world.stageExpiresAt = new Date(Date.now() + 3_600_000);
  world.jobAttempts = 1;
  world.reconcileRecords = [];
  world.pendingStageRows = [];
  world.pendingOperations = [];

  mocks.selectRows = ({ table, fields }) => {
    if (table === "document_staging_objects") {
      if (fields.includes("recoveryExpiresAt") && fields.includes("status")) {
        return [{ status: "pending", recoveryExpiresAt: world.stageExpiresAt }];
      }
      if (fields.includes("documentId")) return world.pendingStageRows;
      if (fields.includes("recoveryExpiresAt")) return [{ recoveryExpiresAt: world.stageExpiresAt }];
      if (fields.includes("status")) return [{ status: "purge_pending" }];
      return [];
    }
    if (table === "documents") {
      if (fields.includes("documentId")) return world.reconcileRecords;
      return [{ householdId: HOUSEHOLD, itemId: ITEM }];
    }
    if (table === "document_jobs") {
      if (fields.includes("attempts")) return [{ attempts: world.jobAttempts }];
      return [{ id: JOB }];
    }
    if (table === "reviewed_intake_operations") return world.pendingOperations;
    return [];
  };
  mocks.returningRows = () => [{ id: "row" }];

  mocks.config.mockReturnValue(documentConfig);
  mocks.decryptDocument.mockImplementation(() => {
    mocks.steps.push("crypto.decrypt");
    return Buffer.alloc(8, 7);
  });
  mocks.encryptDocument.mockImplementation(() => {
    mocks.steps.push("crypto.encrypt");
    return { ciphertext: Buffer.alloc(64, 9), envelope: { envelopeVersion: 1, algorithm: "aes-256-gcm", keyId: "test-key-id" } };
  });
  mocks.scanFile.mockImplementation(async () => {
    mocks.steps.push("scanner.scan");
    return { status: "clean" };
  });
  mocks.readStagingCiphertext.mockImplementation(async () => {
    mocks.steps.push("storage.readStagingCiphertext");
    return Buffer.alloc(64, 3);
  });
  mocks.writeQuarantineBytes.mockImplementation(async () => {
    mocks.steps.push("storage.writeQuarantineBytes");
    return "/private/quarantine/scan";
  });
  mocks.discardQuarantine.mockImplementation(async () => {
    mocks.steps.push("storage.discardQuarantine");
  });
  mocks.createStorageKey.mockReturnValue(FINAL_KEY);
  mocks.writeCiphertext.mockImplementation(async () => {
    mocks.steps.push("storage.writeCiphertext");
  });
  mocks.deleteCiphertext.mockImplementation(async () => {
    mocks.steps.push("storage.deleteCiphertext");
  });
  mocks.deleteStagingCiphertext.mockImplementation(async () => {
    mocks.steps.push("storage.deleteStagingCiphertext");
  });
  mocks.ciphertextExists.mockResolvedValue(true);
  mocks.listCiphertextObjects.mockImplementation(async () => {
    mocks.steps.push("storage.listCiphertextObjects");
    return [];
  });
  mocks.listStagingObjects.mockImplementation(async () => {
    mocks.steps.push("storage.listStagingObjects");
    return [];
  });
  mocks.listQuarantineFiles.mockImplementation(async () => {
    mocks.steps.push("storage.listQuarantineFiles");
    return [];
  });
  mocks.purgeExpiredPortableArchives.mockImplementation(async () => {
    mocks.steps.push("portableArchives.purgeExpired");
  });
  mocks.reconcilePortableArchiveStorage.mockImplementation(async () => {
    mocks.steps.push("portableArchives.reconcile");
  });
  mocks.purgeExpiredHouseholds.mockImplementation(async () => {
    mocks.steps.push("households.purgeExpired");
  });

  delete (globalThis as Record<string, unknown>).__orbitDocumentWorkerLastReconciliationAt;
});

// ---------------------------------------------------------------------------
// 1. The maintenance cycle's fixed order
// ---------------------------------------------------------------------------

describe("runDocumentMaintenanceCycle — phase order", () => {
  it("runs the sweeps, then reconciliation, then claims scan jobs before purge jobs", async () => {
    await runDocumentMaintenanceCycle();

    expect(mocks.steps).toEqual([
      // 1. Strand the documents interrupted mid-upload.
      "update:documents",
      // 2. Expire recovery stages past their retention window.
      "tx:begin",
      "select:document_staging_objects",
      "tx:commit",
      // 3. Retry the deletion of already-terminal staged bytes.
      "select:document_staging_objects",
      // 4/5. The other retention sweeps.
      "portableArchives.purgeExpired",
      "households.purgeExpired",
      // 6. Storage reconciliation, due because it has never run.
      "update:documents",
      "select:documents",
      "storage.listCiphertextObjects",
      "select:document_staging_objects",
      "storage.listStagingObjects",
      "storage.listQuarantineFiles",
      "portableArchives.reconcile",
      // 7. Scan recovery is claimed before purge, in one pass each.
      "execute:claimScanJobs",
      "execute:claimPurgeJobs",
    ]);
  });

  it("skips reconciliation inside its fifteen-minute interval and runs it once the interval passes", async () => {
    (globalThis as Record<string, unknown>).__orbitDocumentWorkerLastReconciliationAt =
      new Date(Date.now() - 14 * 60_000).toISOString();
    await runDocumentMaintenanceCycle();
    expect(mocks.steps).not.toContain("portableArchives.reconcile");
    expect(mocks.steps).not.toContain("storage.listQuarantineFiles");

    mocks.steps.length = 0;
    (globalThis as Record<string, unknown>).__orbitDocumentWorkerLastReconciliationAt =
      new Date(Date.now() - 16 * 60_000).toISOString();
    await runDocumentMaintenanceCycle();
    expect(mocks.steps).toContain("portableArchives.reconcile");
    expect(mocks.steps).toContain("storage.listQuarantineFiles");
  });
});

// ---------------------------------------------------------------------------
// 2. Lease and fencing shape of the two claim statements (ADR-0010)
// ---------------------------------------------------------------------------

describe("claim statements — lease, fencing and eligibility", () => {
  async function claimStatements() {
    await runDocumentMaintenanceCycle();
    const scan = mocks.executed.find((text) => classifyExecute(text) === "claimScanJobs");
    const purge = mocks.executed.find((text) => classifyExecute(text) === "claimPurgeJobs");
    expect(scan).toBeDefined();
    expect(purge).toBeDefined();
    return { scan: scan!, purge: purge! };
  }

  it("takes a ten-minute lease with a fresh token and one more attempt, for both kinds", async () => {
    const { scan, purge } = await claimStatements();
    for (const statement of [scan, purge]) {
      expect(statement).toContain("status = 'processing'");
      expect(statement).toContain("attempts = job.attempts + 1");
      expect(statement).toContain("lease_expires_at = now() + interval '10 minutes'");
      expect(statement).toContain("lease_token = gen_random_uuid()");
      expect(statement).toContain("returning job.id, job.document_id, job.generation, job.lease_token");
    }
  });

  it("selects candidates with row locks that skip a row another worker already holds", async () => {
    const { scan, purge } = await claimStatements();
    for (const statement of [scan, purge]) {
      expect(statement).toContain("for update of job skip locked");
      expect(statement).toContain("with claimable as materialized");
    }
  });

  it("reclaims a processing job only once its lease has expired, never a live one", async () => {
    const { scan, purge } = await claimStatements();
    for (const statement of [scan, purge]) {
      expect(statement).toContain("job.status in ('pending', 'retry')");
      expect(statement).toContain("or (job.status = 'processing' and job.lease_expires_at < now())");
      expect(statement).toContain("and (job.lease_expires_at is null or job.lease_expires_at < now())");
    }
  });

  it("gates a scan claim on a live stage, a due attempt and the automatic attempt ceiling", async () => {
    const { scan } = await claimStatements();
    expect(scan).toContain("document.lifecycle = 'scanning'");
    expect(scan).toContain("stage.status = 'pending'");
    expect(scan).toContain("stage.recovery_expires_at > now()");
    expect(scan).toContain("job.next_attempt_at <= now()");
    expect(scan).toContain("job.attempts <  ? ");
    expect(scan).toContain("order by job.next_attempt_at, job.created_at");
  });

  it("gates a purge claim on an elapsed retention deadline", async () => {
    const { purge } = await claimStatements();
    expect(purge).toContain("document.lifecycle = 'pending_deletion'");
    expect(purge).toContain("document.delete_after <= now()");
    expect(purge).toContain("order by document.delete_after");
  });

  it("re-reads the claimed scan record under the same generation and lease token", async () => {
    armScanJob();
    await runDocumentMaintenanceCycle();
    const read = mocks.executed.find((text) => classifyExecute(text) === "readOwnedScanRecord");
    expect(read).toBeDefined();
    expect(read!).toContain("document.lifecycle = 'scanning'");
    expect(read!).toContain("stage.status = 'pending'");
    expect(read!).toContain("job.status = 'processing'");
    expect(read!).toContain("job.generation =  ? ");
    expect(read!).toContain("job.lease_token =  ? ::uuid");
  });
});

// ---------------------------------------------------------------------------
// 3. The clean path: scan strictly before publish
// ---------------------------------------------------------------------------

describe("scanner recovery — the clean path publishes only after a clean scan", () => {
  it("decrypts, quarantines, scans, discards the plaintext, then encrypts and publishes", async () => {
    armScanJob();

    await runDocumentMaintenanceCycle();

    expect(traceAfter("execute:claimScanJobs")).toEqual([
      "execute:readOwnedScanRecord",
      "storage.readStagingCiphertext",
      "crypto.decrypt",
      "storage.writeQuarantineBytes",
      "scanner.scan",
      // The plaintext leaves the disk before anything else happens.
      "storage.discardQuarantine",
      "crypto.encrypt",
      "storage.writeCiphertext",
      // The publish transaction: fenced, then the document becomes available.
      "tx:begin",
      "execute:advisoryLock",
      "execute:fenceScanJob",
      "select:document_staging_objects",
      "update:documents",
      "insert:document_crypto",
      "update:document_staging_objects",
      "update:document_jobs",
      "select:reviewed_intake_operations",
      "insert:audit_log",
      "tx:commit",
      // Only after the handoff is durable are the staged bytes removed.
      "storage.deleteStagingCiphertext",
      "tx:begin",
      "execute:advisoryLock",
      "select:document_staging_objects",
      "delete:document_staging_objects",
      "update:document_jobs",
      "tx:commit",
      "execute:claimPurgeJobs",
    ]);

    expect(documentTransitions()).toEqual([
      expect.objectContaining({ lifecycle: "available", scanStatus: "clean", failureCode: null }),
    ]);
    expect(mocks.writeCiphertext).toHaveBeenCalledWith(FINAL_KEY, expect.any(Buffer));
    expect(mocks.deleteCiphertext).not.toHaveBeenCalled();
  });

  it("hands the scanner the quarantine path, not the staging key", async () => {
    armScanJob();
    await runDocumentMaintenanceCycle();
    expect(mocks.scanFile).toHaveBeenCalledWith("/private/quarantine/scan", documentConfig.clamAv);
  });

  it("binds the staged decryption to the scanner_recovery purpose and the final encryption to none", async () => {
    armScanJob();
    await runDocumentMaintenanceCycle();
    expect(mocks.decryptDocument.mock.calls[0]?.[1]).toMatchObject({
      documentId: DOCUMENT,
      householdId: HOUSEHOLD,
      itemId: ITEM,
      purpose: "scanner_recovery",
    });
    expect(mocks.encryptDocument.mock.calls[0]?.[1]).toEqual({
      documentId: DOCUMENT,
      householdId: HOUSEHOLD,
      itemId: ITEM,
      mediaType: "application/pdf",
      plaintextSize: 8,
    });
  });
});

// ---------------------------------------------------------------------------
// 4. Fail-closed: no scan failure may reach publish
// ---------------------------------------------------------------------------

describe("scanner recovery — fail-closed scanning order", () => {
  /** Nothing may be encrypted, written or made available. */
  function expectNoPublish(): void {
    expect(mocks.encryptDocument).not.toHaveBeenCalled();
    expect(mocks.writeCiphertext).not.toHaveBeenCalled();
    expect(mocks.steps).not.toContain("insert:document_crypto");
    for (const values of documentTransitions()) {
      expect(values?.lifecycle).not.toBe("available");
      expect(values?.scanStatus).not.toBe("clean");
    }
  }

  it("retries a retryable scanner outage without touching the document row", async () => {
    armScanJob();
    mocks.scanFile.mockImplementation(async () => {
      mocks.steps.push("scanner.scan");
      return { status: "error", reason: "unavailable" };
    });

    await runDocumentMaintenanceCycle();

    expect(traceAfter("scanner.scan")).toEqual([
      "storage.discardQuarantine",
      "select:document_jobs",
      "update:document_jobs",
      "execute:claimPurgeJobs",
    ]);
    expect(documentTransitions()).toEqual([]);
    expectNoPublish();
    const jobWrite = mocks.writes.find((write) => write.table === "document_jobs" && write.operation === "update");
    expect(jobWrite?.values).toMatchObject({ status: "retry", lastError: "scanner_unavailable", leaseToken: null });
  });

  it("fails the job terminally once the automatic attempt ceiling is reached", async () => {
    armScanJob();
    world.jobAttempts = 5;
    mocks.scanFile.mockImplementation(async () => {
      mocks.steps.push("scanner.scan");
      return { status: "error", reason: "timeout" };
    });

    await runDocumentMaintenanceCycle();

    const jobWrite = mocks.writes.find((write) => write.table === "document_jobs" && write.operation === "update");
    expect(jobWrite?.values).toMatchObject({ status: "failed", lastError: "scanner_timeout" });
    expectNoPublish();
  });

  it("rejects malware terminally and purges the stage instead of publishing", async () => {
    armScanJob();
    mocks.scanFile.mockImplementation(async () => {
      mocks.steps.push("scanner.scan");
      return { status: "infected", signature: "Eicar-Test-Signature" };
    });

    await runDocumentMaintenanceCycle();

    expect(traceAfter("scanner.scan")).toEqual([
      "storage.discardQuarantine",
      "tx:begin",
      "execute:advisoryLock",
      "execute:fenceScanJob",
      "select:documents",
      "select:document_staging_objects",
      "update:document_staging_objects",
      "update:documents",
      "update:reviewed_intake_operations",
      "insert:audit_log",
      "tx:commit",
      "storage.deleteStagingCiphertext",
      "tx:begin",
      "execute:advisoryLock",
      "select:document_staging_objects",
      // The stage deletion is still fenced by the job's lease here, unlike the
      // clean path's, which runs after the job row is already completed.
      "execute:fenceScanJob",
      "delete:document_staging_objects",
      "update:document_jobs",
      "tx:commit",
      "execute:claimPurgeJobs",
    ]);
    expect(documentTransitions()).toEqual([
      expect.objectContaining({ lifecycle: "rejected", scanStatus: "infected", failureCode: "malware_detected" }),
    ]);
    expectNoPublish();
  });

  it("treats a non-retryable scanner error as terminal scanner_failed, not as a retry", async () => {
    armScanJob();
    mocks.scanFile.mockImplementation(async () => {
      mocks.steps.push("scanner.scan");
      return { status: "error", reason: "scanner" };
    });

    await runDocumentMaintenanceCycle();

    expect(documentTransitions()).toEqual([
      expect.objectContaining({ lifecycle: "rejected", scanStatus: "error", failureCode: "scanner_failed" }),
    ]);
    expectNoPublish();
  });

  it("never reaches the scanner when the staged ciphertext cannot be read", async () => {
    armScanJob();
    mocks.readStagingCiphertext.mockRejectedValue(new Error("ENOENT: no such file or directory"));

    await runDocumentMaintenanceCycle();

    expect(mocks.scanFile).not.toHaveBeenCalled();
    expect(documentTransitions()).toEqual([
      expect.objectContaining({ lifecycle: "rejected", scanStatus: "error", failureCode: "staging_object_invalid" }),
    ]);
    expectNoPublish();
  });

  it("never reaches the scanner when the staged envelope fails authentication", async () => {
    armScanJob();
    mocks.decryptDocument.mockImplementation(() => {
      throw new Error("Document authentication failed");
    });

    await runDocumentMaintenanceCycle();

    expect(mocks.scanFile).not.toHaveBeenCalled();
    expect(mocks.writeQuarantineBytes).not.toHaveBeenCalled();
    expect(documentTransitions()).toEqual([
      expect.objectContaining({ lifecycle: "rejected", failureCode: "staging_object_invalid" }),
    ]);
    expectNoPublish();
  });

  it("never reaches the scanner once the recovery window has expired", async () => {
    world.stageExpiresAt = new Date(Date.now() - 1_000);
    armScanJob();

    await runDocumentMaintenanceCycle();

    expect(mocks.readStagingCiphertext).not.toHaveBeenCalled();
    expect(mocks.scanFile).not.toHaveBeenCalled();
    expect(documentTransitions()).toEqual([
      expect.objectContaining({ lifecycle: "rejected", scanStatus: "error", failureCode: "scan_recovery_expired" }),
    ]);
    expectNoPublish();
  });

  it("rejects an unparseable recovery expiry as invalid staging data", async () => {
    world.stageExpiresAt = "not-a-timestamp";
    armScanJob();

    await runDocumentMaintenanceCycle();

    expect(mocks.scanFile).not.toHaveBeenCalled();
    expect(documentTransitions()).toEqual([
      expect.objectContaining({ failureCode: "staging_object_invalid" }),
    ]);
    expectNoPublish();
  });

  it("cancels the job without scanning when the fenced re-read finds no owned record", async () => {
    armScanJob();
    mocks.executeRows.readOwnedScanRecord = [];

    await runDocumentMaintenanceCycle();

    expect(traceAfter("execute:claimScanJobs")).toEqual([
      "execute:readOwnedScanRecord",
      "update:document_jobs",
      "execute:claimPurgeJobs",
    ]);
    const jobWrite = mocks.writes.find((write) => write.table === "document_jobs" && write.operation === "update");
    expect(jobWrite?.values).toMatchObject({ status: "cancelled", lastError: "staging_object_missing" });
    expectNoPublish();
  });

  it("turns an unexpected failure inside the job into a scanner_failed retry, not a lost job", async () => {
    armScanJob();
    mocks.writeQuarantineBytes.mockImplementation(async () => {
      throw new Error("unexpected");
    });

    await runDocumentMaintenanceCycle();

    const jobWrite = mocks.writes.find((write) => write.table === "document_jobs" && write.operation === "update");
    expect(jobWrite?.values).toMatchObject({ status: "retry", lastError: "scanner_failed" });
    expectNoPublish();
  });
});

// ---------------------------------------------------------------------------
// 5. Fencing: a lost lease abandons the publish
// ---------------------------------------------------------------------------

describe("scanner recovery — a lost lease abandons the publish", () => {
  it("discards the freshly written ciphertext and leaves the document unpublished", async () => {
    armScanJob();
    // The publish transaction's ownership re-check comes back empty: another
    // worker reclaimed the expired lease while this scan was running.
    mocks.executeRows.fenceScanJob = [];

    await runDocumentMaintenanceCycle();

    expect(mocks.writeCiphertext).toHaveBeenCalledWith(FINAL_KEY, expect.any(Buffer));
    expect(traceAfter("storage.writeCiphertext")).toEqual([
      "tx:begin",
      "execute:advisoryLock",
      "execute:fenceScanJob",
      "tx:commit",
      "storage.deleteCiphertext",
      "execute:claimPurgeJobs",
    ]);
    expect(mocks.deleteCiphertext).toHaveBeenCalledWith(FINAL_KEY);
    expect(documentTransitions()).toEqual([]);
    expect(mocks.steps).not.toContain("insert:document_crypto");
    expect(mocks.deleteStagingCiphertext).not.toHaveBeenCalled();
  });

  it("abandons a terminal rejection too when the lease is lost before the stage transition", async () => {
    armScanJob();
    mocks.executeRows.fenceScanJob = [];
    mocks.scanFile.mockImplementation(async () => {
      mocks.steps.push("scanner.scan");
      return { status: "infected", signature: "Eicar-Test-Signature" };
    });

    await runDocumentMaintenanceCycle();

    expect(documentTransitions()).toEqual([]);
    expect(mocks.deleteStagingCiphertext).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 6. Purge jobs: ciphertext first, metadata second
// ---------------------------------------------------------------------------

describe("purge jobs — irreversible ordering", () => {
  function armPurgeJob(): void {
    mocks.executeRows.claimPurgeJobs = [{ id: JOB, documentId: DOCUMENT, generation: 4, leaseToken: LEASE, previousStatus: "pending" }];
    mocks.executeRows.fencePurgeJob = [{ id: JOB }];
    mocks.executeRows.readOwnedPurgeRecord = [{
      householdId: HOUSEHOLD,
      itemId: ITEM,
      lifecycle: "pending_deletion",
      generation: 4,
      storageKey: FINAL_KEY,
    }];
    (globalThis as Record<string, unknown>).__orbitDocumentWorkerLastReconciliationAt = new Date().toISOString();
  }

  it("removes the ciphertext before the finalizing transaction, never after", async () => {
    armPurgeJob();

    await runDocumentMaintenanceCycle();

    expect(traceAfter("execute:claimPurgeJobs")).toEqual([
      // Ownership is re-read under the lease.
      "tx:begin",
      "execute:advisoryLock",
      "execute:fencePurgeJob",
      "execute:readOwnedPurgeRecord",
      "tx:commit",
      // The bytes go first: a terminal row must never point at ciphertext.
      "storage.deleteCiphertext",
      // Only then is the metadata finalized, under the same lease.
      "tx:begin",
      "execute:advisoryLock",
      "execute:fencePurgeJob",
      "execute:readOwnedPurgeRecord",
      "update:documents",
      "delete:document_crypto",
      "delete:document_drafts",
      "update:document_jobs",
      "insert:audit_log",
      "tx:commit",
    ]);
    expect(documentTransitions()).toEqual([
      expect.objectContaining({ lifecycle: "deleted" }),
    ]);
  });

  it("leaves the ciphertext alone and closes the claim when the lease is already gone", async () => {
    armPurgeJob();
    mocks.executeRows.fencePurgeJob = [];
    mocks.executeRows.fenceStalePurgeClaim = [{ id: JOB }];
    mocks.executeRows.readPurgeDocumentState = [{ lifecycle: "deleted", generation: 5 }];

    await runDocumentMaintenanceCycle();

    expect(mocks.deleteCiphertext).not.toHaveBeenCalled();
    expect(documentTransitions()).toEqual([]);
    const jobWrite = mocks.writes.find((write) => write.table === "document_jobs" && write.operation === "update");
    expect(jobWrite?.values).toMatchObject({ status: "completed", leaseToken: null });
  });

  it("refuses to purge a document whose generation has moved on", async () => {
    armPurgeJob();
    mocks.executeRows.readOwnedPurgeRecord = [{
      householdId: HOUSEHOLD,
      itemId: ITEM,
      lifecycle: "pending_deletion",
      generation: 9,
      storageKey: FINAL_KEY,
    }];
    mocks.executeRows.readPurgeDocumentState = [{ lifecycle: "available", generation: 9 }];

    await runDocumentMaintenanceCycle();

    expect(mocks.deleteCiphertext).not.toHaveBeenCalled();
    expect(documentTransitions()).toEqual([]);
  });

  it("retries a purge whose storage metadata is unusable instead of deleting anything", async () => {
    armPurgeJob();
    mocks.executeRows.readOwnedPurgeRecord = [{
      householdId: HOUSEHOLD,
      itemId: ITEM,
      lifecycle: "pending_deletion",
      generation: 4,
      storageKey: "not-a-storage-key",
    }];

    await runDocumentMaintenanceCycle();

    expect(mocks.deleteCiphertext).not.toHaveBeenCalled();
    const jobWrite = mocks.writes.find((write) => write.table === "document_jobs" && write.operation === "update");
    expect(jobWrite?.values).toMatchObject({ status: "retry", lastError: "purge_failed" });
  });
});

// ---------------------------------------------------------------------------
// 7. Storage reconciliation
// ---------------------------------------------------------------------------

describe("reconcileDocumentStorage", () => {
  it("rejects an available document whose crypto envelope is missing, and audits it", async () => {
    world.reconcileRecords = [{
      documentId: DOCUMENT,
      householdId: HOUSEHOLD,
      itemId: ITEM,
      lifecycle: "available",
      storageKey: null,
    }];

    await reconcileDocumentStorage();

    expect(documentWrites()).toEqual([
      // The interrupted-scanning sweep this function opens with.
      expect.objectContaining({ failureCode: "processing_interrupted" }),
      expect.objectContaining({ lifecycle: "rejected", failureCode: "crypto_metadata_missing" }),
    ]);
    expect(mocks.writes.filter((write) => write.table === "audit_log")).toEqual([
      expect.objectContaining({ values: expect.objectContaining({ action: "document_crypto_missing" }) }),
    ]);
    expect(mocks.ciphertextExists).not.toHaveBeenCalled();
  });

  it("preserves a pending_deletion document with no envelope for its purge job to retry", async () => {
    world.reconcileRecords = [{
      documentId: DOCUMENT,
      householdId: HOUSEHOLD,
      itemId: ITEM,
      lifecycle: "pending_deletion",
      storageKey: null,
    }];

    await reconcileDocumentStorage();

    expect(documentWrites()).toEqual([
      expect.objectContaining({ failureCode: "processing_interrupted" }),
    ]);
    expect(mocks.writes.some((write) => write.table === "audit_log")).toBe(false);
  });

  it("rejects an available document whose ciphertext has gone missing, under a document lock", async () => {
    world.reconcileRecords = [{
      documentId: DOCUMENT,
      householdId: HOUSEHOLD,
      itemId: ITEM,
      lifecycle: "available",
      storageKey: FINAL_KEY,
    }];
    mocks.ciphertextExists.mockResolvedValue(false);
    mocks.executeRows.readCurrentLifecycle = [{ lifecycle: "available" }];

    await reconcileDocumentStorage();

    expect(mocks.steps).toContain("execute:advisoryLock");
    expect(documentWrites()).toEqual([
      expect.objectContaining({ failureCode: "processing_interrupted" }),
      expect.objectContaining({ lifecycle: "rejected", failureCode: "storage_object_missing" }),
    ]);
  });

  it("leaves a document alone when the lock shows its lifecycle already moved on", async () => {
    world.reconcileRecords = [{
      documentId: DOCUMENT,
      householdId: HOUSEHOLD,
      itemId: ITEM,
      lifecycle: "available",
      storageKey: FINAL_KEY,
    }];
    mocks.ciphertextExists.mockResolvedValue(false);
    mocks.executeRows.readCurrentLifecycle = [{ lifecycle: "pending_deletion" }];

    await reconcileDocumentStorage();

    expect(documentWrites()).toEqual([
      expect.objectContaining({ failureCode: "processing_interrupted" }),
    ]);
  });

  it("deletes only unreferenced storage older than a day, in all three namespaces", async () => {
    const old = new Date(Date.now() - 25 * 60 * 60 * 1_000);
    const fresh = new Date();
    world.reconcileRecords = [{
      documentId: DOCUMENT,
      householdId: HOUSEHOLD,
      itemId: ITEM,
      lifecycle: "available",
      storageKey: FINAL_KEY,
    }];
    mocks.listCiphertextObjects.mockResolvedValue([
      { storageKey: FINAL_KEY, modifiedAt: old },
      { storageKey: "d".repeat(64), modifiedAt: old },
      { storageKey: "e".repeat(64), modifiedAt: fresh },
    ]);
    mocks.listStagingObjects.mockResolvedValue([
      { storageKey: "f".repeat(64), modifiedAt: old },
      { storageKey: "0".repeat(64), modifiedAt: fresh },
    ]);
    mocks.listQuarantineFiles.mockResolvedValue([
      { path: "/private/quarantine/old", modifiedAt: old },
      { path: "/private/quarantine/fresh", modifiedAt: fresh },
    ]);

    await reconcileDocumentStorage();

    // The referenced key and the fresh key both survive.
    expect(mocks.deleteCiphertext.mock.calls).toEqual([["d".repeat(64)]]);
    expect(mocks.deleteStagingCiphertext.mock.calls).toEqual([["f".repeat(64)]]);
    expect(mocks.discardQuarantine.mock.calls).toEqual([["/private/quarantine/old"]]);
  });
});
