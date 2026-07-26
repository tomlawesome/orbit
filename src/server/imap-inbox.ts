import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { AppError } from "@/lib/app-error";
import { getDb } from "@/db";
import { households, imapIngestionAttachments, imapIngestionMessages, items, memberships, sections } from "@/db/schema";
import { materializeImapReviewItem } from "@/server/imap-review-items";

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
      reviewItemId: imapIngestionMessages.reviewItemId,
      receivedAt: imapIngestionMessages.receivedAt,
      attachmentCount: sql<number>`count(${imapIngestionAttachments.id})::int`,
    }).from(imapIngestionMessages)
      .leftJoin(imapIngestionAttachments, eq(imapIngestionAttachments.messageId, imapIngestionMessages.id))
      .where(and(eq(imapIngestionMessages.userId, userId), eq(imapIngestionMessages.status, "pending_review")))
      .groupBy(imapIngestionMessages.id)
      .orderBy(desc(imapIngestionMessages.receivedAt))
      .limit(50),
    getDb().select({ id: households.id, name: households.name })
      .from(memberships).innerJoin(households, eq(households.id, memberships.householdId))
      .where(eq(memberships.userId, userId)).orderBy(asc(households.name)),
  ]);
  const householdSections = choices.length ? await getDb().select({ id: sections.id, householdId: sections.householdId, name: sections.name })
    .from(sections).where(and(inArray(sections.householdId, choices.map((choice) => choice.id)), eq(sections.visible, true))).orderBy(asc(sections.position)) : [];
  return { receipts, households: choices.map((household) => ({ ...household, sections: householdSections.filter((section) => section.householdId === household.id) })) };
}

/** Makes a reviewed inbound item visible only after the member selects its section. */
export async function activateImapReviewItem(userId: string, receiptId: string, sectionId: string): Promise<{ itemId: string }> {
  const [receipt] = await getDb().select().from(imapIngestionMessages).where(and(eq(imapIngestionMessages.id, receiptId), eq(imapIngestionMessages.userId, userId), eq(imapIngestionMessages.status, "pending_review"))).limit(1);
  if (!receipt?.householdId || !receipt.reviewItemId) throw new AppError("inbox_receipt_not_ready", "That incoming document is not ready for review", 409);
  const [section] = await getDb().select({ id: sections.id }).from(sections).where(and(eq(sections.id, sectionId), eq(sections.householdId, receipt.householdId), eq(sections.visible, true))).limit(1);
  if (!section) throw new AppError("section_not_found", "Choose a visible section from this household", 422);
  await getDb().transaction(async (transaction) => {
    await transaction.update(items).set({ sectionId, status: "active", requiresReview: false, updatedAt: new Date() }).where(and(eq(items.id, receipt.reviewItemId!), eq(items.householdId, receipt.householdId!)));
    await transaction.update(imapIngestionMessages).set({ status: "completed", updatedAt: new Date() }).where(eq(imapIngestionMessages.id, receipt.id));
  });
  return { itemId: receipt.reviewItemId };
}

export async function assignImapReceiptHousehold(userId: string, receiptId: string, householdId: string): Promise<{ reviewItemId?: string }> {
  const [membership] = await getDb().select({ householdId: memberships.householdId }).from(memberships)
    .where(and(eq(memberships.userId, userId), eq(memberships.householdId, householdId))).limit(1);
  if (!membership) throw new AppError("household_not_found", "That household is not available", 404);
  const [changed] = await getDb().update(imapIngestionMessages).set({ householdId, updatedAt: new Date() })
    .where(and(eq(imapIngestionMessages.id, receiptId), eq(imapIngestionMessages.userId, userId), eq(imapIngestionMessages.status, "pending_review"))).returning({ id: imapIngestionMessages.id });
  if (!changed) throw new AppError("inbox_receipt_not_found", "That incoming document is not available", 404);
  return { reviewItemId: await materializeImapReviewItem(userId, receiptId) };
}
