import { and, eq, inArray, lt, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { auditLog, documentCrypto, documentJobs, documents } from "@/db/schema";
import { getDocumentConfig } from "@/server/documents/config";
import { LocalDocumentStorage } from "@/server/documents/storage";
import { processOwnedPurge, type OwnedPurgeJob, type OwnedPurgeState } from "@/server/documents/purge";
import { reconcileMissingDocument } from "@/server/documents/reconciliation";
import { purgeExpiredPortableArchives, reconcilePortableArchiveStorage } from "@/server/portable-archive-repository";
import { purgeExpiredHouseholds } from "@/server/household-lifecycle";

type ClaimedDocumentJob = OwnedPurgeJob;

interface OwnedPurgeRecord {
  householdId: string;
  itemId: string | null;
  lifecycle: string;
  generation: number;
  storageKey: string | null;
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
    with claimable as (
      select job.id
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
    )
    update document_jobs as job
    set status = 'processing',
        attempts = job.attempts + 1,
        locked_at = now(),
        lease_expires_at = now() + interval '10 minutes',
        lease_token = gen_random_uuid(),
        updated_at = now()
    from claimable
    where job.id = claimable.id
    returning job.id, job.document_id as "documentId", job.generation, job.lease_token as "leaseToken"
  `);
  return rows as unknown as ClaimedDocumentJob[];
}

async function processPurgeJob(job: ClaimedDocumentJob): Promise<void> {
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
  if (outcome === "stale") await completeStalePurgeClaim(job);
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
  await getDb().update(documentJobs).set({
    status: current.attempts >= 5 ? "failed" : "retry",
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
  await getDb().update(documents).set({
    lifecycle: "rejected",
    failureCode: "processing_interrupted",
    updatedAt: new Date(),
  }).where(and(
    inArray(documents.lifecycle, ["receiving", "validating", "quarantined", "scanning", "encrypting"]),
    lt(documents.updatedAt, staleBoundary),
  ));
}

export async function reconcileDocumentStorage(): Promise<void> {
  const config = getDocumentConfig();
  const storage = new LocalDocumentStorage(config.storageRoot, config.quarantineRoot);
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
      await getDb().transaction(async (transaction) => {
        const [rejected] = await transaction.update(documents).set({
          lifecycle: "rejected",
          failureCode: "crypto_metadata_missing",
          updatedAt: new Date(),
        }).where(and(
          eq(documents.id, record.documentId),
          eq(documents.lifecycle, "available"),
        )).returning({ id: documents.id });
        if (!rejected) return;
        await transaction.insert(auditLog).values({
          householdId: record.householdId,
          actorUserId: null,
          entityType: "document",
          entityId: record.documentId,
          action: "document_crypto_missing",
          changes: { itemId: record.itemId },
        });
      });
      continue;
    }
    let ciphertextExists = false;
    try {
      ciphertextExists = await storage.ciphertextExists(record.storageKey);
    } catch {
      if (record.lifecycle === "pending_deletion") continue;
      await getDb().transaction(async (transaction) => {
        const [rejected] = await transaction.update(documents).set({
          lifecycle: "rejected",
          failureCode: "storage_object_invalid",
          updatedAt: new Date(),
        }).where(and(
          eq(documents.id, record.documentId),
          eq(documents.lifecycle, "available"),
        )).returning({ id: documents.id });
        if (!rejected) return;
        await transaction.insert(auditLog).values({
          householdId: record.householdId,
          actorUserId: null,
          entityType: "document",
          entityId: record.documentId,
          action: "document_storage_invalid",
          changes: { itemId: record.itemId },
        });
      });
      continue;
    }
    if (ciphertextExists) continue;
    // A pending purge may have removed ciphertext before its finalization
    // transaction. Preserve that durable retry evidence for the next claim.
    if (record.lifecycle === "pending_deletion") continue;
    await reconcileMissingDocument(record, {
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
  }

  const orphanBoundary = Date.now() - 24 * 60 * 60 * 1_000;
  for (const object of await storage.listCiphertextObjects()) {
    if (!referencedKeys.has(object.storageKey) && object.modifiedAt.getTime() < orphanBoundary) {
      await storage.deleteCiphertext(object.storageKey);
    }
  }
  workerState.__orbitDocumentWorkerLastReconciliationAt = new Date().toISOString();
}

export async function runDocumentMaintenanceCycle(): Promise<void> {
  await rejectInterruptedDocuments();
  await purgeExpiredPortableArchives();
  await purgeExpiredHouseholds();
  const lastReconciliation = workerState.__orbitDocumentWorkerLastReconciliationAt
    ? Date.parse(workerState.__orbitDocumentWorkerLastReconciliationAt)
    : 0;
  if (!Number.isFinite(lastReconciliation) || Date.now() - lastReconciliation >= 15 * 60 * 1_000) {
    await reconcileDocumentStorage();
    await reconcilePortableArchiveStorage();
  }
  const jobs = await claimExpiredPurgeJobs();
  for (const job of jobs) {
    try {
      await processPurgeJob(job);
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
      console.error("Orbit document maintenance cycle failed");
    } finally {
      workerState.__orbitDocumentWorkerRunning = false;
      setTimeout(poll, pollMilliseconds).unref();
    }
  };
  void poll();
}
