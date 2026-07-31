import { access, mkdir } from "node:fs/promises";
import { constants } from "node:fs";
import { notInArray, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { documents } from "@/db/schema";
import { getDocumentWorkerHealth } from "@/server/document-worker";
import { getDocumentConfig } from "@/server/documents/config";
import { pingClamAv } from "@/server/documents/scanner";

export interface DocumentHealth {
  overall: "healthy" | "degraded";
  encryption: { status: "ready" | "unavailable" };
  storage: { status: "ready" | "unavailable" };
  scanner: { status: "ready" | "disabled" | "unavailable"; mode: "required" | "disabled" | "unknown" };
  quota: { usedBytes: number; limitBytes: number };
  worker: ReturnType<typeof getDocumentWorkerHealth>;
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
    quota: { usedBytes: health.quota.usedBytes, limitBytes: health.quota.limitBytes },
    worker: {
      started: health.worker.started,
      running: health.worker.running,
      lastSuccessAt: health.worker.lastSuccessAt,
      lastErrorAt: health.worker.lastErrorAt,
      lastErrorCode,
      lastReconciliationAt: health.worker.lastReconciliationAt,
    },
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
    const [usage] = await getDb()
      .select({ bytes: sql<number>`coalesce(sum(${documents.sizeBytes}), 0)` })
      .from(documents)
      .where(notInArray(documents.lifecycle, ["rejected", "deleted"]));
    const healthy = storageReady
      && scannerStatus !== "unavailable"
      && worker.started
      && !worker.lastErrorCode;

    return {
      overall: healthy ? "healthy" : "degraded",
      encryption: { status: "ready" },
      storage: { status: storageReady ? "ready" : "unavailable" },
      scanner: { status: scannerStatus, mode: config.scanMode },
      quota: { usedBytes: Number(usage?.bytes ?? 0), limitBytes: config.instanceQuotaBytes },
      worker,
    };
  } catch {
    return {
      overall: "degraded",
      encryption: { status: "unavailable" },
      storage: { status: "unavailable" },
      scanner: { status: "unavailable", mode: "unknown" },
      quota: { usedBytes: 0, limitBytes: 0 },
      worker,
    };
  }
}
