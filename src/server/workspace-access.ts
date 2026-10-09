import { and, eq, isNull, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { households, memberships, users } from "@/db/schema";
import { AppError } from "@/lib/app-error";
import { householdOwnerLockKey } from "@/lib/auth/authority-locks";
import { requireUuid } from "@/lib/uuid";

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
 * The one household-access predicate (#1334, single authorization gate). A
 * user has access when they are an active (not disabled) member of, or an
 * instance administrator over, a household that is not waiting to be deleted.
 * Anything else is `undefined`, so a caller cannot tell a household that does
 * not exist from one it may not see.
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
