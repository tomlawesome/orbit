import { asc, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { households, memberships } from "@/db/schema";

/** Returns the sole destination or indicates that the user must choose one. */
export async function imapReceiptDestination(userId: string): Promise<{ householdId?: string; requiresSelection: boolean }> {
  const choices = await getDb().select({ householdId: households.id })
    .from(memberships).innerJoin(households, eq(households.id, memberships.householdId))
    .where(eq(memberships.userId, userId)).orderBy(asc(households.createdAt));
  return choices.length === 1 ? { householdId: choices[0].householdId, requiresSelection: false } : { requiresSelection: true };
}
