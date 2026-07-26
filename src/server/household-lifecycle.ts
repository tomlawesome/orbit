import { and, eq, isNotNull, isNull, lte, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { auditLog, documentCrypto, documents, households, memberships, portableArchives, sessions, users } from "@/db/schema";
import { AppError } from "@/lib/app-error";
import { getDocumentConfig } from "@/server/documents/config";
import { LocalDocumentStorage } from "@/server/documents/storage";
import { PortableArchiveStorage } from "@/server/portable-archive-storage";

const RECOVERY_WINDOW_MS = 30 * 24 * 60 * 60 * 1_000;

interface HouseholdStorageKeys {
  documents: string[];
  archives: string[];
}

async function deleteHouseholdStorage(keys: HouseholdStorageKeys): Promise<void> {
  const config = getDocumentConfig();
  const documentStorage = new LocalDocumentStorage(config.storageRoot, config.quarantineRoot);
  const archiveStorage = new PortableArchiveStorage(`${config.storageRoot}/portable-archives`);
  // Database access has already been removed. A failed local cleanup leaves
  // only encrypted orphan data, which reconciliation can safely remove later;
  // it must not make the completed deletion appear to have failed to the user.
  await Promise.allSettled([
    ...keys.documents.map((storageKey) => documentStorage.deleteCiphertext(storageKey)),
    ...keys.archives.map((storageKey) => archiveStorage.delete(storageKey)),
  ]);
}

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
export async function restoreHousehold(userId: string, householdId: string, sessionId?: string) {
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
    if (sessionId) await transaction.update(sessions).set({ activeHouseholdId: householdId }).where(eq(sessions.id, sessionId));
    await transaction.insert(auditLog).values({
      householdId, actorUserId: userId, entityType: "household", entityId: householdId,
      action: "household_deletion_cancelled", changes: {},
    });
  });
}

/** Permanently removes a recoverable household. This bypasses retention and is restricted to instance administrators. */
export async function hardDeleteHousehold(userId: string, householdId: string, confirmation: string): Promise<void> {
  const record = await requireDeletionAuthority(userId, householdId);
  if (!record.administrator) throw new AppError("administrator_required", "Only an instance administrator can permanently delete a household", 403);
  if (!record.deletionRequestedAt || confirmation.trim() !== record.name) throw new AppError("household_hard_delete_confirmation_failed", "Type the household name exactly to permanently delete it", 422);
  const [documentRows, archiveRows] = await Promise.all([
    getDb().select({ storageKey: documentCrypto.storageKey }).from(documents).innerJoin(documentCrypto, eq(documentCrypto.documentId, documents.id)).where(eq(documents.householdId, householdId)),
    getDb().select({ storageKey: portableArchives.storageKey }).from(portableArchives).where(eq(portableArchives.householdId, householdId)),
  ]);
  await getDb().transaction(async (transaction) => {
    const [deleted] = await transaction.delete(households).where(and(eq(households.id, householdId), isNotNull(households.deletionRequestedAt))).returning({ id: households.id });
    if (!deleted) throw new AppError("household_not_recoverable", "This household can no longer be permanently deleted", 409);
  });
  // The database has made the data inaccessible before any external side effect.
  // Reconciliation later removes an orphan if a local storage delete is interrupted.
  await deleteHouseholdStorage({ documents: documentRows.map((row) => row.storageKey), archives: archiveRows.map((row) => row.storageKey) });
}

/** Purges expired household records and private encrypted blobs. PostgreSQL locks serialize replica workers. */
export async function purgeExpiredHouseholds(limit = 10): Promise<void> {
  const candidates = await getDb().select({ id: households.id }).from(households)
    .where(lte(households.deleteAfter, new Date())).limit(limit);
  for (const candidate of candidates) {
    const storageKeys = await getDb().transaction(async (transaction): Promise<HouseholdStorageKeys | undefined> => {
      await transaction.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`orbit:household-delete:${candidate.id}`}, 0))`);
      const [household] = await transaction.select({ id: households.id }).from(households)
        .where(and(eq(households.id, candidate.id), lte(households.deleteAfter, new Date()))).limit(1);
      if (!household) return undefined;
      const documentRows = await transaction.select({ storageKey: documentCrypto.storageKey }).from(documents)
        .innerJoin(documentCrypto, eq(documentCrypto.documentId, documents.id)).where(eq(documents.householdId, candidate.id));
      const archiveRows = await transaction.select({ storageKey: portableArchives.storageKey }).from(portableArchives)
        .where(eq(portableArchives.householdId, candidate.id));
      await transaction.insert(auditLog).values({
        householdId: candidate.id, actorUserId: null, entityType: "household", entityId: candidate.id,
        action: "household_purged", changes: { reason: "retention_expired" },
      });
      await transaction.delete(households).where(eq(households.id, candidate.id));
      return { documents: documentRows.map((row) => row.storageKey), archives: archiveRows.map((row) => row.storageKey) };
    });
    if (storageKeys) await deleteHouseholdStorage(storageKeys);
  }
}
