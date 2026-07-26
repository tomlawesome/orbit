import { and, eq, inArray, lt, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { auditLog, documentCrypto, documentJobs, documents } from "@/db/schema";
import { getDocumentConfig } from "@/server/documents/config";
import { LocalDocumentStorage } from "@/server/documents/storage";

interface ClaimedDocumentJob {
  id: string;
  documentId: string;
  leaseToken: string;
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
    returning job.id, job.document_id as "documentId", job.lease_token as "leaseToken"
  `);
  return rows as unknown as ClaimedDocumentJob[];
}

async function processPurgeJob(job: ClaimedDocumentJob): Promise<void> {
  await getDb().transaction(async (transaction) => {
    await transaction.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`orbit:document:${job.documentId}`}, 0))`,
    );
    // Lock and verify ownership before any irreversible storage operation.
    const activeClaims = await transaction.execute(sql<{ id: string }>`
      select id
      from document_jobs
      where id = ${job.id}
        and status = 'processing'
        and lease_token = ${job.leaseToken}::uuid
      for update
    `);
    if (activeClaims.length === 0) return;

    const [record] = await transaction
      .select({
        householdId: documents.householdId,
        itemId: documents.itemId,
        lifecycle: documents.lifecycle,
        storageKey: documentCrypto.storageKey,
      })
      .from(documents)
      .leftJoin(documentCrypto, eq(documentCrypto.documentId, documents.id))
      .where(eq(documents.id, job.documentId))
      .limit(1);
    if (!record || record.lifecycle !== "pending_deletion") {
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
        eq(documentJobs.leaseToken, job.leaseToken),
      ));
      return;
    }

    if (record.storageKey) {
      const config = getDocumentConfig();
      await new LocalDocumentStorage(config.storageRoot, config.quarantineRoot)
        .deleteCiphertext(record.storageKey);
    }
    await transaction.delete(documentCrypto).where(eq(documentCrypto.documentId, job.documentId));
    await transaction.update(documents).set({
      lifecycle: "deleted",
      deletedAt: new Date(),
      version: sql`${documents.version} + 1`,
      updatedAt: new Date(),
    }).where(and(eq(documents.id, job.documentId), eq(documents.lifecycle, "pending_deletion")));
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
      eq(documentJobs.leaseToken, job.leaseToken),
    ));
    await transaction.insert(auditLog).values({
      householdId: record.householdId,
      actorUserId: null,
      entityType: "document",
      entityId: job.documentId,
      action: "document_purged",
      changes: { itemId: record.itemId, reason: "retention_expired" },
    });
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

async function reconcileDocumentStorage(): Promise<void> {
  const config = getDocumentConfig();
  const storage = new LocalDocumentStorage(config.storageRoot, config.quarantineRoot);
  const records = await getDb()
    .select({
      documentId: documents.id,
      householdId: documents.householdId,
      itemId: documents.itemId,
      storageKey: documentCrypto.storageKey,
    })
    .from(documents)
    .innerJoin(documentCrypto, eq(documentCrypto.documentId, documents.id))
    .where(inArray(documents.lifecycle, ["available", "pending_deletion"]));

  const referencedKeys = new Set(records.map((record) => record.storageKey));
  for (const record of records) {
    if (await storage.ciphertextExists(record.storageKey)) continue;
    await getDb().transaction(async (transaction) => {
      await transaction.update(documents).set({
        lifecycle: "rejected",
        failureCode: "storage_object_missing",
        updatedAt: new Date(),
      }).where(and(
        eq(documents.id, record.documentId),
        inArray(documents.lifecycle, ["available", "pending_deletion"]),
      ));
      await transaction.insert(auditLog).values({
        householdId: record.householdId,
        actorUserId: null,
        entityType: "document",
        entityId: record.documentId,
        action: "document_storage_missing",
        changes: { itemId: record.itemId },
      });
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
  const lastReconciliation = workerState.__orbitDocumentWorkerLastReconciliationAt
    ? Date.parse(workerState.__orbitDocumentWorkerLastReconciliationAt)
    : 0;
  if (!Number.isFinite(lastReconciliation) || Date.now() - lastReconciliation >= 15 * 60 * 1_000) {
    await reconcileDocumentStorage();
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
