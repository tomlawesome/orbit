import { and, eq, isNull, lte, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { auditLog, documentCrypto, documents, households, memberships, portableArchives, users } from "@/db/schema";
import { AppError } from "@/lib/app-error";
import { getDocumentConfig } from "@/server/documents/config";
import { LocalDocumentStorage } from "@/server/documents/storage";
import { PortableArchiveStorage } from "@/server/portable-archive-storage";

const RECOVERY_WINDOW_MS = 30 * 24 * 60 * 60 * 1_000;

async function requireDeletionAuthority(userId: string, householdId: string) {
  const [record] = await getDb().select({
    id: households.id,
    name: households.name,
    deletionRequestedAt: households.deletionRequestedAt,
    deleteAfter: households.deleteAfter,
    administrator: users.isInstanceAdmin,
    role: memberships.role,
  }).from(households)
    .innerJoin(users, eq(users.id, userId))
    .leftJoin(memberships, and(eq(memberships.householdId, households.id), eq(memberships.userId, users.id)))
    .where(eq(households.id, householdId)).limit(1);
  if (!record || (!record.administrator && record.role !== "owner")) {
    throw new AppError("household_not_found", "That household is not available", 404);
  }
  return record;
}

/** Schedules a reversible household deletion after a typed name confirmation. */
export async function requestHouseholdDeletion(userId: string, householdId: string, confirmation: string) {
  const record = await requireDeletionAuthority(userId, householdId);
  if (record.deletionRequestedAt) throw new AppError("household_deletion_pending", "This household is already scheduled for deletion", 409);
  if (confirmation.trim() !== record.name) throw new AppError("household_confirmation_failed", "Type the household name exactly to schedule deletion", 422);
  const now = new Date();
  const deleteAfter = new Date(now.getTime() + RECOVERY_WINDOW_MS);
  await getDb().transaction(async (transaction) => {
    const [changed] = await transaction.update(households).set({
      deletionRequestedAt: now,
      deleteAfter,
      deletionRequestedByUserId: userId,
      updatedAt: now,
    }).where(and(eq(households.id, householdId), isNull(households.deletionRequestedAt))).returning({ id: households.id });
    if (!changed) throw new AppError("household_deletion_pending", "This household is already scheduled for deletion", 409);
    await transaction.insert(auditLog).values({
      householdId, actorUserId: userId, entityType: "household", entityId: householdId,
      action: "household_deletion_requested", changes: { deleteAfter: deleteAfter.toISOString() },
    });
  });
  return { deleteAfter: deleteAfter.toISOString() };
}

/** Cancels a scheduled deletion before the retention window expires. */
export async function restoreHousehold(userId: string, householdId: string) {
  const record = await requireDeletionAuthority(userId, householdId);
  if (!record.deletionRequestedAt || !record.deleteAfter || record.deleteAfter <= new Date()) {
    throw new AppError("household_not_recoverable", "This household can no longer be restored", 409);
  }
  const requestedAt = record.deletionRequestedAt;
  await getDb().transaction(async (transaction) => {
    const [changed] = await transaction.update(households).set({
      deletionRequestedAt: null, deleteAfter: null, deletionRequestedByUserId: null, updatedAt: new Date(),
    }).where(and(eq(households.id, householdId), eq(households.deletionRequestedAt, requestedAt))).returning({ id: households.id });
    if (!changed) throw new AppError("household_not_recoverable", "This household changed and can no longer be restored", 409);
    await transaction.insert(auditLog).values({
      householdId, actorUserId: userId, entityType: "household", entityId: householdId,
      action: "household_deletion_cancelled", changes: {},
    });
  });
}

/** Purges expired household records and private encrypted blobs. PostgreSQL locks serialize replica workers. */
export async function purgeExpiredHouseholds(limit = 10): Promise<void> {
  const candidates = await getDb().select({ id: households.id }).from(households)
    .where(lte(households.deleteAfter, new Date())).limit(limit);
  for (const candidate of candidates) {
    await getDb().transaction(async (transaction) => {
      await transaction.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`orbit:household-delete:${candidate.id}`}, 0))`);
      const [household] = await transaction.select({ id: households.id }).from(households)
        .where(and(eq(households.id, candidate.id), lte(households.deleteAfter, new Date()))).limit(1);
      if (!household) return;
      const documentRows = await transaction.select({ storageKey: documentCrypto.storageKey }).from(documents)
        .innerJoin(documentCrypto, eq(documentCrypto.documentId, documents.id)).where(eq(documents.householdId, candidate.id));
      const archiveRows = await transaction.select({ storageKey: portableArchives.storageKey }).from(portableArchives)
        .where(eq(portableArchives.householdId, candidate.id));
      const config = getDocumentConfig();
      const documentStorage = new LocalDocumentStorage(config.storageRoot, config.quarantineRoot);
      const archiveStorage = new PortableArchiveStorage(`${config.storageRoot}/portable-archives`);
      for (const document of documentRows) await documentStorage.deleteCiphertext(document.storageKey);
      for (const archive of archiveRows) await archiveStorage.delete(archive.storageKey);
      await transaction.insert(auditLog).values({
        householdId: candidate.id, actorUserId: null, entityType: "household", entityId: candidate.id,
        action: "household_purged", changes: { reason: "retention_expired" },
      });
      await transaction.delete(households).where(eq(households.id, candidate.id));
    });
  }
}
