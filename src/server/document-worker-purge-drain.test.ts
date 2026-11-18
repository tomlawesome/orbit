import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The retention purge's drain and breaker (#1605 P-1), and the poll loop's
 * health bookkeeping, with every maintenance seam stubbed so only the worker's
 * own decisions are under test:
 *  - a cycle pages through its backlog by job-id cursor until a claim comes
 *    back short, so no job is tried twice in a cycle;
 *  - three failed purges in a row end the cycle and give back the rest of the
 *    batch untried; a success resets the count;
 *  - a failing cycle is recorded as a bounded code and never rethrown.
 */

const m = vi.hoisted(() => ({
  claim: vi.fn(),
  process: vi.fn(),
  fail: vi.fn(),
  release: vi.fn(),
  none: vi.fn(async () => undefined),
}));

vi.mock("@/db", () => ({ getDb: () => ({}) }));
vi.mock("@/lib/logger", () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock("@/server/portable-archive-repository", () => ({
  purgeExpiredPortableArchives: m.none,
  reconcilePortableArchiveStorage: m.none,
  rollBackStaleUnfinishedPortableImports: m.none,
}));
vi.mock("@/server/household-lifecycle", () => ({ purgeExpiredHouseholds: m.none }));
vi.mock("@/server/document-maintenance/scan-recovery", () => ({
  claimScannerRecoveryJobs: async () => [],
  failScannerRecoveryJob: m.none,
  processScannerRecoveryJob: m.none,
}));
vi.mock("@/server/document-maintenance/staging-purge", () => ({
  expireScannerRecoveryStages: m.none,
  purgePendingScannerStages: m.none,
}));
vi.mock("@/server/document-maintenance/rejected-purge", () => ({ purgeExpiredRejectedDocuments: m.none }));
vi.mock("@/server/document-maintenance/scanner-health", () => ({
  runScannerHealthCheck: m.none,
  SCANNER_HEALTH_CHECK_INTERVAL_MS: 300_000,
}));
vi.mock("@/server/documents/config", () => ({ getDocumentConfig: () => ({ scanMode: "off" }) }));
vi.mock("@/server/documents/scanner", () => ({ pingClamAv: async () => true }));
vi.mock("@/server/document-maintenance/purge-jobs", () => ({
  PURGE_BATCH_SIZE: 3,
  claimExpiredPurgeJobs: m.claim,
  processPurgeJob: m.process,
  failPurgeJob: m.fail,
  releasePurgeClaim: m.release,
}));
vi.mock("@/server/document-maintenance/storage-reconciliation", () => ({
  reconcileDocumentStorage: m.none,
  rejectInterruptedDocuments: m.none,
}));
vi.mock("@/server/document-maintenance/content-index-backfill", () => ({ backfillDocumentContentIndexes: m.none }));
vi.mock("@/server/document-maintenance/imap-attachment-hash-backfill", () => ({ backfillImapAttachmentHashes: m.none }));
vi.mock("@/server/document-maintenance/preview-jobs", () => ({ startPreviewWorker: vi.fn() }));

import { getDocumentWorkerHealth, runDocumentMaintenanceCycle, startDocumentWorker } from "./document-worker";
import { workerState } from "./document-maintenance/worker-state";

const job = (id: string) => ({ id, previousStatus: "pending" });

beforeEach(() => {
  for (const fn of [m.claim, m.process, m.fail, m.release]) fn.mockReset();
  m.claim.mockResolvedValue([]);
  m.process.mockResolvedValue("completed");
});

describe("the retention purge drain", () => {
  it("pages by the last job id of each full batch and stops at the first short one", async () => {
    m.claim
      .mockResolvedValueOnce([job("a"), job("b"), job("c")])
      .mockResolvedValueOnce([job("d"), job("e"), job("f")])
      .mockResolvedValueOnce([job("g")]);
    await runDocumentMaintenanceCycle();
    expect(m.claim.mock.calls).toEqual([[3, undefined], [3, "c"], [3, "f"]]);
    expect(m.process.mock.calls.map(([j]) => j.id)).toEqual(["a", "b", "c", "d", "e", "f", "g"]);
  });

  it("stops after one claim when the backlog is empty", async () => {
    await runDocumentMaintenanceCycle();
    expect(m.claim).toHaveBeenCalledTimes(1);
    expect(m.process).not.toHaveBeenCalled();
  });

  it("fails a job that throws and carries on with the next", async () => {
    const boom = new Error("storage down");
    m.claim.mockResolvedValueOnce([job("a"), job("b")]);
    m.process.mockRejectedValueOnce(boom);
    await runDocumentMaintenanceCycle();
    expect(m.fail).toHaveBeenCalledWith(expect.objectContaining({ id: "a" }), boom);
    expect(m.process).toHaveBeenCalledTimes(2);
    expect(m.release).not.toHaveBeenCalled();
  });

  it("ends the cycle at three failures in a row and gives the rest of the batch back untried", async () => {
    m.claim.mockResolvedValueOnce([job("a"), job("b"), job("c")]);
    m.process.mockRejectedValue(new Error("down"));
    await runDocumentMaintenanceCycle();
    expect(m.fail).toHaveBeenCalledTimes(3);
    expect(m.release).not.toHaveBeenCalled();

    expect(m.claim).toHaveBeenCalledTimes(1);
  });

  it("releases the untried jobs of the batch when the breaker opens mid-batch", async () => {
    const batch = [job("a"), job("b"), job("c"), job("d"), job("e")];
    m.claim.mockResolvedValueOnce(batch);
    m.process.mockRejectedValue(new Error("down"));
    // A batch of five against a page size of three still ends the cycle at the third failure.
    await runDocumentMaintenanceCycle();
    expect(m.process).toHaveBeenCalledTimes(3);
    expect(m.fail).toHaveBeenCalledTimes(3);
    expect(m.release.mock.calls.map(([j]) => j.id)).toEqual(["d", "e"]);
    expect(m.claim).toHaveBeenCalledTimes(1);
  });

  it("resets the count on a success, so failures that are not in a row never open the breaker", async () => {
    m.claim.mockResolvedValueOnce([job("a"), job("b"), job("c")]).mockResolvedValueOnce([job("d"), job("e"), job("f")]).mockResolvedValueOnce([]);
    const down = new Error("down");
    m.process
      .mockRejectedValueOnce(down).mockRejectedValueOnce(down).mockResolvedValueOnce("completed")
      .mockRejectedValueOnce(down).mockRejectedValueOnce(down).mockResolvedValueOnce("completed");
    await runDocumentMaintenanceCycle();
    expect(m.process).toHaveBeenCalledTimes(6);
    expect(m.fail).toHaveBeenCalledTimes(4);
    expect(m.release).not.toHaveBeenCalled();
    expect(m.claim).toHaveBeenCalledTimes(3);
  });
});

describe("the poll loop's health state", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    delete workerState.__orbitDocumentWorkerStarted;
    delete workerState.__orbitDocumentWorkerLastSuccessAt;
    delete workerState.__orbitDocumentWorkerLastErrorAt;
    delete workerState.__orbitDocumentWorkerLastErrorCode;
  });
  afterEach(() => {
    vi.useRealTimers();
    delete workerState.__orbitDocumentWorkerStarted;
  });

  it("records a success, then a bounded failure code without the cause, and keeps polling", async () => {
    startDocumentWorker(1_000);
    await vi.advanceTimersByTimeAsync(0);
    let health = getDocumentWorkerHealth();
    expect(health.started).toBe(true);
    expect(health.running).toBe(false);
    expect(health.lastSuccessAt).not.toBeNull();
    expect(health.lastErrorCode).toBeNull();

    m.claim.mockRejectedValue(new Error("secret path /srv/orbit/x"));
    await vi.advanceTimersByTimeAsync(1_000);
    health = getDocumentWorkerHealth();
    expect(health.lastErrorCode).toBe("maintenance_cycle_failed");
    expect(health.lastErrorAt).not.toBeNull();
    expect(JSON.stringify(health)).not.toContain("/srv/orbit");

    m.claim.mockResolvedValue([]);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(getDocumentWorkerHealth().lastErrorCode).toBeNull();
  });

  it("starts once per process", async () => {
    startDocumentWorker(1_000);
    startDocumentWorker(1_000);
    await vi.advanceTimersByTimeAsync(0);
    expect(m.claim).toHaveBeenCalledTimes(1);
  });
});
