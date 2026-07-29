import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { AppError } from "@/lib/app-error";
import { getDb } from "@/db";
import { documents, households, imapIngestionAttachments, imapIngestionMessages, items, memberships, sections, users } from "@/db/schema";
import { purgeHeldImapAttachment } from "@/server/imap-attachment-holding";
import { requestDocumentDeletion } from "@/server/document-repository";
import { sanitizeReviewDraftMetadata } from "@/server/reviewed-intake";

/** Returns the sole destination or indicates that the user must choose one. */
export async function imapReceiptDestination(userId: string): Promise<{ householdId?: string; requiresSelection: boolean }> {
  const choices = await getDb().select({ householdId: households.id })
    .from(memberships).innerJoin(households, eq(households.id, memberships.householdId))
    .where(eq(memberships.userId, userId)).orderBy(asc(households.createdAt));
  return choices.length === 1 ? { householdId: choices[0].householdId, requiresSelection: false } : { requiresSelection: true };
}

/** Returns only the caller's receipt states; subjects, headers, and attachment names stay private. */
export async function listImapInbox(userId: string) {
  const [activeUser] = await getDb().select({ id: users.id }).from(users).where(and(eq(users.id, userId), isNull(users.disabledAt))).limit(1);
  if (!activeUser) throw new AppError("account_disabled", "This Orbit account cannot read reviewed intake", 403);
  const [receipts, choices] = await Promise.all([
    getDb().select({
      id: imapIngestionMessages.id,
      status: imapIngestionMessages.status,
      householdId: imapIngestionMessages.householdId,
      draftVersion: imapIngestionMessages.draftVersion,
      proposal: imapIngestionMessages.proposal,
      fieldEvidence: imapIngestionMessages.fieldEvidence,
      expiresAt: imapIngestionMessages.expiresAt,
      receivedAt: imapIngestionMessages.receivedAt,
      attachmentCount: sql<number>`count(${imapIngestionAttachments.id})::int`,
    }).from(imapIngestionMessages)
      .leftJoin(imapIngestionAttachments, eq(imapIngestionAttachments.messageId, imapIngestionMessages.id))
      .where(and(eq(imapIngestionMessages.userId, userId), inArray(imapIngestionMessages.status, ["pending_review", "approving", "recoverable"])))
      .groupBy(imapIngestionMessages.id)
      .orderBy(desc(imapIngestionMessages.receivedAt))
      .limit(50),
    getDb().select({ id: households.id, name: households.name })
      .from(memberships).innerJoin(households, eq(households.id, memberships.householdId))
      .where(eq(memberships.userId, userId)).orderBy(asc(households.name)),
  ]);
  const householdSections = choices.length ? await getDb().select({ id: sections.id, householdId: sections.householdId, name: sections.name })
    .from(sections).where(and(inArray(sections.householdId, choices.map((choice) => choice.id)), eq(sections.visible, true))).orderBy(asc(sections.position)) : [];
  return {
    receipts: receipts.map((receipt) => ({
      ...receipt,
      ...sanitizeReviewDraftMetadata({ proposal: receipt.proposal, fieldEvidence: receipt.fieldEvidence }),
    })),
    households: choices.map((household) => ({ ...household, sections: householdSections.filter((section) => section.householdId === household.id) })),
  };
}

/** Retained route compatibility: mailbox drafts now require the reviewed approval contract. */
export async function activateImapReviewItem(userId: string, receiptId: string, sectionId: string): Promise<{ itemId: string }> {
  void userId;
  void receiptId;
  void sectionId;
  throw new AppError("reviewed_intake_approval_required", "Submit the reviewed intake values before publishing household data", 409);
}

/** Discards a private draft and purges unassigned holding ciphertext idempotently. */
export async function discardImapReviewItem(userId: string, receiptId: string): Promise<void> {
  const [activeUser] = await getDb().select({ id: users.id }).from(users).where(and(eq(users.id, userId), isNull(users.disabledAt))).limit(1);
  if (!activeUser) throw new AppError("account_disabled", "This Orbit account cannot discard reviewed intake", 403);
  const [receipt] = await getDb().select().from(imapIngestionMessages)
    .where(and(eq(imapIngestionMessages.id, receiptId), eq(imapIngestionMessages.userId, userId))).limit(1);
  if (!receipt) throw new AppError("inbox_receipt_not_found", "That incoming document is not available", 404);
  if (["discarded", "expired"].includes(receipt.status)) return;

  // Rows created by the prototype remain linked to their item so encrypted
  // bytes and foreign-key targets can be cleaned through the accepted path.
  if (receipt.failureCode === "legacy_review_item" && receipt.reviewItemId) {
    const documentRows = await getDb().select({ id: documents.id }).from(documents).where(and(eq(documents.itemId, receipt.reviewItemId), eq(documents.lifecycle, "available")));
    for (const document of documentRows) await requestDocumentDeletion(userId, document.id);
    await getDb().delete(items).where(eq(items.id, receipt.reviewItemId));
  }

  const assigned = await getDb().select({ documentId: imapIngestionAttachments.assignedDocumentId }).from(imapIngestionAttachments).where(and(
    eq(imapIngestionAttachments.messageId, receipt.id),
    eq(imapIngestionAttachments.status, "assigned"),
  ));
  for (const attachment of assigned) if (attachment.documentId) await requestDocumentDeletion(userId, attachment.documentId).catch((error: unknown) => {
    if (error instanceof AppError && error.code === "document_not_found") return;
    throw error;
  });

  const held = await getDb().select().from(imapIngestionAttachments).where(and(
    eq(imapIngestionAttachments.messageId, receipt.id),
    inArray(imapIngestionAttachments.status, ["stored", "assigned"]),
  ));
  for (const attachment of held) {
    try {
      await purgeHeldImapAttachment(attachment.storageKey);
    } catch {
      await getDb().update(imapIngestionMessages).set({ status: "recoverable", failureCode: "staging_purge_failed", updatedAt: new Date() }).where(eq(imapIngestionMessages.id, receipt.id));
      throw new AppError("staging_purge_failed", "The private staged file could not be purged; retry discard", 503);
    }
  }
  await getDb().update(imapIngestionMessages).set({ status: "discarded", discardedAt: new Date(), updatedAt: new Date() }).where(eq(imapIngestionMessages.id, receipt.id));
}

export async function assignImapReceiptHousehold(userId: string, receiptId: string, householdId: string): Promise<{ receiptId: string }> {
  const [activeUser] = await getDb().select({ id: users.id }).from(users).where(and(eq(users.id, userId), isNull(users.disabledAt))).limit(1);
  if (!activeUser) throw new AppError("account_disabled", "This Orbit account cannot assign reviewed intake", 403);
  const changed = await getDb().transaction(async (transaction) => {
    const [membership] = await transaction.select({ householdId: memberships.householdId }).from(memberships).innerJoin(households, eq(households.id, memberships.householdId))
      .where(and(eq(memberships.userId, userId), eq(memberships.householdId, householdId), isNull(households.deletionRequestedAt))).limit(1);
    if (!membership) throw new AppError("household_not_found", "That household is not available", 404);
    const [row] = await transaction.update(imapIngestionMessages).set({ householdId, updatedAt: new Date() })
      .where(and(eq(imapIngestionMessages.id, receiptId), eq(imapIngestionMessages.userId, userId), eq(imapIngestionMessages.status, "pending_review"))).returning({ id: imapIngestionMessages.id });
    return row;
  });
  if (!changed) throw new AppError("inbox_receipt_not_found", "That incoming document is not available", 404);
  return { receiptId: changed.id };
}
