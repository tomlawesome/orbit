/**
 * The document maintenance worker: one poll loop, and the cycle it runs.
 *
 * The seams live in `src/server/document-maintenance/` (#299) — scan recovery,
 * staging purge, retention purge, storage reconciliation, and the lease/claim
 * core they share. This file keeps the public entry points, so importers and
 * the `orbit/server/document-worker` export path are unchanged.
 *
 * The phase order below is the contract, not an implementation detail: the
 * sweeps run before any job is claimed, reconciliation is rate-limited to once
 * every fifteen minutes, and scan recovery is claimed before retention purge.
 */
import { getDb } from "@/db";
import { log } from "@/lib/logger";
import { purgeExpiredPortableArchives, reconcilePortableArchiveStorage, rollBackStaleUnfinishedPortableImports } from "@/server/portable-archive-repository";
import { purgeExpiredHouseholds } from "@/server/household-lifecycle";
import { workerState } from "@/server/document-maintenance/worker-state";
import { claimScannerRecoveryJobs, failScannerRecoveryJob, processScannerRecoveryJob } from "@/server/document-maintenance/scan-recovery";
import { expireScannerRecoveryStages, purgePendingScannerStages } from "@/server/document-maintenance/staging-purge";
import { purgeExpiredRejectedDocuments } from "@/server/document-maintenance/rejected-purge";
import { claimExpiredPurgeJobs, failPurgeJob, processPurgeJob } from "@/server/document-maintenance/purge-jobs";
import { reconcileDocumentStorage, rejectInterruptedDocuments } from "@/server/document-maintenance/storage-reconciliation";
import { backfillDocumentContentIndexes } from "@/server/document-maintenance/content-index-backfill";

export { purgeClaimOutcome } from "@/server/document-maintenance/claims";
export { getDocumentWorkerHealth, type DocumentWorkerHealth } from "@/server/document-maintenance/worker-state";
export { reconcileDocumentStorage } from "@/server/document-maintenance/storage-reconciliation";

export async function runDocumentMaintenanceCycle(): Promise<void> {
  await rejectInterruptedDocuments();
  /* #1437: the documents stored before their fingerprint existed, a batch a cycle. */
  await backfillDocumentContentIndexes();
  await expireScannerRecoveryStages();
  await purgePendingScannerStages();
  /* #1786: refused uploads go after their retention, once their staged bytes have. */
  await purgeExpiredRejectedDocuments(getDb(), { now: new Date() });
  await purgeExpiredPortableArchives();
  await purgeExpiredHouseholds();
  const lastReconciliation = workerState.__orbitDocumentWorkerLastReconciliationAt
    ? Date.parse(workerState.__orbitDocumentWorkerLastReconciliationAt)
    : 0;
  if (!Number.isFinite(lastReconciliation) || Date.now() - lastReconciliation >= 15 * 60 * 1_000) {
    await reconcileDocumentStorage();
    await reconcilePortableArchiveStorage();
    // An import whose lease ran out without finishing (its own undo failed,
    // or its process died) is rolled back here, so the household reopens
    // within the lease plus this interval without a restart (#1390, AR2-1).
    await rollBackStaleUnfinishedPortableImports();
  }
  const scanJobs = await claimScannerRecoveryJobs();
  for (const job of scanJobs) {
    log.info({ event: "document.job", state: "starting", reason: "retry_scheduled", action: "retry_job", impact: "document_processing_blocked" });
    try {
      await processScannerRecoveryJob(job);
    } catch {
      await failScannerRecoveryJob(job, "scanner_failed");
    }
  }
  const jobs = await claimExpiredPurgeJobs();
  for (const job of jobs) {
    log.info({ event: "document.job", state: "starting", action: "retry_job" });
    try {
      const outcome = await processPurgeJob(job);
      if (outcome === "completed") log.info({ event: "document.job", state: "ready", action: "none" });
    } catch (error) {
      await failPurgeJob(job, error);
    }
  }
}

/** Starts one maintenance loop per process; PostgreSQL leases coordinate replicas. */
export function startDocumentWorker(pollMilliseconds = 60_000): void {
  if (workerState.__orbitDocumentWorkerStarted) return;
  workerState.__orbitDocumentWorkerStarted = true;

  const poll = async () => {
    workerState.__orbitDocumentWorkerRunning = true;
    try {
      await runDocumentMaintenanceCycle();
      workerState.__orbitDocumentWorkerLastSuccessAt = new Date().toISOString();
      workerState.__orbitDocumentWorkerLastErrorCode = undefined;
      log.info({ event: "document.worker", state: "ready", action: "none" });
    } catch {
      workerState.__orbitDocumentWorkerLastErrorAt = new Date().toISOString();
      workerState.__orbitDocumentWorkerLastErrorCode = "maintenance_cycle_failed";
      // The cause is deliberately not logged: it may carry storage paths or
      // provider text. The health endpoint exposes the bounded failure code.
      log.error({
        event: "document.worker",
        state: "retrying",
        reason: "worker_cycle_failed",
        action: "inspect_admin_diagnostics",
        impact: "worker_degraded",
      });
    } finally {
      workerState.__orbitDocumentWorkerRunning = false;
      setTimeout(poll, pollMilliseconds).unref();
    }
  };
  void poll();
}
