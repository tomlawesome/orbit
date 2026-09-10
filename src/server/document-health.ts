import { access, mkdir } from "node:fs/promises";
import { constants } from "node:fs";
import { eq, notInArray, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { documentJobs, documentStagingObjects, documents } from "@/db/schema";
import { getDocumentWorkerHealth } from "@/server/document-worker";
import { getDocumentConfig } from "@/server/documents/config";
import {
  modelExtractionWindow,
  modelFailureRateExceeded,
  pingExtractionModel,
  selectedExtractionModel,
  type ModelExtractionWindow,
} from "@/server/documents/model-extraction";
import { pingClamAv } from "@/server/documents/scanner";

export interface DocumentHealth {
  overall: "healthy" | "degraded";
  encryption: { status: "ready" | "unavailable" };
  storage: { status: "ready" | "unavailable" };
  scanner: { status: "ready" | "disabled" | "unavailable"; mode: "required" | "disabled" | "unknown" };
  modelExtraction: ModelExtractionHealth;
  quota: { usedBytes: number; limitBytes: number };
  worker: ReturnType<typeof getDocumentWorkerHealth>;
  scanRecovery: { retrying: number; failed: number; purgePending: number; nextExpiryAt: string | null };
}

export type ModelExtractionStatus = "not_configured" | "ready" | "unavailable";

/**
 * Why the model path is in the state it is, from a fixed vocabulary. Nothing
 * here names a document or any of its content (ADR-0025 section 5).
 */
export type ModelExtractionReason = "no_profile" | "answering" | "unreachable" | "failing" | "unknown";

export interface ModelExtractionHealth {
  status: ModelExtractionStatus;
  reason: ModelExtractionReason;
  recent: ModelExtractionWindow;
}

const modelExtractionReasons: readonly ModelExtractionReason[] = ["no_profile", "answering", "unreachable", "failing", "unknown"];
const modelExtractionStatuses: readonly ModelExtractionStatus[] = ["not_configured", "ready", "unavailable"];

/**
 * The model path's state (ADR-0025 section 5). No `ai` profile is a design
 * state, not a fault: `not_configured` is never `unavailable`, so it can never
 * degrade overall health. The Compose profile is the only switch; there is no
 * in-app toggle to disagree with it.
 */
export function modelExtractionState(input: {
  configured: boolean;
  reachable: boolean | null;
  window: ModelExtractionWindow;
}): ModelExtractionHealth {
  const recent = input.window;
  if (!input.configured) return { status: "not_configured", reason: "no_profile", recent };
  if (input.reachable === null) return { status: "unavailable", reason: "unknown", recent };
  if (!input.reachable) return { status: "unavailable", reason: "unreachable", recent };
  if (modelFailureRateExceeded(recent)) return { status: "unavailable", reason: "failing", recent };
  return { status: "ready", reason: "answering", recent };
}

/** Projects document health to the administrator-safe response contract. */
export function toPublicDocumentHealth(health: DocumentHealth): DocumentHealth {
  const lastErrorCode = health.worker.lastErrorCode === null
    ? null
    : health.worker.lastErrorCode === "maintenance_cycle_failed"
      ? "maintenance_cycle_failed"
      : "unknown";
  return {
    overall: health.overall,
    encryption: { status: health.encryption.status },
    storage: { status: health.storage.status },
    scanner: { status: health.scanner.status, mode: health.scanner.mode },
    modelExtraction: {
      status: modelExtractionStatuses.includes(health.modelExtraction?.status) ? health.modelExtraction.status : "unavailable",
      reason: modelExtractionReasons.includes(health.modelExtraction?.reason) ? health.modelExtraction.reason : "unknown",
      recent: {
        samples: Number(health.modelExtraction?.recent?.samples ?? 0),
        failures: Number(health.modelExtraction?.recent?.failures ?? 0),
        timeouts: Number(health.modelExtraction?.recent?.timeouts ?? 0),
      },
    },
    quota: { usedBytes: health.quota.usedBytes, limitBytes: health.quota.limitBytes },
    worker: {
      started: health.worker.started,
      running: health.worker.running,
      lastSuccessAt: health.worker.lastSuccessAt,
      lastErrorAt: health.worker.lastErrorAt,
      lastErrorCode,
      lastReconciliationAt: health.worker.lastReconciliationAt,
    },
    scanRecovery: health.scanRecovery ?? { retrying: 0, failed: 0, purgePending: 0, nextExpiryAt: null },
  };
}

/** Returns non-sensitive document subsystem health for authenticated administrators. */
export async function getDocumentHealth(): Promise<DocumentHealth> {
  const worker = getDocumentWorkerHealth();
  try {
    const config = getDocumentConfig();
    let storageReady = false;
    try {
      await mkdir(config.storageRoot, { recursive: true, mode: 0o700 });
      await access(config.storageRoot, constants.R_OK | constants.W_OK);
      storageReady = true;
    } catch {
      // Report only the component state; filesystem paths are intentionally omitted.
    }

    const scannerStatus = config.scanMode === "disabled"
      ? "disabled" as const
      : await pingClamAv({ ...config.clamAv, timeoutMs: Math.min(config.clamAv.timeoutMs, 2_000) })
        ? "ready" as const
        : "unavailable" as const;
    const model = selectedExtractionModel();
    const [usage, retrying, failed, purgePending, nextExpiry, modelReachable] = await Promise.all([
      getDb()
      .select({ bytes: sql<number>`coalesce(sum(${documents.sizeBytes}), 0)` })
      .from(documents)
      .where(notInArray(documents.lifecycle, ["rejected", "deleted"])),
      getDb().select({ count: sql<number>`count(*)` }).from(documentJobs).where(sql`${documentJobs.kind} = 'scan' and ${documentJobs.status} = 'retry'`),
      getDb().select({ count: sql<number>`count(*)` }).from(documentJobs).where(sql`${documentJobs.kind} = 'scan' and ${documentJobs.status} = 'failed'`),
      getDb().select({ count: sql<number>`count(*)` }).from(documentStagingObjects).where(eq(documentStagingObjects.status, "purge_pending")),
      getDb().select({ expiresAt: sql<Date | null>`min(${documentStagingObjects.recoveryExpiresAt})` }).from(documentStagingObjects),
      // An absent profile is a design state, so it is never probed at all.
      model === undefined ? Promise.resolve(null) : pingExtractionModel(),
    ]);
    const modelExtraction = modelExtractionState({
      configured: model !== undefined,
      reachable: modelReachable,
      window: modelExtractionWindow(),
    });
    const healthy = storageReady
      && scannerStatus !== "unavailable"
      && modelExtraction.status !== "unavailable"
      && worker.started
      && !worker.lastErrorCode
      && Number(failed[0]?.count ?? 0) === 0
      && Number(purgePending[0]?.count ?? 0) === 0;

    return {
      overall: healthy ? "healthy" : "degraded",
      encryption: { status: "ready" },
      storage: { status: storageReady ? "ready" : "unavailable" },
      scanner: { status: scannerStatus, mode: config.scanMode },
      modelExtraction,
      quota: { usedBytes: Number(usage[0]?.bytes ?? 0), limitBytes: config.instanceQuotaBytes },
      worker,
      scanRecovery: { retrying: Number(retrying[0]?.count ?? 0), failed: Number(failed[0]?.count ?? 0), purgePending: Number(purgePending[0]?.count ?? 0), nextExpiryAt: nextExpiry[0]?.expiresAt?.toISOString?.() ?? null },
    };
  } catch {
    return {
      overall: "degraded",
      encryption: { status: "unavailable" },
      storage: { status: "unavailable" },
      scanner: { status: "unavailable", mode: "unknown" },
      // Configuration failed, so reachability was never established: say so
      // rather than claiming a state, and never claim a profile that is absent.
      modelExtraction: modelExtractionState({
        configured: selectedExtractionModel() !== undefined,
        reachable: null,
        window: modelExtractionWindow(),
      }),
      quota: { usedBytes: 0, limitBytes: 0 },
      worker,
      scanRecovery: { retrying: 0, failed: 0, purgePending: 0, nextExpiryAt: null },
    };
  }
}
