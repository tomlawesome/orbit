import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/* #1605 P-1 (from #1426): the retention purge claimed one batch of 25 a cycle,
   so a backlog of staged uploads cleared at 25 a minute. Ruling: a bounded
   drain: keep claiming batches of 25 while a full batch comes back, until a
   short batch or 30 s of the cycle are spent. */

const mocks = vi.hoisted(() => ({
  claim: vi.fn(),
  process: vi.fn(),
  fail: vi.fn(),
}));

vi.mock("@/db", () => ({ getDb: () => ({}) }));
vi.mock("@/lib/logger", () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock("@/server/portable-archive-repository", () => ({
  purgeExpiredPortableArchives: async () => undefined,
  reconcilePortableArchiveStorage: async () => undefined,
  rollBackStaleUnfinishedPortableImports: async () => undefined,
}));
vi.mock("@/server/household-lifecycle", () => ({ purgeExpiredHouseholds: async () => undefined }));
vi.mock("@/server/document-maintenance/scan-recovery", () => ({
  claimScannerRecoveryJobs: async () => [],
  failScannerRecoveryJob: async () => undefined,
  processScannerRecoveryJob: async () => undefined,
}));
vi.mock("@/server/document-maintenance/staging-purge", () => ({
  expireScannerRecoveryStages: async () => undefined,
  purgePendingScannerStages: async () => undefined,
}));
vi.mock("@/server/document-maintenance/rejected-purge", () => ({ purgeExpiredRejectedDocuments: async () => 0 }));
vi.mock("@/server/document-maintenance/scanner-health", () => ({ runScannerHealthCheck: async () => undefined, SCANNER_HEALTH_CHECK_INTERVAL_MS: 300_000 }));
vi.mock("@/server/documents/config", () => ({ getDocumentConfig: () => ({ scanMode: "disabled" }) }));
vi.mock("@/server/documents/scanner", () => ({ pingClamAv: async () => true }));
vi.mock("@/server/document-maintenance/purge-jobs", () => ({
  claimExpiredPurgeJobs: mocks.claim,
  processPurgeJob: mocks.process,
  failPurgeJob: mocks.fail,
}));
vi.mock("@/server/document-maintenance/storage-reconciliation", () => ({
  reconcileDocumentStorage: async () => undefined,
  rejectInterruptedDocuments: async () => undefined,
}));
vi.mock("@/server/document-maintenance/content-index-backfill", () => ({ backfillDocumentContentIndexes: async () => 0 }));
vi.mock("@/server/document-maintenance/imap-attachment-hash-backfill", () => ({ backfillImapAttachmentHashes: async () => 0 }));
vi.mock("@/server/document-maintenance/preview-jobs", () => ({ startPreviewWorker: () => undefined }));

import { PURGE_DRAIN_BATCH, PURGE_DRAIN_BUDGET_MS, runDocumentMaintenanceCycle } from "./document-worker";
import { workerState } from "@/server/document-maintenance/worker-state";

const jobs = (count: number) => Array.from({ length: count }, (_, index) => ({ id: `job-${index}`, documentId: `doc-${index}`, generation: 1, leaseToken: "t", previousStatus: "pending" }));

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-17T12:00:00Z"));
  // Skip the fifteen-minute reconciliation phase: only the purge is under test.
  workerState.__orbitDocumentWorkerLastReconciliationAt = new Date().toISOString();
  mocks.claim.mockReset();
  mocks.process.mockReset();
  mocks.fail.mockReset();
  mocks.process.mockResolvedValue("completed");
});
afterEach(() => vi.useRealTimers());

describe("the retention purge drains in bounded batches (P-1)", () => {
  it("exports a batch of 25 and a budget of 30 seconds", () => {
    expect(PURGE_DRAIN_BATCH).toBe(25);
    expect(PURGE_DRAIN_BUDGET_MS).toBe(30_000);
  });

  it("keeps claiming while a full batch comes back, and stops at the first short one", async () => {
    mocks.claim.mockResolvedValueOnce(jobs(25)).mockResolvedValueOnce(jobs(25)).mockResolvedValueOnce(jobs(7)).mockResolvedValue(jobs(25));
    await runDocumentMaintenanceCycle();
    expect(mocks.claim).toHaveBeenCalledTimes(3);
    expect(mocks.process).toHaveBeenCalledTimes(57);
  });

  it("makes one claim when the queue is empty", async () => {
    mocks.claim.mockResolvedValue([]);
    await runDocumentMaintenanceCycle();
    expect(mocks.claim).toHaveBeenCalledTimes(1);
  });

  it("stops draining once 30 s of the cycle are spent, even if every batch is full", async () => {
    mocks.claim.mockImplementation(async () => jobs(25));
    mocks.process.mockImplementation(async () => {
      vi.advanceTimersByTime(500); // 25 jobs x 500 ms = 12.5 s a batch
      return "completed";
    });
    await runDocumentMaintenanceCycle();
    expect(mocks.claim).toHaveBeenCalledTimes(3);
  });
});
