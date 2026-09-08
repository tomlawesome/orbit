/**
 * Terminal handling of a scanner-recovery stage (#299).
 *
 * Everything here is about getting encrypted staged bytes to gone, in the
 * order ADR-0010 requires: the stage becomes `purge_pending` inside a
 * transaction that still holds the job's lease, and only then is the
 * ciphertext deleted. A deletion failure leaves the bounded `purge_pending`
 * backlog rather than a surface claiming the bytes are gone.
 */
import { and, eq, inArray, lt, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { auditLog, documentJobs, documentStagingObjects, documents, reviewedIntakeOperations } from "@/db/schema";
import { getDocumentConfig } from "@/server/documents/config";
import { LocalDocumentStorage } from "@/server/documents/storage";
import type { ClaimedScanJob, ScanRecoveryRecord } from "@/server/document-maintenance/claims";

export async function completeStagingPurge(
  documentId: string,
  storageKey: string,
  job?: ClaimedScanJob,
): Promise<boolean> {
  return getDb().transaction(async (transaction) => {
    await transaction.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`orbit:document:${documentId}`}, 0))`);
    const [stage] = await transaction.select({ status: documentStagingObjects.status })
      .from(documentStagingObjects)
      .where(and(eq(documentStagingObjects.documentId, documentId), eq(documentStagingObjects.storageKey, storageKey), eq(documentStagingObjects.status, "purge_pending")))
      .for("update").limit(1);
    if (!stage) return true;
    if (job) {
      const claims = await transaction.execute(sql<{ id: string }>`
        select id from document_jobs
        where id = ${job.id} and document_id = ${job.documentId} and kind = 'scan'
          and generation = ${job.generation} and status = 'processing'
          and lease_token = ${job.leaseToken}::uuid for update
      `);
      if (claims.length === 0) return false;
    }
    await transaction.delete(documentStagingObjects).where(and(
      eq(documentStagingObjects.documentId, documentId),
      eq(documentStagingObjects.storageKey, storageKey),
      eq(documentStagingObjects.status, "purge_pending"),
    ));
    if (job) {
      await transaction.update(documentJobs).set({
        status: "completed",
        completedAt: new Date(),
        lockedAt: null,
        leaseExpiresAt: null,
        leaseToken: null,
        lastError: null,
        updatedAt: new Date(),
      }).where(and(eq(documentJobs.id, job.id), eq(documentJobs.status, "processing"), eq(documentJobs.leaseToken, job.leaseToken)));
    } else {
      await transaction.update(documentJobs).set({
        status: "completed",
        completedAt: new Date(),
        lockedAt: null,
        leaseExpiresAt: null,
        leaseToken: null,
        lastError: null,
        updatedAt: new Date(),
      }).where(and(eq(documentJobs.documentId, documentId), eq(documentJobs.kind, "scan"), inArray(documentJobs.status, ["pending", "retry", "processing", "failed"])));
    }
    return true;
  });
}

export async function markStagingPurgeFailure(documentId: string, storageKey: string, job?: ClaimedScanJob): Promise<void> {
  await getDb().transaction(async (transaction) => {
    const now = new Date();
    await transaction.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`orbit:document:${documentId}`}, 0))`);
    await transaction.update(documentStagingObjects).set({
      purgeAttempts: sql`${documentStagingObjects.purgeAttempts} + 1`,
      purgeFailureCode: "stage_purge_failed",
      updatedAt: now,
    }).where(and(eq(documentStagingObjects.documentId, documentId), eq(documentStagingObjects.storageKey, storageKey), eq(documentStagingObjects.status, "purge_pending")));
    if (job) {
      await transaction.update(documentJobs).set({
        status: "failed",
        completedAt: null,
        lockedAt: null,
        leaseExpiresAt: null,
        leaseToken: null,
        lastError: "stage_purge_failed",
        updatedAt: now,
      }).where(and(eq(documentJobs.id, job.id), eq(documentJobs.status, "processing"), eq(documentJobs.leaseToken, job.leaseToken)));
    }
  });
}

/** Transitions terminal recovery to purge_pending under the live lease before touching ciphertext. */
export async function purgeScannerStage(job: ClaimedScanJob, record: ScanRecoveryRecord, failureCode: string): Promise<boolean> {
  const config = getDocumentConfig();
  const storage = new LocalDocumentStorage(config.storageRoot, config.quarantineRoot);
  const transitioned = await getDb().transaction(async (transaction) => {
    const now = new Date();
    await transaction.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`orbit:document:${job.documentId}`}, 0))`);
    const claims = await transaction.execute(sql<{ id: string }>`
      select id from document_jobs
      where id = ${job.id} and document_id = ${job.documentId} and kind = 'scan'
        and generation = ${job.generation} and status = 'processing'
        and lease_token = ${job.leaseToken}::uuid for update
    `);
    if (claims.length === 0) return false;
    const [document] = await transaction.select({ householdId: documents.householdId })
      .from(documents).where(and(eq(documents.id, job.documentId), eq(documents.lifecycle, "scanning"))).for("update").limit(1);
    const [stage] = await transaction.select({ status: documentStagingObjects.status })
      .from(documentStagingObjects).where(and(
        eq(documentStagingObjects.documentId, job.documentId),
        eq(documentStagingObjects.storageKey, record.stagingStorageKey),
        eq(documentStagingObjects.status, "pending"),
      )).for("update").limit(1);
    if (!document || !stage) return false;
    await transaction.update(documentStagingObjects).set({ status: "purge_pending", purgeFailureCode: null, updatedAt: now })
      .where(and(eq(documentStagingObjects.documentId, job.documentId), eq(documentStagingObjects.storageKey, record.stagingStorageKey), eq(documentStagingObjects.status, "pending")));
    await transaction.update(documents).set({
      lifecycle: "rejected",
      scanStatus: failureCode === "malware_detected" ? "infected" : "error",
      failureCode,
      updatedAt: now,
    }).where(and(eq(documents.id, job.documentId), eq(documents.lifecycle, "scanning")));
    await transaction.update(reviewedIntakeOperations).set({
      status: "failed",
      attachmentState: "pending",
      failureCode,
      updatedAt: now,
    }).where(and(eq(reviewedIntakeOperations.documentId, job.documentId), inArray(reviewedIntakeOperations.status, ["pending_attachment", "recoverable"])));
    await transaction.insert(auditLog).values({
      householdId: document.householdId,
      actorUserId: null,
      entityType: "document",
      entityId: job.documentId,
      action: failureCode === "malware_detected" ? "document_rejected_malware" : "document_rejected_scanner",
      changes: { itemId: record.itemId, reason: failureCode },
    });
    return true;
  });
  if (!transitioned) return false;
  try {
    await storage.deleteStagingCiphertext(record.stagingStorageKey);
    await completeStagingPurge(job.documentId, record.stagingStorageKey, job);
    return true;
  } catch {
    await markStagingPurgeFailure(job.documentId, record.stagingStorageKey, job);
    return false;
  }
}

export async function expireScannerRecoveryStages(): Promise<void> {
  const config = getDocumentConfig();
  const storage = new LocalDocumentStorage(config.storageRoot, config.quarantineRoot);
  for (let count = 0; count < 25; count += 1) {
    const row = await getDb().transaction(async (transaction) => {
      const now = new Date();
      const [candidate] = await transaction.select({
        documentId: documentStagingObjects.documentId,
        storageKey: documentStagingObjects.storageKey,
      }).from(documentStagingObjects).where(and(
        eq(documentStagingObjects.status, "pending"),
        lt(documentStagingObjects.recoveryExpiresAt, now),
      )).limit(1);
      if (!candidate) return undefined;
      await transaction.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`orbit:document:${candidate.documentId}`}, 0))`);
      const [document] = await transaction.select({ householdId: documents.householdId, itemId: documents.itemId })
        .from(documents).where(and(eq(documents.id, candidate.documentId), eq(documents.lifecycle, "scanning"))).for("update").limit(1);
      const [stage] = await transaction.select({ recoveryExpiresAt: documentStagingObjects.recoveryExpiresAt })
        .from(documentStagingObjects).where(and(
          eq(documentStagingObjects.documentId, candidate.documentId),
          eq(documentStagingObjects.storageKey, candidate.storageKey),
          eq(documentStagingObjects.status, "pending"),
        )).for("update").limit(1);
      if (!document || !stage || stage.recoveryExpiresAt > now) return null;
      const [job] = await transaction.select({ id: documentJobs.id })
        .from(documentJobs).where(and(
          eq(documentJobs.documentId, candidate.documentId),
          eq(documentJobs.kind, "scan"),
          inArray(documentJobs.status, ["pending", "retry", "processing", "failed"]),
        )).orderBy(documentJobs.generation).for("update").limit(1);
      await transaction.update(documentStagingObjects).set({ status: "purge_pending", purgeFailureCode: null, updatedAt: now })
        .where(and(eq(documentStagingObjects.documentId, candidate.documentId), eq(documentStagingObjects.storageKey, candidate.storageKey), eq(documentStagingObjects.status, "pending")));
      await transaction.update(documents).set({ lifecycle: "rejected", scanStatus: "error", failureCode: "scan_recovery_expired", updatedAt: now })
        .where(and(eq(documents.id, candidate.documentId), eq(documents.lifecycle, "scanning")));
      if (job) {
        await transaction.update(documentJobs).set({ status: "cancelled", completedAt: now, lockedAt: null, leaseExpiresAt: null, leaseToken: null, lastError: "scan_recovery_expired", updatedAt: now })
          .where(and(eq(documentJobs.id, job.id), inArray(documentJobs.status, ["pending", "retry", "processing", "failed"])));
      }
      await transaction.update(reviewedIntakeOperations).set({ status: "failed", attachmentState: "pending", failureCode: "scan_recovery_expired", updatedAt: now })
        .where(and(eq(reviewedIntakeOperations.documentId, candidate.documentId), inArray(reviewedIntakeOperations.status, ["pending_attachment", "recoverable"])));
      await transaction.insert(auditLog).values({
        householdId: document.householdId,
        actorUserId: null,
        entityType: "document",
        entityId: candidate.documentId,
        action: "document_rejected_scanner",
        changes: { itemId: document.itemId, reason: "scan_recovery_expired" },
      });
      return candidate;
    });
    if (row === null) continue;
    if (!row) break;
    try {
      await storage.deleteStagingCiphertext(row.storageKey);
      await completeStagingPurge(row.documentId, row.storageKey);
    } catch {
      await markStagingPurgeFailure(row.documentId, row.storageKey);
      await getDb().update(documentJobs).set({ status: "failed", completedAt: null, lockedAt: null, leaseExpiresAt: null, leaseToken: null, lastError: "stage_purge_failed", updatedAt: new Date() })
        .where(and(eq(documentJobs.documentId, row.documentId), eq(documentJobs.kind, "scan"), eq(documentJobs.status, "cancelled")));
    }
  }
}

/** Retries only the deletion of terminal staged bytes; it never invokes the scanner. */
export async function purgePendingScannerStages(): Promise<void> {
  const rows = await getDb().select({
    documentId: documentStagingObjects.documentId,
    storageKey: documentStagingObjects.storageKey,
  }).from(documentStagingObjects).where(eq(documentStagingObjects.status, "purge_pending")).limit(25);
  const config = getDocumentConfig();
  const storage = new LocalDocumentStorage(config.storageRoot, config.quarantineRoot);
  for (const row of rows) {
    try {
      await storage.deleteStagingCiphertext(row.storageKey);
      await completeStagingPurge(row.documentId, row.storageKey);
    } catch {
      await markStagingPurgeFailure(row.documentId, row.storageKey);
    }
  }
}
