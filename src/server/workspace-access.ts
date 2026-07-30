import { and, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "@/db";
import { households, memberships, users } from "@/db/schema";
import { AppError } from "@/lib/app-error";
import { householdOwnerLockKey } from "@/lib/auth/authority-locks";

const uuidSchema = z.uuid();
type Database = ReturnType<typeof getDb>;
type DatabaseTransaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

export function validUuid(value: string): boolean {
  return uuidSchema.safeParse(value).success;
}

export function requireUuid(value: string, field: string): string {
  if (!validUuid(value)) throw new AppError("invalid_identifier", `${field} is not a valid identifier`, 422);
  return value;
}

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

export async function requireHouseholdAccess(userId: string, householdId: string, ownerOnly = false): Promise<void> {
  requireUuid(householdId, "Household");
  const [access] = await getDb().select({
    administrator: users.isInstanceAdmin,
    role: memberships.role,
  })
    .from(users)
    .innerJoin(households, and(
      eq(households.id, householdId),
      isNull(households.deletionRequestedAt),
    ))
    .leftJoin(memberships, and(
      eq(memberships.userId, users.id),
      eq(memberships.householdId, households.id),
    ))
    .where(and(eq(users.id, userId), isNull(users.disabledAt)))
    .limit(1);
  if (!access || (!access.administrator && !access.role)) {
    throw new AppError("household_not_found", "That household is not available", 404);
  }
  if (ownerOnly && !access.administrator && access.role !== "owner") {
    throw new AppError("owner_required", "Only a household owner can make this change", 403);
  }
}
