import { access, mkdir } from "node:fs/promises";
import { constants } from "node:fs";
import { eq, notInArray, or, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { documentJobs, documentStagingObjects, documents, imapIngestionMessages, items } from "@/db/schema";
import { countMetadataDamage, flushMetadataDamageSightings } from "@/server/metadata/damage-sightings";
import { metadataCryptoAvailable } from "@/server/metadata/keys";
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
  scanRecovery: { retrying: number; failed: number; purgePending: number; nextExpiryAt: string | null };
  /**
   * Tier 1 metadata (#941, ADR-0024 decision 5), so a missing key reads as one
   * instance-wide condition rather than one blank field at a time.
   *
   * `locked` is the instance holding no usable key-encryption key: the values
   * are intact and unreadable, and the two counts beside it say how much is
   * waiting. The damaged counts are the opposite state — unrecoverable, and
   * countable only from what has actually been encountered, because damage is
   * discoverable by decrypting and nothing sweeps for it.
   *
   * Counts only. No table, column, row or household crosses this boundary:
   * per-occurrence detail is in the administrator diagnostics, where it
   * already goes.
   */
  metadata: {
    locked: boolean;
    lockedItems: number;
    lockedReceipts: number;
    damagedValues: number;
    damagedItems: number;
    damagedReceipts: number;
  };
}

/** The zeroed metadata section, for the degraded answer and the locked-count skip. */
const NO_METADATA_TROUBLE: DocumentHealth["metadata"] = {
  locked: false,
  lockedItems: 0,
  lockedReceipts: 0,
  damagedValues: 0,
  damagedItems: 0,
  damagedReceipts: 0,
};

/**
 * How many rows hold an encrypted Tier 1 value, and how many damaged values
 * have been seen. The locked halves are live SQL and cheap — two counts over
 * an indexed null check — and are skipped entirely while the instance holds
 * its key, because then nothing is locked and the answer is zero.
 */
async function readMetadataHealth(): Promise<DocumentHealth["metadata"]> {
  const locked = !metadataCryptoAvailable();
  // Anything queued by a read still in flight belongs in this answer: an
  // administrator opening the screen right after a member opened the damaged
  // item should see it, not see it next time.
  await flushMetadataDamageSightings();
  const [damage, lockedItems, lockedReceipts] = await Promise.all([
    countMetadataDamage(),
    locked
      ? getDb().select({ count: sql<number>`count(*)::int` }).from(items)
        .where(or(sql`${items.referenceEnc} is not null`, sql`${items.notesEnc} is not null`))
      : Promise.resolve([{ count: 0 }]),
    locked
      ? getDb().select({ count: sql<number>`count(*)::int` }).from(imapIngestionMessages)
        .where(or(sql`${imapIngestionMessages.proposalEnc} is not null`, sql`${imapIngestionMessages.fieldEvidenceEnc} is not null`))
      : Promise.resolve([{ count: 0 }]),
  ]);
  return {
    locked,
    lockedItems: Number(lockedItems[0]?.count ?? 0),
    lockedReceipts: Number(lockedReceipts[0]?.count ?? 0),
    damagedValues: damage.values,
    damagedItems: damage.items,
    damagedReceipts: damage.receipts,
  };
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
    scanRecovery: health.scanRecovery ?? { retrying: 0, failed: 0, purgePending: 0, nextExpiryAt: null },
    // Numbers and one boolean, projected field by field like everything above
    // it: whatever a future caller puts on the internal shape, only these six
    // values can reach an administrator's browser.
    metadata: {
      locked: Boolean(health.metadata?.locked),
      lockedItems: Number(health.metadata?.lockedItems ?? 0),
      lockedReceipts: Number(health.metadata?.lockedReceipts ?? 0),
      damagedValues: Number(health.metadata?.damagedValues ?? 0),
      damagedItems: Number(health.metadata?.damagedItems ?? 0),
      damagedReceipts: Number(health.metadata?.damagedReceipts ?? 0),
    },
  };
}

/** Returns non-sensitive document subsystem health for authenticated administrators. */
export async function getDocumentHealth(): Promise<DocumentHealth> {
  const worker = getDocumentWorkerHealth();
  // Read outside the block below, and before it: an absent key-encryption key
  // makes `getDocumentConfig()` throw, which is the degraded path — and it is
  // also exactly the condition the locked counts exist to describe, so
  // computing them inside the try would guarantee they were never computed
  // when they matter (#941). Its own failure costs the section, not the screen.
  const metadata = await readMetadataHealth().catch(() => NO_METADATA_TROUBLE);
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
    const [usage, retrying, failed, purgePending, nextExpiry] = await Promise.all([
      getDb()
      .select({ bytes: sql<number>`coalesce(sum(${documents.sizeBytes}), 0)` })
      .from(documents)
      .where(notInArray(documents.lifecycle, ["rejected", "deleted"])),
      getDb().select({ count: sql<number>`count(*)` }).from(documentJobs).where(sql`${documentJobs.kind} = 'scan' and ${documentJobs.status} = 'retry'`),
      getDb().select({ count: sql<number>`count(*)` }).from(documentJobs).where(sql`${documentJobs.kind} = 'scan' and ${documentJobs.status} = 'failed'`),
      getDb().select({ count: sql<number>`count(*)` }).from(documentStagingObjects).where(eq(documentStagingObjects.status, "purge_pending")),
      getDb().select({ expiresAt: sql<Date | null>`min(${documentStagingObjects.recoveryExpiresAt})` }).from(documentStagingObjects),
    ]);
    const healthy = storageReady
      && scannerStatus !== "unavailable"
      && worker.started
      && !worker.lastErrorCode
      && Number(failed[0]?.count ?? 0) === 0
      && Number(purgePending[0]?.count ?? 0) === 0;

    return {
      overall: healthy ? "healthy" : "degraded",
      encryption: { status: "ready" },
      storage: { status: storageReady ? "ready" : "unavailable" },
      scanner: { status: scannerStatus, mode: config.scanMode },
      quota: { usedBytes: Number(usage[0]?.bytes ?? 0), limitBytes: config.instanceQuotaBytes },
      worker,
      scanRecovery: { retrying: Number(retrying[0]?.count ?? 0), failed: Number(failed[0]?.count ?? 0), purgePending: Number(purgePending[0]?.count ?? 0), nextExpiryAt: nextExpiry[0]?.expiresAt?.toISOString?.() ?? null },
      metadata,
    };
  } catch {
    return {
      overall: "degraded",
      encryption: { status: "unavailable" },
      storage: { status: "unavailable" },
      scanner: { status: "unavailable", mode: "unknown" },
      quota: { usedBytes: 0, limitBytes: 0 },
      worker,
      scanRecovery: { retrying: 0, failed: 0, purgePending: 0, nextExpiryAt: null },
      metadata,
    };
  }
}
