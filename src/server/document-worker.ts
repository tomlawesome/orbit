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
import { log } from "@/lib/logger";
import { purgeExpiredPortableArchives, reconcilePortableArchiveStorage } from "@/server/portable-archive-repository";
import { purgeExpiredHouseholds } from "@/server/household-lifecycle";
import { workerState } from "@/server/document-maintenance/worker-state";
import { claimScannerRecoveryJobs, failScannerRecoveryJob, processScannerRecoveryJob } from "@/server/document-maintenance/scan-recovery";
import { expireScannerRecoveryStages, purgePendingScannerStages } from "@/server/document-maintenance/staging-purge";
import { runScannerHealthCheck, SCANNER_HEALTH_CHECK_INTERVAL_MS } from "@/server/document-maintenance/scanner-health";
import { getDocumentConfig } from "@/server/documents/config";
import { pingClamAv } from "@/server/documents/scanner";
import { claimExpiredPurgeJobs, failPurgeJob, processPurgeJob } from "@/server/document-maintenance/purge-jobs";
import { reconcileDocumentStorage, rejectInterruptedDocuments } from "@/server/document-maintenance/storage-reconciliation";
import { backfillDocumentContentIndexes } from "@/server/document-maintenance/content-index-backfill";

export { purgeClaimOutcome } from "@/server/document-maintenance/claims";
export { getDocumentWorkerHealth, type DocumentWorkerHealth } from "@/server/document-maintenance/worker-state";
export { reconcileDocumentStorage } from "@/server/document-maintenance/storage-reconciliation";

/**
 * One ping of the scanner per cycle, only while scanning is enabled (#1419).
 * A ping that throws counts as unreachable. With scanning disabled the
 * answer is "reachable", so expiry behaves as it always did.
 */
async function scannerReachableNow(): Promise<{ scanning: boolean; reachable: boolean }> {
  const config = getDocumentConfig();
  if (config.scanMode !== "required") return { scanning: false, reachable: true };
  try {
    return { scanning: true, reachable: await pingClamAv({ ...config.clamAv, timeoutMs: Math.min(config.clamAv.timeoutMs, 2_000) }) };
  } catch {
    return { scanning: true, reachable: false };
  }
}

/** The scanner health check, every five minutes while scanning is enabled; it reuses the cycle's ping. */
async function scannerHealthCheckIfDue(scanner: { scanning: boolean; reachable: boolean }): Promise<void> {
  if (!scanner.scanning) return;
  const now = new Date();
  const last = workerState.__orbitDocumentWorkerLastScannerCheckAt ? Date.parse(workerState.__orbitDocumentWorkerLastScannerCheckAt) : 0;
  if (Number.isFinite(last) && now.getTime() - last < SCANNER_HEALTH_CHECK_INTERVAL_MS) return;
  workerState.__orbitDocumentWorkerLastScannerCheckAt = now.toISOString();
  await runScannerHealthCheck({ ping: async () => scanner.reachable }, { now });
}

export async function runDocumentMaintenanceCycle(): Promise<void> {
  await rejectInterruptedDocuments();
  /* #1437: the documents stored before their fingerprint existed, a batch a cycle. */
  await backfillDocumentContentIndexes();
  const scanner = await scannerReachableNow();
  // #1419: nothing held is rejected for age while the scanner cannot be reached.
  await expireScannerRecoveryStages({ scannerReachable: scanner.reachable });
  await scannerHealthCheckIfDue(scanner);
  await purgePendingScannerStages();
  await purgeExpiredPortableArchives();
  await purgeExpiredHouseholds();
  const lastReconciliation = workerState.__orbitDocumentWorkerLastReconciliationAt
    ? Date.parse(workerState.__orbitDocumentWorkerLastReconciliationAt)
    : 0;
  if (!Number.isFinite(lastReconciliation) || Date.now() - lastReconciliation >= 15 * 60 * 1_000) {
    await reconcileDocumentStorage();
    await reconcilePortableArchiveStorage();
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
