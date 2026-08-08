import { and, eq, inArray, lt, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { auditLog, documentCrypto, documentDrafts, documentJobs, documentStagingObjects, documents, reviewedIntakeOperations } from "@/db/schema";
import { log } from "@/lib/logger";
import { getDocumentConfig } from "@/server/documents/config";
import { LocalDocumentStorage } from "@/server/documents/storage";
import { decryptDocument, encryptDocument, type DocumentCryptoEnvelope } from "@/server/documents/crypto";
import { scanFileWithClamAv } from "@/server/documents/scanner";
import {
  isScannerRecoveryExpired,
  retryableScannerFailureCode,
  scannerRecoveryDelayMs,
  SCANNER_RECOVERY_MAX_ATTEMPTS,
} from "@/server/documents/staging";
import { processOwnedPurge, type OwnedPurgeJob, type OwnedPurgeState } from "@/server/documents/purge";
import { reconcileMissingDocument } from "@/server/documents/reconciliation";
import { purgeExpiredPortableArchives, reconcilePortableArchiveStorage } from "@/server/portable-archive-repository";
import { purgeExpiredHouseholds } from "@/server/household-lifecycle";

interface ClaimedDocumentJob extends OwnedPurgeJob {
  /** The job's status immediately before this claim; distinguishes an expired-lease reclaim from a fresh pending/retry claim. */
  previousStatus: "pending" | "retry" | "processing";
}

/** Pure classification of a claim outcome from the pre-claim status, kept separate from the SQL for direct testability. */
export function purgeClaimOutcome(previousStatus: "pending" | "retry" | "processing"): "claimed" | "reclaimed" {
  return previousStatus === "processing" ? "reclaimed" : "claimed";
}

interface OwnedPurgeRecord {
  householdId: string;
  itemId: string | null;
  lifecycle: string;
  generation: number;
  storageKey: string | null;
}

interface ClaimedScanJob {
  id: string;
  documentId: string;
  generation: number;
  leaseToken: string;
  previousStatus: "pending" | "retry" | "processing";
}

interface ScanRecoveryRecord {
  householdId: string;
  itemId: string;
  mediaType: string;
  sizeBytes: number;
  displayName: string;
  contentSha256: string;
  stagingStorageKey: string;
  ciphertextSize: number;
  envelopeVersion: 1;
  contentIv: string;
  contentAuthTag: string;
  wrappedDek: string;
  wrapIv: string;
  wrapAuthTag: string;
  keyId: string;
  recoveryExpiresAt: Date;
}

export interface DocumentWorkerHealth {
  started: boolean;
  running: boolean;
  lastSuccessAt: string | null;
  lastErrorAt: string | null;
  lastErrorCode: string | null;
  lastReconciliationAt: string | null;
}

const workerState = globalThis as typeof globalThis & {
  __orbitDocumentWorkerStarted?: boolean;
  __orbitDocumentWorkerRunning?: boolean;
  __orbitDocumentWorkerLastSuccessAt?: string;
  __orbitDocumentWorkerLastErrorAt?: string;
  __orbitDocumentWorkerLastErrorCode?: string;
  __orbitDocumentWorkerLastReconciliationAt?: string;
};

export function getDocumentWorkerHealth(): DocumentWorkerHealth {
  return {
    started: workerState.__orbitDocumentWorkerStarted ?? false,
    running: workerState.__orbitDocumentWorkerRunning ?? false,
    lastSuccessAt: workerState.__orbitDocumentWorkerLastSuccessAt ?? null,
    lastErrorAt: workerState.__orbitDocumentWorkerLastErrorAt ?? null,
    lastErrorCode: workerState.__orbitDocumentWorkerLastErrorCode ?? null,
    lastReconciliationAt: workerState.__orbitDocumentWorkerLastReconciliationAt ?? null,
  };
}

async function claimExpiredPurgeJobs(limit = 25): Promise<ClaimedDocumentJob[]> {
  const rows = await getDb().execute(sql<ClaimedDocumentJob>`
    with claimable as materialized (
      select job.id, job.status as previous_status
      from document_jobs job
      inner join documents document on document.id = job.document_id
      where job.kind = 'purge'
        and (
          job.status in ('pending', 'retry')
          or (job.status = 'processing' and job.lease_expires_at < now())
        )
        and document.lifecycle = 'pending_deletion'
        and document.delete_after <= now()
        and (job.lease_expires_at is null or job.lease_expires_at < now())
      order by document.delete_after
      for update of job skip locked
      limit ${limit}
    ), claimed as (
      update document_jobs as job
      set status = 'processing',
          attempts = job.attempts + 1,
          locked_at = now(),
          lease_expires_at = now() + interval '10 minutes',
          lease_token = gen_random_uuid(),
          updated_at = now()
      from claimable
      where job.id = claimable.id
      returning job.id, job.document_id, job.generation, job.lease_token
    )
    select claimed.id, claimed.document_id as "documentId", claimed.generation,
      claimed.lease_token as "leaseToken", claimable.previous_status as "previousStatus"
    from claimed
    inner join claimable on claimable.id = claimed.id
  `);
  return rows as unknown as ClaimedDocumentJob[];
}

async function claimScannerRecoveryJobs(limit = 25): Promise<ClaimedScanJob[]> {
  const rows = await getDb().execute(sql<ClaimedScanJob>`
    with claimable as materialized (
      select job.id, job.status as previous_status
      from document_jobs job
      inner join documents document on document.id = job.document_id
      inner join document_staging_objects stage on stage.document_id = document.id
      where job.kind = 'scan'
        and document.lifecycle = 'scanning'
        and stage.status = 'pending'
        and stage.recovery_expires_at > now()
        and job.next_attempt_at <= now()
        and job.attempts < ${SCANNER_RECOVERY_MAX_ATTEMPTS}
        and (
          job.status in ('pending', 'retry')
          or (job.status = 'processing' and job.lease_expires_at < now())
        )
        and (job.lease_expires_at is null or job.lease_expires_at < now())
      order by job.next_attempt_at, job.created_at
      for update of job skip locked
      limit ${limit}
    ), claimed as (
      update document_jobs as job
      set status = 'processing',
          attempts = job.attempts + 1,
          locked_at = now(),
          lease_expires_at = now() + interval '10 minutes',
          lease_token = gen_random_uuid(),
          updated_at = now()
      from claimable
      where job.id = claimable.id
      returning job.id, job.document_id, job.generation, job.lease_token
    )
    select claimed.id, claimed.document_id as "documentId", claimed.generation,
      claimed.lease_token as "leaseToken", claimable.previous_status as "previousStatus"
    from claimed
    inner join claimable on claimable.id = claimed.id
  `);
  return rows as unknown as ClaimedScanJob[];
}

async function readOwnedScanRecord(job: ClaimedScanJob): Promise<ScanRecoveryRecord | undefined> {
  const rows = await getDb().execute(sql<ScanRecoveryRecord>`
    select document.household_id as "householdId",
           document.item_id as "itemId",
           document.media_type as "mediaType",
           document.size_bytes as "sizeBytes",
           document.display_name as "displayName",
           document.content_sha256 as "contentSha256",
           stage.storage_key as "stagingStorageKey",
           stage.ciphertext_size as "ciphertextSize",
           stage.envelope_version as "envelopeVersion",
           stage.content_iv as "contentIv",
           stage.content_auth_tag as "contentAuthTag",
           stage.wrapped_dek as "wrappedDek",
           stage.wrap_iv as "wrapIv",
           stage.wrap_auth_tag as "wrapAuthTag",
           stage.key_id as "keyId",
           stage.recovery_expires_at as "recoveryExpiresAt"
    from documents document
    inner join document_staging_objects stage on stage.document_id = document.id
    inner join document_jobs job on job.document_id = document.id
    where document.id = ${job.documentId}
      and document.lifecycle = 'scanning'
      and stage.status = 'pending'
      and job.id = ${job.id}
      and job.kind = 'scan'
      and job.status = 'processing'
      and job.generation = ${job.generation}
      and job.lease_token = ${job.leaseToken}::uuid
    limit 1
  `);
  const record = (rows as unknown as ScanRecoveryRecord[])[0];
  if (!record) return undefined;
  const recoveryExpiresAt = new Date(record.recoveryExpiresAt as unknown as string | Date);
  return { ...record, recoveryExpiresAt };
}

async function clearScanJob(job: ClaimedScanJob, status: "completed" | "cancelled", lastError: string | null = null): Promise<boolean> {
  const changed = await getDb().update(documentJobs).set({
    status,
    completedAt: new Date(),
    lockedAt: null,
    leaseExpiresAt: null,
    leaseToken: null,
    lastError,
    updatedAt: new Date(),
  }).where(and(
    eq(documentJobs.id, job.id),
    eq(documentJobs.documentId, job.documentId),
    eq(documentJobs.kind, "scan"),
    eq(documentJobs.generation, job.generation),
    eq(documentJobs.status, "processing"),
    eq(documentJobs.leaseToken, job.leaseToken),
  )).returning({ id: documentJobs.id });
  return changed.length === 1;
}

async function failScannerRecoveryJob(job: ClaimedScanJob, failureCode: string): Promise<void> {
  const [current] = await getDb().select({ attempts: documentJobs.attempts })
    .from(documentJobs)
    .where(and(eq(documentJobs.id, job.id), eq(documentJobs.status, "processing"), eq(documentJobs.leaseToken, job.leaseToken)))
    .limit(1);
  if (!current) return;
  const exhausted = current.attempts >= SCANNER_RECOVERY_MAX_ATTEMPTS;
  const nextAttemptAt = new Date(Date.now() + scannerRecoveryDelayMs(current.attempts + 1));
  await getDb().update(documentJobs).set({
    status: exhausted ? "failed" : "retry",
    nextAttemptAt,
    lockedAt: null,
    leaseExpiresAt: null,
    leaseToken: null,
    lastError: failureCode,
    updatedAt: new Date(),
  }).where(and(
    eq(documentJobs.id, job.id),
    eq(documentJobs.status, "processing"),
    eq(documentJobs.leaseToken, job.leaseToken),
  ));
  log.warn("document.job", {
    document: job.documentId,
    job: job.id,
    kind: "scan",
    outcome: exhausted ? "failed" : "retry",
    reason: failureCode,
    attempts: current.attempts,
  });
}

async function completeStagingPurge(
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

async function markStagingPurgeFailure(documentId: string, storageKey: string, job?: ClaimedScanJob): Promise<void> {
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
async function purgeScannerStage(job: ClaimedScanJob, record: ScanRecoveryRecord, failureCode: string): Promise<boolean> {
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

async function processScannerRecoveryJob(job: ClaimedScanJob): Promise<void> {
  const config = getDocumentConfig();
  const storage = new LocalDocumentStorage(config.storageRoot, config.quarantineRoot);
  const record = await readOwnedScanRecord(job);
  if (!record) {
    await clearScanJob(job, "cancelled", "staging_object_missing");
    return;
  }
  if (!Number.isFinite(record.recoveryExpiresAt.getTime())) {
    await purgeScannerStage(job, record, "staging_object_invalid");
    return;
  }
  if (isScannerRecoveryExpired(record.recoveryExpiresAt)) {
    await purgeScannerStage(job, record, "scan_recovery_expired");
    return;
  }

  let ciphertext: Buffer | undefined;
  let plaintext: Buffer | undefined;
  let quarantinePath: string | undefined;
  let finalStorageKey: string | undefined;
  let availabilityFinalized = false;
  try {
    ciphertext = await storage.readStagingCiphertext(record.stagingStorageKey, config.maxBytes);
    plaintext = decryptDocument(ciphertext!, {
      documentId: job.documentId,
      householdId: record.householdId,
      itemId: record.itemId,
      mediaType: record.mediaType,
      plaintextSize: record.sizeBytes,
      purpose: "scanner_recovery",
    }, {
      envelopeVersion: record.envelopeVersion,
      algorithm: "aes-256-gcm",
      keyId: record.keyId,
      contentIv: record.contentIv,
      contentAuthTag: record.contentAuthTag,
      wrappedDek: record.wrappedDek,
      wrapIv: record.wrapIv,
      wrapAuthTag: record.wrapAuthTag,
    } as DocumentCryptoEnvelope, config.keyEncryptionKey);
    quarantinePath = await storage.writeQuarantineBytes(job.documentId, plaintext);
    const scan = await scanFileWithClamAv(quarantinePath, config.clamAv);
    await storage.discardQuarantine(quarantinePath);
    quarantinePath = undefined;
    if (scan.status !== "clean") {
      const retryable = retryableScannerFailureCode(scan);
      if (retryable) {
        await failScannerRecoveryJob(job, retryable);
        return;
      }
      await purgeScannerStage(job, record, scan.status === "infected" ? "malware_detected" : "scanner_failed");
      return;
    }
    finalStorageKey = storage.createStorageKey();
    const encrypted = encryptDocument(plaintext, {
      documentId: job.documentId,
      householdId: record.householdId,
      itemId: record.itemId,
      mediaType: record.mediaType,
      plaintextSize: record.sizeBytes,
    }, config.keyEncryptionKey, config.keyId);
    await storage.writeCiphertext(finalStorageKey, encrypted.ciphertext);
    const now = new Date();
    const finalized = await getDb().transaction(async (transaction) => {
      await transaction.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`orbit:document:${job.documentId}`}, 0))`);
      const claims = await transaction.execute(sql<{ id: string }>`
        select id from document_jobs
        where id = ${job.id} and document_id = ${job.documentId} and kind = 'scan'
          and generation = ${job.generation} and status = 'processing'
          and lease_token = ${job.leaseToken}::uuid for update
      `);
      if (claims.length === 0) return false;
      const [stage] = await transaction.select({
        status: documentStagingObjects.status,
        recoveryExpiresAt: documentStagingObjects.recoveryExpiresAt,
      }).from(documentStagingObjects).where(and(
        eq(documentStagingObjects.documentId, job.documentId),
        eq(documentStagingObjects.storageKey, record.stagingStorageKey),
        eq(documentStagingObjects.status, "pending"),
      )).for("update").limit(1);
      if (!stage || stage.recoveryExpiresAt <= now) return false;
      const [changed] = await transaction.update(documents).set({
        lifecycle: "available",
        scanStatus: "clean",
        availableAt: now,
        failureCode: null,
        version: sql`${documents.version} + 1`,
        updatedAt: now,
      }).where(and(eq(documents.id, job.documentId), eq(documents.lifecycle, "scanning"))).returning({ id: documents.id });
      if (!changed) return false;
      await transaction.insert(documentCrypto).values({ documentId: job.documentId, storageKey: finalStorageKey!, ciphertextSize: encrypted.ciphertext.length, ...encrypted.envelope });
      await transaction.update(documentStagingObjects).set({ status: "purge_pending", purgeFailureCode: null, updatedAt: now })
        .where(and(eq(documentStagingObjects.documentId, job.documentId), eq(documentStagingObjects.storageKey, record.stagingStorageKey), eq(documentStagingObjects.status, "pending")));
      await transaction.update(documentJobs).set({ status: "completed", completedAt: now, lockedAt: null, leaseExpiresAt: null, leaseToken: null, lastError: null, updatedAt: now })
        .where(and(eq(documentJobs.id, job.id), eq(documentJobs.status, "processing"), eq(documentJobs.leaseToken, job.leaseToken)));
      const pendingOperations = await transaction.select({ id: reviewedIntakeOperations.id, actorUserId: reviewedIntakeOperations.actorUserId, resultId: reviewedIntakeOperations.resultId })
        .from(reviewedIntakeOperations).where(and(eq(reviewedIntakeOperations.documentId, job.documentId), inArray(reviewedIntakeOperations.status, ["pending_attachment", "recoverable"])));
      for (const operation of pendingOperations) {
        await transaction.update(reviewedIntakeOperations).set({ status: "completed", attachmentState: "attached", completedAt: now, failureCode: null, updatedAt: now })
          .where(eq(reviewedIntakeOperations.id, operation.id));
        await transaction.insert(auditLog).values({ id: operation.resultId, householdId: record.householdId, actorUserId: operation.actorUserId, entityType: "reviewed_intake", entityId: operation.resultId, action: "reviewed_intake_approved", changes: { source: "direct_upload", result: "completed", itemId: record.itemId, documentId: job.documentId } }).onConflictDoUpdate({ target: auditLog.id, set: { action: "reviewed_intake_approved", changes: { source: "direct_upload", result: "completed", itemId: record.itemId, documentId: job.documentId } } });
      }
      await transaction.insert(auditLog).values({ householdId: record.householdId, actorUserId: null, entityType: "document", entityId: job.documentId, action: "document_available", changes: { itemId: record.itemId, sizeBytes: record.sizeBytes, mediaType: record.mediaType, scanStatus: "clean" } });
      return true;
    });
    if (!finalized) {
      await storage.deleteCiphertext(finalStorageKey).catch(() => undefined);
    } else {
      availabilityFinalized = true;
      try {
        await storage.deleteStagingCiphertext(record.stagingStorageKey);
        await completeStagingPurge(job.documentId, record.stagingStorageKey);
      } catch {
        await markStagingPurgeFailure(job.documentId, record.stagingStorageKey);
      }
    }
  } catch (error) {
    if (availabilityFinalized) {
      log.warn("document.job", {
        document: job.documentId,
        job: job.id,
        kind: "scan",
        outcome: "purge_pending",
        reason: "stage_purge_failed",
      });
      return;
    }
    if (finalStorageKey) await storage.deleteCiphertext(finalStorageKey).catch(() => undefined);
    if (error instanceof Error && /authentication|invalid|unsupported|size|enoent|no such file/i.test(error.message)) {
      await purgeScannerStage(job, record, "staging_object_invalid");
      return;
    }
    await failScannerRecoveryJob(job, "scanner_failed");
  } finally {
    ciphertext?.fill(0);
    plaintext?.fill(0);
    if (quarantinePath) await storage.discardQuarantine(quarantinePath).catch(() => undefined);
  }
}

async function expireScannerRecoveryStages(): Promise<void> {
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
async function purgePendingScannerStages(): Promise<void> {
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

async function processPurgeJob(job: ClaimedDocumentJob): Promise<"completed" | "stale"> {
  const config = getDocumentConfig();
  const storage = new LocalDocumentStorage(config.storageRoot, config.quarantineRoot);
  const outcome = await processOwnedPurge(job, {
    readOwnedPurge: async (claimedJob): Promise<OwnedPurgeState | undefined> => {
      return getDb().transaction(async (transaction) => {
        await transaction.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${`orbit:document:${claimedJob.documentId}`}, 0))`,
        );
        const activeClaims = await transaction.execute(sql<{ id: string }>`
          select id
          from document_jobs
          where id = ${claimedJob.id}
            and status = 'processing'
            and generation = ${claimedJob.generation}
            and lease_token = ${claimedJob.leaseToken}::uuid
          for update
        `);
        if (activeClaims.length === 0) return undefined;

        const records = await transaction.execute(sql<OwnedPurgeRecord>`
          select document.household_id as "householdId",
                 document.item_id as "itemId",
                 document.lifecycle,
                 document.version as generation,
                 crypto.storage_key as "storageKey"
          from documents document
          left join document_crypto crypto on crypto.document_id = document.id
          where document.id = ${claimedJob.documentId}
          for update of document
        `) as unknown as OwnedPurgeRecord[];
        const [record] = records;
        if (!record
          || record.lifecycle !== "pending_deletion"
          || record.generation !== claimedJob.generation
        ) return undefined;
        if (!record.storageKey || !/^[a-f0-9]{64}$/u.test(record.storageKey)) {
          throw new Error("Invalid document purge storage metadata");
        }
        return {
          householdId: record.householdId,
          itemId: record.itemId,
          storageKey: record.storageKey,
          generation: record.generation,
        };
      });
    },
    deleteCiphertext: (storageKey) => storage.deleteCiphertext(storageKey),
    finalizeOwnedPurge: async (claimedJob, state): Promise<boolean> => {
      return getDb().transaction(async (transaction) => {
        await transaction.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${`orbit:document:${claimedJob.documentId}`}, 0))`,
        );
        const activeClaims = await transaction.execute(sql<{ id: string }>`
          select id
          from document_jobs
          where id = ${claimedJob.id}
            and status = 'processing'
            and generation = ${claimedJob.generation}
            and lease_token = ${claimedJob.leaseToken}::uuid
          for update
        `);
        if (activeClaims.length === 0) return false;

        const records = await transaction.execute(sql<OwnedPurgeRecord>`
          select document.household_id as "householdId",
                 document.item_id as "itemId",
                 document.lifecycle,
                 document.version as generation,
                 crypto.storage_key as "storageKey"
          from documents document
          left join document_crypto crypto on crypto.document_id = document.id
          where document.id = ${claimedJob.documentId}
          for update of document
        `) as unknown as OwnedPurgeRecord[];
        const [record] = records;
        if (!record
          || record.lifecycle !== "pending_deletion"
          || record.generation !== claimedJob.generation
          || record.storageKey !== state.storageKey
        ) return false;

        const now = new Date();
        const [changedDocument] = await transaction.update(documents).set({
          lifecycle: "deleted",
          deletedAt: now,
          version: sql`${documents.version} + 1`,
          updatedAt: now,
        }).where(and(
          eq(documents.id, claimedJob.documentId),
          eq(documents.lifecycle, "pending_deletion"),
          eq(documents.version, claimedJob.generation),
        )).returning({ id: documents.id });
        if (!changedDocument) throw new Error("Purge finalization lost document ownership");

        const deletedCrypto = await transaction.delete(documentCrypto).where(and(
          eq(documentCrypto.documentId, claimedJob.documentId),
          eq(documentCrypto.storageKey, state.storageKey),
        )).returning({ documentId: documentCrypto.documentId });
        if (deletedCrypto.length !== 1) throw new Error("Purge finalization lost crypto metadata");

        await transaction.delete(documentDrafts).where(eq(documentDrafts.documentId, claimedJob.documentId));

        const [completedJob] = await transaction.update(documentJobs).set({
          status: "completed",
          completedAt: now,
          lockedAt: null,
          leaseExpiresAt: null,
          leaseToken: null,
          lastError: null,
          updatedAt: now,
        }).where(and(
          eq(documentJobs.id, claimedJob.id),
          eq(documentJobs.documentId, claimedJob.documentId),
          eq(documentJobs.kind, "purge"),
          eq(documentJobs.generation, claimedJob.generation),
          eq(documentJobs.status, "processing"),
          eq(documentJobs.leaseToken, claimedJob.leaseToken),
        )).returning({ id: documentJobs.id });
        if (!completedJob) throw new Error("Purge finalization lost job ownership");

        await transaction.insert(auditLog).values({
          householdId: record.householdId,
          actorUserId: null,
          entityType: "document",
          entityId: claimedJob.documentId,
          action: "document_purged",
          changes: { itemId: record.itemId, reason: "retention_expired" },
        });
        return true;
      });
    },
  });
  if (outcome === "completed") log.info("document.lifecycle", { document: job.documentId, state: "deleted" });
  if (outcome === "stale") await completeStalePurgeClaim(job);
  return outcome;
}

async function completeStalePurgeClaim(job: ClaimedDocumentJob): Promise<void> {
  await getDb().transaction(async (transaction) => {
    const activeClaims = await transaction.execute(sql<{ id: string }>`
      select id
      from document_jobs
      where id = ${job.id}
        and document_id = ${job.documentId}
        and kind = 'purge'
        and generation = ${job.generation}
        and status = 'processing'
        and lease_token = ${job.leaseToken}::uuid
      for update
    `);
    if (activeClaims.length === 0) return;
    const [document] = await transaction.execute(sql<{ lifecycle: string; generation: number }>`
      select lifecycle, version as generation
      from documents
      where id = ${job.documentId}
      for update
    `);
    if (document?.lifecycle === "pending_deletion" && document.generation === job.generation) return;
    await transaction.update(documentJobs).set({
      status: "completed",
      completedAt: new Date(),
      lockedAt: null,
      leaseExpiresAt: null,
      leaseToken: null,
      lastError: null,
      updatedAt: new Date(),
    }).where(and(
      eq(documentJobs.id, job.id),
      eq(documentJobs.status, "processing"),
      eq(documentJobs.generation, job.generation),
      eq(documentJobs.leaseToken, job.leaseToken),
    ));
  });
}

async function failJob(job: ClaimedDocumentJob, error: unknown): Promise<void> {
  const [current] = await getDb().select({ attempts: documentJobs.attempts })
    .from(documentJobs)
    .where(and(
      eq(documentJobs.id, job.id),
      eq(documentJobs.status, "processing"),
      eq(documentJobs.leaseToken, job.leaseToken),
    ))
    .limit(1);
  if (!current) return;
  const safeCode = error instanceof Error && /key|secret/i.test(error.message)
    ? "key_unavailable"
    : "purge_failed";
  const exhausted = current.attempts >= 5;
  log.warn("document.job", {
    document: job.documentId,
    job: job.id,
    kind: "purge",
    outcome: exhausted ? "failed" : "retry",
    reason: safeCode,
    attempts: current.attempts,
  });
  await getDb().update(documentJobs).set({
    status: exhausted ? "failed" : "retry",
    lockedAt: null,
    leaseExpiresAt: null,
    leaseToken: null,
    lastError: safeCode,
    updatedAt: new Date(),
  }).where(and(
    eq(documentJobs.id, job.id),
    eq(documentJobs.status, "processing"),
    eq(documentJobs.leaseToken, job.leaseToken),
  ));
}

async function rejectInterruptedDocuments(): Promise<void> {
  const staleBoundary = new Date(Date.now() - 60 * 60 * 1_000);
  const rejected = await getDb().update(documents).set({
    lifecycle: "rejected",
    failureCode: "processing_interrupted",
    updatedAt: new Date(),
  }).where(and(
    inArray(documents.lifecycle, ["receiving", "validating", "quarantined", "encrypting"]),
    lt(documents.updatedAt, staleBoundary),
  )).returning({ id: documents.id });
  // A document stranded mid-pipeline is the visible symptom of a processor
  // outage, so each one is recorded rather than only counted.
  for (const document of rejected) {
    log.warn("document.lifecycle", {
      document: document.id,
      state: "rejected",
      reason: "processing_interrupted",
    });
  }
}

export async function reconcileDocumentStorage(): Promise<void> {
  const config = getDocumentConfig();
  const storage = new LocalDocumentStorage(config.storageRoot, config.quarantineRoot);
  const staleBoundary = new Date(Date.now() - 60 * 60 * 1_000);
  await getDb().update(documents).set({ lifecycle: "rejected", failureCode: "processing_interrupted", updatedAt: new Date() }).where(and(
    eq(documents.lifecycle, "scanning"),
    lt(documents.updatedAt, staleBoundary),
    sql`not exists (select 1 from document_staging_objects stage where stage.document_id = ${documents.id})`,
  ));
  const records = await getDb()
    .select({
      documentId: documents.id,
      householdId: documents.householdId,
      itemId: documents.itemId,
      lifecycle: documents.lifecycle,
      storageKey: documentCrypto.storageKey,
    })
    .from(documents)
    .leftJoin(documentCrypto, eq(documentCrypto.documentId, documents.id))
    .where(inArray(documents.lifecycle, ["available", "pending_deletion"]));

  const referencedKeys = new Set(records.flatMap((record) => record.storageKey ? [record.storageKey] : []));
  for (const record of records) {
    if (!record.storageKey) {
      // Available documents without an envelope cannot be opened and must not
      // remain user-visible. Pending purges retain their durable evidence for
      // the job retry path instead of being rewritten as a new rejection.
      if (record.lifecycle === "pending_deletion") continue;
      const rejected = await getDb().transaction(async (transaction) => {
        const [changed] = await transaction.update(documents).set({
          lifecycle: "rejected",
          failureCode: "crypto_metadata_missing",
          updatedAt: new Date(),
        }).where(and(
          eq(documents.id, record.documentId),
          eq(documents.lifecycle, "available"),
        )).returning({ id: documents.id });
        if (!changed) return false;
        await transaction.insert(auditLog).values({
          householdId: record.householdId,
          actorUserId: null,
          entityType: "document",
          entityId: record.documentId,
          action: "document_crypto_missing",
          changes: { itemId: record.itemId },
        });
        return true;
      });
      if (rejected) {
        log.warn("document.lifecycle", { document: record.documentId, state: "rejected", reason: "crypto_metadata_missing" });
      }
      continue;
    }
    let ciphertextExists = false;
    try {
      ciphertextExists = await storage.ciphertextExists(record.storageKey);
    } catch {
      if (record.lifecycle === "pending_deletion") continue;
      const rejected = await getDb().transaction(async (transaction) => {
        const [changed] = await transaction.update(documents).set({
          lifecycle: "rejected",
          failureCode: "storage_object_invalid",
          updatedAt: new Date(),
        }).where(and(
          eq(documents.id, record.documentId),
          eq(documents.lifecycle, "available"),
        )).returning({ id: documents.id });
        if (!changed) return false;
        await transaction.insert(auditLog).values({
          householdId: record.householdId,
          actorUserId: null,
          entityType: "document",
          entityId: record.documentId,
          action: "document_storage_invalid",
          changes: { itemId: record.itemId },
        });
        return true;
      });
      if (rejected) {
        log.warn("document.lifecycle", { document: record.documentId, state: "rejected", reason: "storage_object_invalid" });
      }
      continue;
    }
    if (ciphertextExists) continue;
    // A pending purge may have removed ciphertext before its finalization
    // transaction. Preserve that durable retry evidence for the next claim.
    if (record.lifecycle === "pending_deletion") continue;
    const reconciliationOutcome = await reconcileMissingDocument(record, {
      withDocumentLock: async (documentId, work) => getDb().transaction(async (transaction) => {
        await transaction.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${`orbit:document:${documentId}`}, 0))`,
        );
        return work({
          readCurrentLifecycle: async (currentDocumentId) => {
            const records = await transaction.execute(sql<{ lifecycle: string }>`
              select lifecycle
              from documents
              where id = ${currentDocumentId}
              for update
            `) as unknown as Array<{ lifecycle: string }>;
            return records[0]?.lifecycle;
          },
          rejectAvailableDocument: async (snapshot) => {
            const [rejected] = await transaction.update(documents).set({
              lifecycle: "rejected",
              failureCode: "storage_object_missing",
              updatedAt: new Date(),
            }).where(and(
              eq(documents.id, snapshot.documentId),
              eq(documents.lifecycle, "available"),
            )).returning({ id: documents.id });
            if (!rejected) return false;
            await transaction.insert(auditLog).values({
              householdId: snapshot.householdId,
              actorUserId: null,
              entityType: "document",
              entityId: snapshot.documentId,
              action: "document_storage_missing",
              changes: { itemId: snapshot.itemId },
            });
            return true;
          },
        });
      }),
    });
    if (reconciliationOutcome === "rejected") {
      log.warn("document.lifecycle", { document: record.documentId, state: "rejected", reason: "storage_object_missing" });
    }
  }

  const orphanBoundary = Date.now() - 24 * 60 * 60 * 1_000;
  for (const object of await storage.listCiphertextObjects()) {
    if (!referencedKeys.has(object.storageKey) && object.modifiedAt.getTime() < orphanBoundary) {
      await storage.deleteCiphertext(object.storageKey);
    }
  }
  const referencedStagingKeys = new Set((await getDb().select({ storageKey: documentStagingObjects.storageKey }).from(documentStagingObjects)).map((row) => row.storageKey));
  for (const object of await storage.listStagingObjects()) {
    if (!referencedStagingKeys.has(object.storageKey) && object.modifiedAt.getTime() < orphanBoundary) {
      await storage.deleteStagingCiphertext(object.storageKey);
    }
  }
  for (const quarantine of await storage.listQuarantineFiles()) {
    if (quarantine.modifiedAt.getTime() < orphanBoundary) await storage.discardQuarantine(quarantine.path);
  }
  workerState.__orbitDocumentWorkerLastReconciliationAt = new Date().toISOString();
}

export async function runDocumentMaintenanceCycle(): Promise<void> {
  await rejectInterruptedDocuments();
  await expireScannerRecoveryStages();
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
    log.info("document.job", { document: job.documentId, job: job.id, kind: "scan", outcome: job.previousStatus === "processing" ? "reclaimed" : "claimed" });
    try {
      await processScannerRecoveryJob(job);
    } catch {
      await failScannerRecoveryJob(job, "scanner_failed");
    }
  }
  const jobs = await claimExpiredPurgeJobs();
  for (const job of jobs) {
    log.info("document.job", { document: job.documentId, job: job.id, kind: "purge", outcome: purgeClaimOutcome(job.previousStatus) });
    try {
      const outcome = await processPurgeJob(job);
      log.info("document.job", { document: job.documentId, job: job.id, kind: "purge", outcome });
    } catch (error) {
      await failJob(job, error);
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
    } catch {
      workerState.__orbitDocumentWorkerLastErrorAt = new Date().toISOString();
      workerState.__orbitDocumentWorkerLastErrorCode = "maintenance_cycle_failed";
      // The cause is deliberately not logged: it may carry storage paths or
      // provider text. The health endpoint exposes the bounded failure code.
      log.error("document.worker", { outcome: "cycle_failed" });
    } finally {
      workerState.__orbitDocumentWorkerRunning = false;
      setTimeout(poll, pollMilliseconds).unref();
    }
  };
  void poll();
}
