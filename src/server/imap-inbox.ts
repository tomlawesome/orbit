import { asc, desc, eq, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { households, imapIngestionAttachments, imapIngestionMessages, memberships } from "@/db/schema";

/** Returns the sole destination or indicates that the user must choose one. */
export async function imapReceiptDestination(userId: string): Promise<{ householdId?: string; requiresSelection: boolean }> {
  const choices = await getDb().select({ householdId: households.id })
    .from(memberships).innerJoin(households, eq(households.id, memberships.householdId))
    .where(eq(memberships.userId, userId)).orderBy(asc(households.createdAt));
  return choices.length === 1 ? { householdId: choices[0].householdId, requiresSelection: false } : { requiresSelection: true };
}

/** Returns only the caller's receipt states; subjects, headers, and attachment names stay private. */
export async function listImapInbox(userId: string) {
  const [receipts, choices] = await Promise.all([
    getDb().select({
      id: imapIngestionMessages.id,
      status: imapIngestionMessages.status,
      householdId: imapIngestionMessages.householdId,
      receivedAt: imapIngestionMessages.receivedAt,
      attachmentCount: sql<number>`count(${imapIngestionAttachments.id})::int`,
    }).from(imapIngestionMessages)
      .leftJoin(imapIngestionAttachments, eq(imapIngestionAttachments.messageId, imapIngestionMessages.id))
      .where(eq(imapIngestionMessages.userId, userId))
      .groupBy(imapIngestionMessages.id)
      .orderBy(desc(imapIngestionMessages.receivedAt))
      .limit(50),
    getDb().select({ id: households.id, name: households.name })
      .from(memberships).innerJoin(households, eq(households.id, memberships.householdId))
      .where(eq(memberships.userId, userId)).orderBy(asc(households.name)),
  ]);
  return { receipts, households: choices };
}
