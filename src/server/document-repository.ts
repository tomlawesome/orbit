import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray, notInArray, sql } from "drizzle-orm";
import { getDb } from "@/db";
import {
  auditLog,
  documentCrypto,
  documentJobs,
  documents,
  households,
  items,
  memberships,
  users,
} from "@/db/schema";
import { AppError } from "@/lib/app-error";
import { decryptDocument, encryptDocument, type DocumentCryptoEnvelope } from "@/server/documents/crypto";
import { getDocumentConfig } from "@/server/documents/config";
import { scanFileWithClamAv } from "@/server/documents/scanner";
import { LocalDocumentStorage } from "@/server/documents/storage";
import { detectDocumentMediaType, normalizedDocumentFilename } from "@/server/documents/validation";
import { canAccessHouseholdDocuments } from "@/server/documents/authorization";

export interface DocumentSummary {
  id: string;
  itemId: string | null;
  displayName: string;
  mediaType: string;
  sizeBytes: number;
  lifecycle: "available" | "pending_deletion";
  scanStatus: "clean" | "skipped";
  availableAt: string | null;
  deleteAfter: string | null;
}

const unavailableDocumentConditions = ["deleted", "rejected"] as const;

function documentStorage(): LocalDocumentStorage {
  const config = getDocumentConfig();
  return new LocalDocumentStorage(config.storageRoot, config.quarantineRoot);
}

async function requireHouseholdAndItemAccess(
  userId: string,
  householdId: string,
  itemId: string,
): Promise<void> {
  const [access] = await getDb()
    .select({
      itemId: items.id,
      administrator: users.isInstanceAdmin,
      membershipUserId: memberships.userId,
    })
    .from(users)
    .innerJoin(items, and(eq(items.id, itemId), eq(items.householdId, householdId)))
    .innerJoin(households, eq(households.id, items.householdId))
    .leftJoin(
      memberships,
      and(eq(memberships.userId, users.id), eq(memberships.householdId, householdId)),
    )
    .where(eq(users.id, userId))
    .limit(1);
  if (!access || !canAccessHouseholdDocuments(access.administrator, access.membershipUserId)) {
    throw new AppError("item_not_found", "That item is not available", 404);
  }
}

async function requireDocumentAccess(userId: string, documentId: string) {
  const [record] = await getDb()
    .select({
      id: documents.id,
      householdId: documents.householdId,
      itemId: documents.itemId,
      displayName: documents.displayName,
      mediaType: documents.mediaType,
      sizeBytes: documents.sizeBytes,
      lifecycle: documents.lifecycle,
      scanStatus: documents.scanStatus,
      contentSha256: documents.contentSha256,
      deleteAfter: documents.deleteAfter,
      availableAt: documents.availableAt,
      administrator: users.isInstanceAdmin,
      membershipUserId: memberships.userId,
    })
    .from(users)
    .innerJoin(documents, eq(documents.id, documentId))
    .leftJoin(
      memberships,
      and(eq(memberships.userId, users.id), eq(memberships.householdId, documents.householdId)),
    )
    .where(eq(users.id, userId))
    .limit(1);
  if (
    !record
    || !canAccessHouseholdDocuments(record.administrator, record.membershipUserId)
    || unavailableDocumentConditions.includes(record.lifecycle as typeof unavailableDocumentConditions[number])
  ) {
    throw new AppError("document_not_found", "That document is not available", 404);
  }
  return record;
}

function toSummary(record: {
  id: string;
  itemId: string | null;
  displayName: string;
  mediaType: string;
  sizeBytes: number;
  lifecycle: string;
  scanStatus: string;
  availableAt: Date | null;
  deleteAfter: Date | null;
}): DocumentSummary {
  if (
    (record.lifecycle !== "available" && record.lifecycle !== "pending_deletion")
    || (record.scanStatus !== "clean" && record.scanStatus !== "skipped")
  ) {
    throw new Error("Document is not in a user-visible state");
  }
  return {
    id: record.id,
    itemId: record.itemId,
    displayName: record.displayName,
    mediaType: record.mediaType,
    sizeBytes: record.sizeBytes,
    lifecycle: record.lifecycle,
    scanStatus: record.scanStatus,
    availableAt: record.availableAt?.toISOString() ?? null,
    deleteAfter: record.deleteAfter?.toISOString() ?? null,
  };
}

async function recordDocumentAudit(
  householdId: string,
  documentId: string,
  actorUserId: string,
  action: string,
  changes: Record<string, unknown>,
): Promise<void> {
  await getDb().insert(auditLog).values({
    householdId,
    actorUserId,
    entityType: "document",
    entityId: documentId,
    action,
    changes,
  });
}

export async function listItemDocuments(
  userId: string,
  householdId: string,
  itemId: string,
): Promise<DocumentSummary[]> {
  await requireHouseholdAndItemAccess(userId, householdId, itemId);
  const rows = await getDb()
    .select({
      id: documents.id,
      itemId: documents.itemId,
      displayName: documents.displayName,
      mediaType: documents.mediaType,
      sizeBytes: documents.sizeBytes,
      lifecycle: documents.lifecycle,
      scanStatus: documents.scanStatus,
      availableAt: documents.availableAt,
      deleteAfter: documents.deleteAfter,
    })
    .from(documents)
    .where(and(
      eq(documents.householdId, householdId),
      eq(documents.itemId, itemId),
      inArray(documents.lifecycle, ["available", "pending_deletion"]),
    ))
    .orderBy(desc(documents.createdAt));
  return rows.map(toSummary);
}

async function reserveDocumentMetadata(input: {
  documentId: string;
  userId: string;
  householdId: string;
  itemId: string;
  displayName: string;
  mediaType: string;
  sizeBytes: number;
  contentSha256: string;
  scanStatus: "pending" | "skipped";
}): Promise<void> {
  const config = getDocumentConfig();
  await getDb().transaction(async (transaction) => {
    await transaction.execute(sql`select pg_advisory_xact_lock(hashtextextended('orbit:document-instance-quota', 0))`);
    await transaction.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`orbit:document-household-quota:${input.householdId}`}, 0))`,
    );
    const excluded: Array<"deleted" | "rejected"> = ["deleted", "rejected"];
    const [[instanceUsage], [householdUsage]] = await Promise.all([
      transaction.select({ total: sql<number>`coalesce(sum(${documents.sizeBytes}), 0)` })
        .from(documents)
        .where(notInArray(documents.lifecycle, excluded)),
      transaction.select({ total: sql<number>`coalesce(sum(${documents.sizeBytes}), 0)` })
        .from(documents)
        .where(and(eq(documents.householdId, input.householdId), notInArray(documents.lifecycle, excluded))),
    ]);
    if (Number(instanceUsage.total) + input.sizeBytes > config.instanceQuotaBytes) {
      throw new AppError("document_instance_quota", "Orbit document storage has reached its configured limit", 413);
    }
    if (Number(householdUsage.total) + input.sizeBytes > config.householdQuotaBytes) {
      throw new AppError("document_household_quota", "This household has reached its document storage limit", 413);
    }
    await transaction.insert(documents).values({
      id: input.documentId,
      householdId: input.householdId,
      itemId: input.itemId,
      uploadedByUserId: input.userId,
      displayName: input.displayName,
      mediaType: input.mediaType,
      sizeBytes: input.sizeBytes,
      contentSha256: input.contentSha256,
      lifecycle: "quarantined",
      scanStatus: input.scanStatus,
    });
  });
}

export async function uploadItemDocument(input: {
  userId: string;
  householdId: string;
  itemId: string;
  filename: string;
  body: ReadableStream<Uint8Array> | null;
  declaredBytes?: number;
  documentId?: string;
}): Promise<DocumentSummary> {
  await requireHouseholdAndItemAccess(input.userId, input.householdId, input.itemId);
  const config = getDocumentConfig();
  const storage = documentStorage();
  const documentId = input.documentId ?? randomUUID();
  if (input.documentId) {
    const [existing] = await getDb().select({
      id: documents.id,
      itemId: documents.itemId,
      householdId: documents.householdId,
      displayName: documents.displayName,
      mediaType: documents.mediaType,
      sizeBytes: documents.sizeBytes,
      lifecycle: documents.lifecycle,
      scanStatus: documents.scanStatus,
      availableAt: documents.availableAt,
      deleteAfter: documents.deleteAfter,
    }).from(documents).where(eq(documents.id, input.documentId)).limit(1);
    if (existing) {
      if (existing.householdId !== input.householdId || existing.itemId !== input.itemId) {
        throw new AppError("document_conflict", "That document identity is already in use", 409);
      }
      if (existing.lifecycle === "available") return toSummary(existing);
      if (existing.lifecycle === "rejected") {
        const [cryptoRecord] = await getDb().select({ documentId: documentCrypto.documentId }).from(documentCrypto)
          .where(eq(documentCrypto.documentId, input.documentId)).limit(1);
        if (cryptoRecord) throw new AppError("document_conflict", "That document identity is already in use", 409);
        const [removed] = await getDb().delete(documents)
          .where(and(eq(documents.id, input.documentId), eq(documents.householdId, input.householdId), eq(documents.itemId, input.itemId), eq(documents.lifecycle, "rejected")))
          .returning({ id: documents.id });
        if (!removed) throw new AppError("document_upload_recoverable", "That document upload needs recovery", 503);
      } else {
        throw new AppError("document_upload_recoverable", "That document upload needs recovery", 503);
      }
    }
  }
  const received = await storage.receive(input.body, documentId, config.maxBytes, input.declaredBytes);
  let storageKey: string | undefined;
  let metadataReserved = false;
  try {
    const mediaType = detectDocumentMediaType(received.leadingBytes);
    const displayName = normalizedDocumentFilename(input.filename, mediaType);
    await reserveDocumentMetadata({
      documentId,
      userId: input.userId,
      householdId: input.householdId,
      itemId: input.itemId,
      displayName,
      mediaType,
      sizeBytes: received.sizeBytes,
      contentSha256: received.contentSha256,
      scanStatus: config.scanMode === "disabled" ? "skipped" : "pending",
    });
    metadataReserved = true;

    if (config.scanMode === "required") {
      await getDb().update(documents).set({ lifecycle: "scanning", updatedAt: new Date() })
        .where(and(eq(documents.id, documentId), eq(documents.lifecycle, "quarantined")));
      const scan = await scanFileWithClamAv(received.quarantinePath, config.clamAv);
      if (scan.status !== "clean") {
        const infected = scan.status === "infected";
        await getDb().update(documents).set({
          lifecycle: "rejected",
          scanStatus: infected ? "infected" : "error",
          failureCode: infected ? "malware_detected" : `scanner_${scan.reason}`,
          updatedAt: new Date(),
        }).where(eq(documents.id, documentId));
        await recordDocumentAudit(
          input.householdId,
          documentId,
          input.userId,
          infected ? "document_rejected_malware" : "document_rejected_scanner",
          { itemId: input.itemId },
        );
        throw new AppError(
          infected ? "document_malware_detected" : "document_scanner_unavailable",
          infected ? "Orbit rejected that document because malware was detected" : "Document scanning is temporarily unavailable",
          infected ? 422 : 503,
        );
      }
      await getDb().update(documents).set({ scanStatus: "clean", lifecycle: "encrypting", updatedAt: new Date() })
        .where(eq(documents.id, documentId));
    } else {
      await getDb().update(documents).set({ lifecycle: "encrypting", updatedAt: new Date() })
        .where(eq(documents.id, documentId));
    }

    const plaintext = await storage.readQuarantine(received.quarantinePath, config.maxBytes);
    let encrypted: ReturnType<typeof encryptDocument>;
    try {
      encrypted = encryptDocument(plaintext, {
        documentId,
        householdId: input.householdId,
        itemId: input.itemId,
        mediaType,
        plaintextSize: received.sizeBytes,
      }, config.keyEncryptionKey, config.keyId);
    } finally {
      plaintext.fill(0);
    }
    storageKey = storage.createStorageKey();
    await storage.writeCiphertext(storageKey, encrypted.ciphertext);

    const now = new Date();
    await getDb().transaction(async (transaction) => {
      await transaction.insert(documentCrypto).values({
        documentId,
        storageKey: storageKey!,
        ciphertextSize: encrypted.ciphertext.length,
        ...encrypted.envelope,
      });
      await transaction.update(documents).set({
        lifecycle: "available",
        availableAt: now,
        failureCode: null,
        version: sql`${documents.version} + 1`,
        updatedAt: now,
      }).where(and(eq(documents.id, documentId), eq(documents.lifecycle, "encrypting")));
      await transaction.insert(auditLog).values({
        householdId: input.householdId,
        actorUserId: input.userId,
        entityType: "document",
        entityId: documentId,
        action: "document_available",
        changes: {
          itemId: input.itemId,
          sizeBytes: received.sizeBytes,
          mediaType,
          scanStatus: config.scanMode === "disabled" ? "skipped" : "clean",
        },
      });
    });
    return {
      id: documentId,
      itemId: input.itemId,
      displayName,
      mediaType,
      sizeBytes: received.sizeBytes,
      lifecycle: "available",
      scanStatus: config.scanMode === "disabled" ? "skipped" : "clean",
      availableAt: now.toISOString(),
      deleteAfter: null,
    };
  } catch (error) {
    if (storageKey) await storage.deleteCiphertext(storageKey).catch(() => undefined);
    if (metadataReserved && !(error instanceof AppError && error.code.startsWith("document_malware"))) {
      await getDb().update(documents).set({
        lifecycle: "rejected",
        failureCode: error instanceof AppError ? error.code : "processing_failed",
        updatedAt: new Date(),
      }).where(and(eq(documents.id, documentId), notInArray(documents.lifecycle, ["available", "rejected"])))
        .catch(() => undefined);
    }
    throw error;
  } finally {
    await storage.discardQuarantine(received.quarantinePath).catch(() => undefined);
  }
}

export async function readDocumentDownload(
  userId: string,
  documentId: string,
): Promise<{ bytes: Buffer; displayName: string; mediaType: string }> {
  const record = await requireDocumentAccess(userId, documentId);
  if (record.lifecycle !== "available" || !record.itemId) {
    throw new AppError("document_not_found", "That document is not available", 404);
  }
  const [crypto] = await getDb().select().from(documentCrypto).where(eq(documentCrypto.documentId, documentId)).limit(1);
  if (!crypto) throw new AppError("document_unavailable", "That document cannot currently be opened", 503);

  const config = getDocumentConfig();
  if (crypto.keyId !== config.keyId) {
    throw new AppError("document_key_unavailable", "Document encryption keys require administrator attention", 503);
  }
  let ciphertext: Buffer;
  try {
    ciphertext = await documentStorage().readCiphertext(crypto.storageKey, config.maxBytes + 64);
  } catch {
    throw new AppError("document_unavailable", "That document cannot currently be opened", 503);
  }
  const envelope: DocumentCryptoEnvelope = {
    envelopeVersion: crypto.envelopeVersion as 1,
    algorithm: "aes-256-gcm",
    keyId: crypto.keyId,
    contentIv: crypto.contentIv,
    contentAuthTag: crypto.contentAuthTag,
    wrappedDek: crypto.wrappedDek,
    wrapIv: crypto.wrapIv,
    wrapAuthTag: crypto.wrapAuthTag,
  };
  let bytes: Buffer;
  try {
    bytes = decryptDocument(ciphertext, {
      documentId,
      householdId: record.householdId,
      itemId: record.itemId,
      mediaType: record.mediaType,
      plaintextSize: record.sizeBytes,
    }, envelope, config.keyEncryptionKey);
  } catch {
    throw new AppError("document_integrity_failed", "That document failed its integrity check", 503);
  }
  await recordDocumentAudit(record.householdId, documentId, userId, "document_downloaded", { itemId: record.itemId });
  return { bytes, displayName: record.displayName, mediaType: record.mediaType };
}

export async function requestDocumentDeletion(userId: string, documentId: string): Promise<DocumentSummary> {
  const record = await requireDocumentAccess(userId, documentId);
  if (record.lifecycle !== "available") throw new AppError("document_not_found", "That document is not available", 404);
  const config = getDocumentConfig();
  const deleteAfter = new Date(Date.now() + config.retentionDays * 86_400_000);
  const updated = await getDb().transaction(async (transaction) => {
    await transaction.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`orbit:document:${documentId}`}, 0))`,
    );
    const [changed] = await transaction.update(documents).set({
      lifecycle: "pending_deletion",
      deleteAfter,
      version: sql`${documents.version} + 1`,
      updatedAt: new Date(),
    }).where(and(eq(documents.id, documentId), eq(documents.lifecycle, "available"))).returning();
    if (!changed) return undefined;
    await transaction.insert(documentJobs).values({
      documentId,
      kind: "purge",
      generation: changed.version,
    }).onConflictDoNothing();
    return changed;
  });
  if (!updated) throw new AppError("document_conflict", "That document changed; refresh and try again", 409);
  await recordDocumentAudit(record.householdId, documentId, userId, "document_deletion_requested", {
    itemId: record.itemId,
    deleteAfter: deleteAfter.toISOString(),
  });
  return toSummary(updated);
}

export async function restoreDocument(userId: string, documentId: string): Promise<DocumentSummary> {
  const record = await requireDocumentAccess(userId, documentId);
  if (record.lifecycle !== "pending_deletion" || !record.deleteAfter || record.deleteAfter <= new Date()) {
    throw new AppError("document_not_found", "That document is not available", 404);
  }
  const updated = await getDb().transaction(async (transaction) => {
    await transaction.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`orbit:document:${documentId}`}, 0))`,
    );
    const [crypto] = await transaction.select({ storageKey: documentCrypto.storageKey })
      .from(documentCrypto)
      .where(eq(documentCrypto.documentId, documentId))
      .limit(1);
    const [purgeJob] = await transaction.select({ status: documentJobs.status })
      .from(documentJobs)
      .where(and(eq(documentJobs.documentId, documentId), eq(documentJobs.kind, "purge")))
      .orderBy(desc(documentJobs.generation))
      .limit(1);
    if (purgeJob?.status === "processing") {
      throw new AppError("document_conflict", "That document is being removed; try again shortly", 409);
    }
    if (!crypto) throw new AppError("document_unavailable", "That document cannot currently be restored", 503);
    let ciphertextExists = false;
    try {
      ciphertextExists = await documentStorage().ciphertextExists(crypto.storageKey);
    } catch {
      throw new AppError("document_unavailable", "That document cannot currently be restored", 503);
    }
    if (!ciphertextExists) {
      // Ciphertext may already be gone after a worker interruption. Keep the
      // pending purge and its metadata so a valid retry can finalize it.
      throw new AppError("document_unavailable", "That document cannot currently be restored", 503);
    }
    const [changed] = await transaction.update(documents).set({
      lifecycle: "available",
      deleteAfter: null,
      version: sql`${documents.version} + 1`,
      updatedAt: new Date(),
    }).where(and(eq(documents.id, documentId), eq(documents.lifecycle, "pending_deletion"))).returning();
    if (!changed) return undefined;
    await transaction.update(documentJobs).set({
      status: "completed",
      completedAt: new Date(),
      lockedAt: null,
      leaseExpiresAt: null,
      lastError: "restored_before_purge",
      updatedAt: new Date(),
    }).where(and(
      eq(documentJobs.documentId, documentId),
      eq(documentJobs.kind, "purge"),
      inArray(documentJobs.status, ["pending", "retry", "failed"]),
    ));
    return changed;
  });
  if (!updated) throw new AppError("document_conflict", "That document changed; refresh and try again", 409);
  await recordDocumentAudit(record.householdId, documentId, userId, "document_restored", { itemId: record.itemId });
  return toSummary(updated);
}
