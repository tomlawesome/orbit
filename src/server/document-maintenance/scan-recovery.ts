/**
 * The scanner-recovery seam: claim a scan job, scan the staged bytes, and
 * publish only a clean result (#299).
 *
 * The order is the fail-closed one ADR-0010 fixes and must not be rearranged.
 * The claim takes a ten-minute lease and a fresh lease token; every later
 * write re-checks that token and the document generation. The staged
 * ciphertext is decrypted under the `scanner_recovery` purpose, written to
 * quarantine, scanned, and the quarantine copy discarded before anything
 * else. Only a `clean` result reaches encryption, a ciphertext write and the
 * publish transaction; a retryable outage reschedules the job, and every
 * other outcome ends the recovery terminally with the stage purged.
 */
import { and, eq, inArray, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { auditLog, documentCrypto, documentJobs, documentStagingObjects, documents, reviewedIntakeOperations } from "@/db/schema";
import { log } from "@/lib/logger";
import { getDocumentConfig, keyEncryptionKeyFor } from "@/server/documents/config";
import { LocalDocumentStorage } from "@/server/documents/storage";
import { decryptDocument, encryptDocument, type DocumentCryptoEnvelope } from "@/server/documents/crypto";
import { scanFileWithClamAv } from "@/server/documents/scanner";
import {
  isScannerRecoveryExpired,
  retryableScannerFailureCode,
  scannerRecoveryDelayMs,
  SCANNER_RECOVERY_MAX_ATTEMPTS,
} from "@/server/documents/staging";
import {
  operationalDocumentReason,
  type ClaimedScanJob,
  type ScanRecoveryRecord,
} from "@/server/document-maintenance/claims";
import {
  completeStagingPurge,
  markStagingPurgeFailure,
  purgeScannerStage,
} from "@/server/document-maintenance/staging-purge";

export async function claimScannerRecoveryJobs(limit = 25): Promise<ClaimedScanJob[]> {
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

export async function failScannerRecoveryJob(job: ClaimedScanJob, failureCode: string): Promise<void> {
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
  log.warn({
    event: "document.job",
    state: exhausted ? "exhausted" : "retrying",
    reason: operationalDocumentReason(failureCode),
    action: exhausted ? "inspect_admin_diagnostics" : "retry_job",
    impact: "document_processing_blocked",
  });
}

export async function processScannerRecoveryJob(job: ClaimedScanJob): Promise<void> {
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
    // Picks by the staged object's own key_id (#954): held staging objects
    // outlive a poll cycle (up to `scanRecoveryRetentionHours`), long enough
    // to span a rotation window.
    const stagingKek = keyEncryptionKeyFor(config, record.keyId);
    if (!stagingKek) throw new Error("staging object's key is not held by this instance");
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
    } as DocumentCryptoEnvelope, stagingKek);
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
      log.warn({
        event: "document.job",
        state: "retrying",
        reason: "stage_purge_failed",
        action: "retry_job",
        impact: "document_processing_blocked",
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
