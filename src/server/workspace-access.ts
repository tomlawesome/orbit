import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "@/db";
import { households, memberships } from "@/db/schema";
import { AppError } from "@/lib/app-error";
import { isInstanceAdministrator } from "@/server/authorization";

const uuidSchema = z.uuid();

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

async function membershipRole(userId: string, householdId: string): Promise<"owner" | "member"> {
  const [membership] = await getDb().select({ role: memberships.role }).from(memberships)
    .where(and(eq(memberships.userId, userId), eq(memberships.householdId, householdId))).limit(1);
  if (!membership) throw new AppError("household_not_found", "That household is not available", 404);
  return membership.role;
}

export async function requireHouseholdAccess(userId: string, householdId: string, ownerOnly = false): Promise<void> {
  requireUuid(householdId, "Household");
  const [lifecycle] = await getDb().select({ deletionRequestedAt: households.deletionRequestedAt })
    .from(households).where(eq(households.id, householdId)).limit(1);
  if (!lifecycle) throw new AppError("household_not_found", "That household is not available", 404);
  if (lifecycle.deletionRequestedAt) throw new AppError("household_pending_deletion", "This household is scheduled for deletion and cannot be changed", 409);
  if (await isInstanceAdministrator(userId)) return;
  if (ownerOnly && await membershipRole(userId, householdId) !== "owner") {
    throw new AppError("owner_required", "Only a household owner can make this change", 403);
  }
  if (!ownerOnly) await membershipRole(userId, householdId);
}
