import { and, eq, isNotNull, isNull, lte, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { auditLog, documentCrypto, documents, households, memberships, portableArchives, sessions, users } from "@/db/schema";
import { AppError } from "@/lib/app-error";
import { householdOwnerLockKey } from "@/lib/auth/authority-locks";
import { requireUuid } from "@/server/workspace-access";
import { getDocumentConfig } from "@/server/documents/config";
import { LocalDocumentStorage } from "@/server/documents/storage";
import { PortableArchiveStorage } from "@/server/portable-archive-storage";

const RECOVERY_WINDOW_MS = 30 * 24 * 60 * 60 * 1_000;

interface HouseholdStorageKeys {
  documents: string[];
  archives: string[];
}

type Database = ReturnType<typeof getDb>;
type DatabaseTransaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

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

interface HouseholdLifecycleRecord {
  id: string;
  name: string;
  deletionRequestedAt: Date | null;
  deleteAfter: Date | null;
  administrator: boolean;
  disabledAt: Date | null;
  role: "owner" | "member" | null;
}

/**
 * Reads all authority inputs after the household lifecycle lock is held. The
 * row locks make account and membership changes wait for the same transaction
 * snapshot used by the destructive transition.
 */
async function readHouseholdLifecycleRecord(
  transaction: DatabaseTransaction,
  userId: string,
  householdId: string,
): Promise<HouseholdLifecycleRecord | undefined> {
  const [household] = await transaction.select({
    id: households.id,
    name: households.name,
    deletionRequestedAt: households.deletionRequestedAt,
    deleteAfter: households.deleteAfter,
  }).from(households).where(eq(households.id, householdId)).for("update").limit(1);
  if (!household) return undefined;

  const [user] = await transaction.select({
    administrator: users.isInstanceAdmin,
    disabledAt: users.disabledAt,
  }).from(users).where(eq(users.id, userId)).for("update").limit(1);
  if (!user) return undefined;

  const [membership] = await transaction.select({ role: memberships.role })
    .from(memberships)
    .where(and(eq(memberships.householdId, householdId), eq(memberships.userId, userId)))
    .for("update")
    .limit(1);

  return { ...household, ...user, role: membership?.role ?? null };
}

function requireScheduleAuthority(record: HouseholdLifecycleRecord | undefined): HouseholdLifecycleRecord {
  if (!record || record.disabledAt || (!record.administrator && record.role !== "owner")) {
    throw new AppError("household_not_found", "That household is not available", 404);
  }
  return record;
}

function requireHardDeleteAuthority(record: HouseholdLifecycleRecord | undefined): HouseholdLifecycleRecord {
  if (!record || record.disabledAt) {
    throw new AppError("household_not_found", "That household is not available", 404);
  }
  if (!record.administrator) {
    throw new AppError("administrator_required", "Only an instance administrator can permanently delete a household", 403);
  }
  return record;
}

async function acquireHouseholdLifecycleLock(transaction: DatabaseTransaction, householdId: string): Promise<void> {
  await transaction.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${householdOwnerLockKey(householdId)}, 0))`,
  );
}

/** Schedules a reversible household deletion after a typed name confirmation. */
export async function requestHouseholdDeletion(userId: string, householdId: string, confirmation: string) {
  const validHouseholdId = requireUuid(householdId, "Household");
  return getDb().transaction(async (transaction) => {
    await acquireHouseholdLifecycleLock(transaction, validHouseholdId);
    const record = requireScheduleAuthority(await readHouseholdLifecycleRecord(transaction, userId, validHouseholdId));
    if (record.deletionRequestedAt) {
      throw new AppError("household_deletion_pending", "This household is already scheduled for deletion", 409);
    }
    if (confirmation !== record.name) {
      throw new AppError("household_confirmation_failed", "Type the household name exactly to schedule deletion", 422);
    }

    const now = new Date();
    const deleteAfter = new Date(now.getTime() + RECOVERY_WINDOW_MS);
    const [changed] = await transaction.update(households).set({
      deletionRequestedAt: now,
      deleteAfter,
      deletionRequestedByUserId: userId,
      updatedAt: now,
    }).where(and(eq(households.id, validHouseholdId), isNull(households.deletionRequestedAt))).returning({ id: households.id });
    if (!changed) {
      throw new AppError("household_deletion_pending", "This household is already scheduled for deletion", 409);
    }
    await transaction.insert(auditLog).values({
      householdId: validHouseholdId,
      actorUserId: userId,
      entityType: "household",
      entityId: validHouseholdId,
      action: "household_deletion_requested",
      changes: { deleteAfter: deleteAfter.toISOString() },
    });
    return { deleteAfter: deleteAfter.toISOString() };
  });
}

/** Cancels a scheduled deletion before the retention window expires. */
export async function restoreHousehold(userId: string, householdId: string, sessionId?: string) {
  const validHouseholdId = requireUuid(householdId, "Household");
  return getDb().transaction(async (transaction) => {
    await acquireHouseholdLifecycleLock(transaction, validHouseholdId);
    const record = requireScheduleAuthority(await readHouseholdLifecycleRecord(transaction, userId, validHouseholdId));
    const now = new Date();
    if (!record.deletionRequestedAt || !record.deleteAfter || record.deleteAfter <= now) {
      throw new AppError("household_not_recoverable", "This household can no longer be restored", 409);
    }

    const [changed] = await transaction.update(households).set({
      deletionRequestedAt: null,
      deleteAfter: null,
      deletionRequestedByUserId: null,
      updatedAt: now,
    }).where(and(eq(households.id, validHouseholdId), eq(households.deletionRequestedAt, record.deletionRequestedAt))).returning({ id: households.id });
    if (!changed) {
      throw new AppError("household_not_recoverable", "This household changed and can no longer be restored", 409);
    }
    if (sessionId) {
      await transaction.update(sessions).set({ activeHouseholdId: validHouseholdId })
        .where(and(eq(sessions.id, sessionId), eq(sessions.userId, userId)));
    }
    await transaction.insert(auditLog).values({
      householdId: validHouseholdId,
      actorUserId: userId,
      entityType: "household",
      entityId: validHouseholdId,
      action: "household_deletion_cancelled",
      changes: {},
    });
  });
}

/** Permanently removes a recoverable household. This bypasses retention and is restricted to instance administrators. */
export async function hardDeleteHousehold(userId: string, householdId: string, confirmation: string): Promise<void> {
  const validHouseholdId = requireUuid(householdId, "Household");
  const storageKeys = await getDb().transaction(async (transaction): Promise<HouseholdStorageKeys> => {
    await acquireHouseholdLifecycleLock(transaction, validHouseholdId);
    const record = requireHardDeleteAuthority(await readHouseholdLifecycleRecord(transaction, userId, validHouseholdId));
    if (!record.deletionRequestedAt || confirmation !== record.name) {
      throw new AppError("household_hard_delete_confirmation_failed", "Type the household name exactly to permanently delete it", 422);
    }

    const documentRows = await transaction.select({ storageKey: documentCrypto.storageKey })
      .from(documents)
      .innerJoin(documentCrypto, eq(documentCrypto.documentId, documents.id))
      .where(eq(documents.householdId, validHouseholdId));
    const archiveRows = await transaction.select({ storageKey: portableArchives.storageKey })
      .from(portableArchives).where(eq(portableArchives.householdId, validHouseholdId));

    await transaction.insert(auditLog).values({
      householdId: validHouseholdId,
      actorUserId: userId,
      entityType: "household",
      entityId: validHouseholdId,
      action: "household_hard_deleted",
      changes: { reason: "administrator_requested" },
    });
    const [deleted] = await transaction.delete(households)
      .where(and(eq(households.id, validHouseholdId), isNotNull(households.deletionRequestedAt)))
      .returning({ id: households.id });
    if (!deleted) {
      throw new AppError("household_not_recoverable", "This household can no longer be permanently deleted", 409);
    }
    return {
      documents: documentRows.map((row) => row.storageKey),
      archives: archiveRows.map((row) => row.storageKey),
    };
  });

  // The database has made the data inaccessible before any external side effect.
  // Reconciliation later removes an orphan if a local storage delete is interrupted.
  await deleteHouseholdStorage(storageKeys);
}

/** Purges expired household records and private encrypted blobs. PostgreSQL locks serialize replica workers. */
export async function purgeExpiredHouseholds(limit = 10): Promise<void> {
  const candidates = await getDb().select({ id: households.id }).from(households)
    .where(and(isNotNull(households.deletionRequestedAt), lte(households.deleteAfter, new Date()))).limit(limit);
  for (const candidate of candidates) {
    const storageKeys = await getDb().transaction(async (transaction): Promise<HouseholdStorageKeys | undefined> => {
      await acquireHouseholdLifecycleLock(transaction, candidate.id);
      const now = new Date();
      const [household] = await transaction.select({ id: households.id }).from(households)
        .where(and(
          eq(households.id, candidate.id),
          isNotNull(households.deletionRequestedAt),
          lte(households.deleteAfter, now),
        )).for("update").limit(1);
      if (!household) return undefined;

      const documentRows = await transaction.select({ storageKey: documentCrypto.storageKey }).from(documents)
        .innerJoin(documentCrypto, eq(documentCrypto.documentId, documents.id)).where(eq(documents.householdId, candidate.id));
      const archiveRows = await transaction.select({ storageKey: portableArchives.storageKey })
        .from(portableArchives).where(eq(portableArchives.householdId, candidate.id));
      await transaction.insert(auditLog).values({
        householdId: candidate.id,
        actorUserId: null,
        entityType: "household",
        entityId: candidate.id,
        action: "household_purged",
        changes: { reason: "retention_expired" },
      });
      await transaction.delete(households).where(eq(households.id, candidate.id));
      return { documents: documentRows.map((row) => row.storageKey), archives: archiveRows.map((row) => row.storageKey) };
    });
    if (storageKeys) await deleteHouseholdStorage(storageKeys);
  }
}
