/**
 * The retention-purge seam: claim an expired document and destroy it (#299).
 *
 * The irreversible ordering lives in `processOwnedPurge`
 * (src/server/documents/purge.ts); this module is the database and storage
 * driver behind it. Ownership is re-read under the claim's generation and
 * lease token, the ciphertext is deleted, and only then may the metadata
 * transaction finalize — a terminal row must never point at bytes.
 */
import { and, eq, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { auditLog, documentCrypto, documentDrafts, documentJobs, documents } from "@/db/schema";
import { log } from "@/lib/logger";
import { openDocumentStorage, STORAGE_KEY_PATTERN } from "@/server/documents/storage";
import { processOwnedPurge, type OwnedPurgeState } from "@/server/documents/purge";
import {
  completeJob,
  failJob,
  holdsJobLease,
  JOB_CLAIM_UPDATE,
  jobFailureCode,
  type ClaimedDocumentJob,
} from "@/server/document-maintenance/claims";

const PURGE_MAX_ATTEMPTS = 5;

interface OwnedPurgeRecord {
  householdId: string;
  itemId: string | null;
  lifecycle: string;
  generation: number;
  storageKey: string | null;
}

export async function claimExpiredPurgeJobs(limit = 25): Promise<ClaimedDocumentJob[]> {
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
      ${JOB_CLAIM_UPDATE}
    )
    select claimed.id, claimed.document_id as "documentId", claimed.generation,
      claimed.lease_token as "leaseToken", claimable.previous_status as "previousStatus"
    from claimed
    inner join claimable on claimable.id = claimed.id
  `);
  return rows as unknown as ClaimedDocumentJob[];
}

export async function processPurgeJob(job: ClaimedDocumentJob): Promise<"completed" | "stale"> {
  const storage = openDocumentStorage();
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
        if (!record.storageKey || !STORAGE_KEY_PATTERN.test(record.storageKey)) {
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

        const completedJob = await completeJob(transaction, and(
          holdsJobLease(claimedJob),
          eq(documentJobs.documentId, claimedJob.documentId),
          eq(documentJobs.kind, "purge"),
          eq(documentJobs.generation, claimedJob.generation),
        ), { now });
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
  if (outcome === "completed") log.info({ event: "document.lifecycle", state: "completed", action: "none" });
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
    await completeJob(transaction, and(holdsJobLease(job), eq(documentJobs.generation, job.generation)));
  });
}

export async function failPurgeJob(job: ClaimedDocumentJob, error: unknown): Promise<void> {
  await failJob({
    db: getDb(),
    owns: holdsJobLease(job),
    code: jobFailureCode(error, "purge_failed"),
    maxAttempts: PURGE_MAX_ATTEMPTS,
  });
}
