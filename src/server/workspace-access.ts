import { and, eq, gt, isNull, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { households, memberships, portableArchiveImports, users } from "@/db/schema";
import { AppError } from "@/lib/app-error";
import { householdOwnerLockKey } from "@/lib/auth/authority-locks";
import { requireUuid } from "@/lib/uuid";
import { PORTABLE_IMPORT_LEASE_MS } from "@/server/portable-archive-limits";

type Database = ReturnType<typeof getDb>;
type DatabaseTransaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

export function sectionSlug(name: string, id: string): string {
  const normalized = name.toLowerCase().normalize("NFKD").replace(/[^\w\s-]/g, "").trim().replace(/[\s_-]+/g, "-");
  return `${normalized || "section"}-${id.slice(0, 8)}`;
}

export async function acquireActiveHouseholdLock(
  transaction: DatabaseTransaction,
  householdId: string,
): Promise<void> {
  const validHouseholdId = requireUuid(householdId, "Household");
  await transaction.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${householdOwnerLockKey(validHouseholdId)}, 0))`,
  );
  const [active] = await transaction.select({ id: households.id })
    .from(households)
    .where(and(
      eq(households.id, validHouseholdId),
      isNull(households.deletionRequestedAt),
    ))
    .for("update")
    .limit(1);
  if (!active) {
    throw new AppError("household_not_found", "That household is not available", 404);
  }
}

export interface HouseholdAccess {
  /** The user is an instance administrator, who may act in any household. */
  administrator: boolean;
  /** The user's own role in the household; null for an administrator who is not a member. */
  role: "owner" | "member" | null;
}

/**
 * The import running in this household, if any (#1316, owner 2026-10-14):
 * its start record, still open and younger than the lease. The row is
 * written when the import's metadata commits and closed when it finishes or
 * is rolled back, so it lasts exactly as long as the import, across restarts.
 * Past the lease an open row is a crash, not an import: an import that
 * genuinely runs longer finishes its tail with the household open, which a
 * heartbeat would fix at the cost of a schema change no household has needed.
 */
export async function openImportFor(
  householdId: string,
  executor: Database | DatabaseTransaction = getDb(),
): Promise<{ actorUserId: string | null } | undefined> {
  const [row] = await executor.select({ actorUserId: portableArchiveImports.actorUserId })
    .from(portableArchiveImports)
    .where(and(
      eq(portableArchiveImports.householdId, householdId),
      isNull(portableArchiveImports.finishedAt),
      gt(portableArchiveImports.startedAt, new Date(Date.now() - PORTABLE_IMPORT_LEASE_MS)),
    ))
    .limit(1);
  return row;
}

/** The refusal for anyone but the importer while an import runs (#1316). */
const HOUSEHOLD_IMPORT_IN_PROGRESS_MESSAGE = "This household's owner is bringing in an archive. Come back when it's finished.";

/**
 * The one household-access predicate (#1334, single authorization gate). A
 * user has access when they are an active (not disabled) member of, or an
 * instance administrator over, a household that is not waiting to be deleted.
 * Anything else is `undefined`, so a caller cannot tell a household that does
 * not exist from one it may not see.
 *
 * While an import runs in the household it is closed to everyone but the
 * importer (#1316, owner 2026-10-14): anyone else who would have access is
 * refused with 409 `household_import_in_progress`, administrators included,
 * so nobody reads or edits what the import is still writing. The importer's
 * own document restores pass through here as them. Workers are deliberately
 * not stopped: the document worker scans the import's own restores, and
 * neither reminders nor mail-in touch what the import created.
 *
 * The household id is checked as a UUID first and refused with 422, before
 * it can reach a uuid column as text. Pass `executor` to run inside a
 * transaction. Callers keep their own extra joins, lookups and error codes:
 * this answers only "may this user act in this household".
 */
export async function findHouseholdAccess(
  userId: string,
  householdId: string,
  executor: Database | DatabaseTransaction = getDb(),
): Promise<HouseholdAccess | undefined> {
  const validHouseholdId = requireUuid(householdId, "Household");
  const [access] = await executor.select({
    administrator: users.isInstanceAdmin,
    role: memberships.role,
  })
    .from(users)
    .innerJoin(households, and(
      eq(households.id, validHouseholdId),
      isNull(households.deletionRequestedAt),
    ))
    .leftJoin(memberships, and(
      eq(memberships.userId, users.id),
      eq(memberships.householdId, households.id),
    ))
    .where(and(eq(users.id, userId), isNull(users.disabledAt)))
    .limit(1);
  if (!access || (!access.administrator && !access.role)) return undefined;
  const runningImport = await openImportFor(validHouseholdId, executor);
  if (runningImport && runningImport.actorUserId !== userId) {
    // No Retry-After: nothing says when the import will end.
    throw new AppError("household_import_in_progress", HOUSEHOLD_IMPORT_IN_PROGRESS_MESSAGE, 409);
  }
  return { administrator: access.administrator, role: access.role };
}

export async function requireHouseholdAccess(
  userId: string,
  householdId: string,
  ownerOnly = false,
  executor: Database | DatabaseTransaction = getDb(),
): Promise<void> {
  const access = await findHouseholdAccess(userId, householdId, executor);
  if (!access) {
    throw new AppError("household_not_found", "That household is not available", 404);
  }
  if (ownerOnly && !access.administrator && access.role !== "owner") {
    throw new AppError("owner_required", "Only a household owner can make this change", 403);
  }
}
