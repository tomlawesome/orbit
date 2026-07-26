import { and, asc, desc, eq, sql } from "drizzle-orm";
import { AppError } from "@/lib/app-error";
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

export async function assignImapReceiptHousehold(userId: string, receiptId: string, householdId: string): Promise<void> {
  const [membership] = await getDb().select({ householdId: memberships.householdId }).from(memberships)
    .where(and(eq(memberships.userId, userId), eq(memberships.householdId, householdId))).limit(1);
  if (!membership) throw new AppError("household_not_found", "That household is not available", 404);
  const [changed] = await getDb().update(imapIngestionMessages).set({ householdId, updatedAt: new Date() })
    .where(and(eq(imapIngestionMessages.id, receiptId), eq(imapIngestionMessages.userId, userId), eq(imapIngestionMessages.status, "pending_review"))).returning({ id: imapIngestionMessages.id });
  if (!changed) throw new AppError("inbox_receipt_not_found", "That incoming document is not available", 404);
}
