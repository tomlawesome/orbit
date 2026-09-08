/**
 * The reconcile seam: make the database and the document volume agree (#299).
 *
 * It strands uploads interrupted mid-flight, rejects available documents whose
 * envelope or ciphertext has gone, and deletes unreferenced objects older than
 * a day from the object, staging and quarantine namespaces. Pending purges are
 * deliberately preserved rather than rewritten: their durable evidence is what
 * the purge job's retry depends on.
 */
import { and, eq, inArray, lt, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { auditLog, documentCrypto, documentStagingObjects, documents } from "@/db/schema";
import { log } from "@/lib/logger";
import { getDocumentConfig } from "@/server/documents/config";
import { LocalDocumentStorage } from "@/server/documents/storage";
import { reconcileMissingDocument } from "@/server/documents/reconciliation";
import { workerState } from "@/server/document-maintenance/worker-state";

export async function rejectInterruptedDocuments(): Promise<void> {
  const staleBoundary = new Date(Date.now() - 60 * 60 * 1_000);
  const rejected = await getDb().update(documents).set({
    lifecycle: "rejected",
    failureCode: "processing_interrupted",
    updatedAt: new Date(),
  }).where(and(
    inArray(documents.lifecycle, ["receiving", "validating", "quarantined", "encrypting"]),
    lt(documents.updatedAt, staleBoundary),
  )).returning({ id: documents.id });
  // A stranded item is represented by one bounded transition; identifiers are
  // intentionally excluded and the shared logger deduplicates repeated items.
  if (rejected.length > 0) {
    log.warn({
      event: "document.lifecycle",
      state: "exhausted",
      reason: "processing_interrupted",
      action: "inspect_admin_diagnostics",
      impact: "document_processing_blocked",
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
        log.warn({ event: "document.lifecycle", state: "exhausted", reason: "crypto_metadata_missing", action: "inspect_admin_diagnostics", impact: "document_processing_blocked" });
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
        log.warn({ event: "document.lifecycle", state: "exhausted", reason: "storage_object_invalid", action: "inspect_admin_diagnostics", impact: "document_processing_blocked" });
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
      log.warn({ event: "document.lifecycle", state: "exhausted", reason: "storage_object_missing", action: "inspect_admin_diagnostics", impact: "document_processing_blocked" });
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
