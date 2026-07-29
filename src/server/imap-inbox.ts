import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, inArray, isNull, lt, or, sql } from "drizzle-orm";
import { AppError } from "@/lib/app-error";
import { getDb } from "@/db";
import { documents, households, imapIngestionAttachments, imapIngestionMessages, imapIngestionStagingObjects, items, memberships, sections, users } from "@/db/schema";
import { purgeHeldImapAttachment } from "@/server/imap-attachment-holding";
import { requestDocumentDeletion } from "@/server/document-repository";
import { sanitizeReviewDraftMetadata } from "@/server/reviewed-intake";

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
      failureCode: imapIngestionMessages.failureCode,
      attachmentCount: sql<number>`count(${imapIngestionAttachments.id})::int`,
    }).from(imapIngestionMessages)
      .leftJoin(imapIngestionAttachments, eq(imapIngestionAttachments.messageId, imapIngestionMessages.id))
      .where(and(eq(imapIngestionMessages.userId, userId), or(
        inArray(imapIngestionMessages.status, ["pending_review", "approving", "recoverable"]),
        and(eq(imapIngestionMessages.status, "failed"), eq(imapIngestionMessages.failureCode, "legacy_review_item")),
      )))
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
      cleanupOnly: receipt.status === "failed" && receipt.failureCode === "legacy_review_item",
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
      await getDb().update(imapIngestionAttachments).set({ status: "rejected", purgePending: false, purgeFailureCode: null, updatedAt: new Date() })
        .where(and(eq(imapIngestionAttachments.id, attachment.id), inArray(imapIngestionAttachments.status, ["stored", "assigned"])));
    } catch {
      await getDb().update(imapIngestionMessages).set({ status: "recoverable", failureCode: "staging_purge_failed", updatedAt: new Date() }).where(eq(imapIngestionMessages.id, receipt.id));
      throw new AppError("staging_purge_failed", "The private staged file could not be purged; retry discard", 503);
    }
  }
  await getDb().update(imapIngestionMessages).set({ status: "discarded", discardedAt: new Date(), updatedAt: new Date() }).where(eq(imapIngestionMessages.id, receipt.id));
}

/** Expires bounded batches of private drafts only after their ciphertext is purged. */
export async function purgeExpiredImapStaging(now = new Date(), limit = 25): Promise<void> {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("IMAP staging purge limit is invalid");
  for (let processed = 0; processed < limit; processed += 1) {
    const claim = await getDb().transaction(async (transaction) => {
      const [candidate] = await transaction.select({
        id: imapIngestionMessages.id,
        status: imapIngestionMessages.status,
        lockedAt: imapIngestionMessages.attachmentProcessingLockedAt,
      }).from(imapIngestionMessages).where(and(
        lt(imapIngestionMessages.expiresAt, now),
        or(
          inArray(imapIngestionMessages.status, ["pending_review", "recoverable"]),
          and(eq(imapIngestionMessages.status, "processing"), or(isNull(imapIngestionMessages.attachmentProcessingLockedAt), lt(imapIngestionMessages.attachmentProcessingLockedAt, new Date(now.getTime() - 10 * 60_000)))),
        ),
      )).orderBy(asc(imapIngestionMessages.expiresAt)).for("update").limit(1);
      if (!candidate) return undefined;
      if (candidate.status === "processing" && candidate.lockedAt && candidate.lockedAt.getTime() > now.getTime() - 10 * 60_000) return undefined;
      const token = randomUUID();
      const [claimed] = await transaction.update(imapIngestionMessages).set({
        status: "recoverable",
        receiptStatus: "pending",
        failureCode: "staging_expiry_pending",
        attachmentProcessingLockedAt: now,
        attachmentProcessingLeaseToken: token,
        attachmentProcessingNextAttemptAt: null,
        updatedAt: now,
      }).where(eq(imapIngestionMessages.id, candidate.id)).returning({ id: imapIngestionMessages.id, token: imapIngestionMessages.attachmentProcessingLeaseToken });
      if (!claimed?.token) return undefined;
      await transaction.update(imapIngestionAttachments).set({ purgePending: true, purgeFailureCode: null, updatedAt: now }).where(and(
        eq(imapIngestionAttachments.messageId, candidate.id),
        or(
          eq(imapIngestionAttachments.status, "stored"),
          and(eq(imapIngestionAttachments.status, "assigned"), eq(imapIngestionAttachments.purgePending, true)),
        ),
      ));
      await transaction.update(imapIngestionStagingObjects).set({ status: "purge_pending", purgeFailureCode: null, updatedAt: now })
        .where(eq(imapIngestionStagingObjects.messageId, candidate.id));
      return { id: claimed.id, token: claimed.token };
    });
    if (!claim) break;
    const attachments = await getDb().select({ id: imapIngestionAttachments.id, storageKey: imapIngestionAttachments.storageKey, status: imapIngestionAttachments.status })
      .from(imapIngestionAttachments).where(and(
        eq(imapIngestionAttachments.messageId, claim.id),
        or(
          eq(imapIngestionAttachments.status, "stored"),
          and(eq(imapIngestionAttachments.status, "assigned"), eq(imapIngestionAttachments.purgePending, true)),
        ),
      ));
    const stagingObjects = await getDb().select({ storageKey: imapIngestionStagingObjects.storageKey })
      .from(imapIngestionStagingObjects).where(eq(imapIngestionStagingObjects.messageId, claim.id));
    const attachmentKeys = new Set(attachments.map((attachment) => attachment.storageKey));
    let failed = false;
    for (const attachment of attachments) {
      try {
        await purgeHeldImapAttachment(attachment.storageKey);
        await getDb().transaction(async (transaction) => {
          if (attachment.status === "stored") {
            await transaction.update(imapIngestionAttachments).set({ status: "rejected", purgePending: false, purgeFailureCode: null, updatedAt: now })
              .where(and(eq(imapIngestionAttachments.id, attachment.id), eq(imapIngestionAttachments.status, "stored"), eq(imapIngestionAttachments.purgePending, true)));
          } else {
            await transaction.update(imapIngestionAttachments).set({ purgePending: false, purgeFailureCode: null, updatedAt: now })
              .where(and(eq(imapIngestionAttachments.id, attachment.id), eq(imapIngestionAttachments.status, "assigned"), eq(imapIngestionAttachments.purgePending, true)));
          }
          await transaction.delete(imapIngestionStagingObjects).where(and(eq(imapIngestionStagingObjects.messageId, claim.id), eq(imapIngestionStagingObjects.storageKey, attachment.storageKey), eq(imapIngestionStagingObjects.status, "purge_pending")));
        });
      } catch {
        failed = true;
        await getDb().update(imapIngestionAttachments).set({ purgePending: true, purgeAttempts: sql`${imapIngestionAttachments.purgeAttempts} + 1`, purgeFailureCode: "staging_purge_failed", updatedAt: now })
          .where(and(eq(imapIngestionAttachments.id, attachment.id), eq(imapIngestionAttachments.purgePending, true)));
        await getDb().update(imapIngestionStagingObjects).set({ purgeAttempts: sql`${imapIngestionStagingObjects.purgeAttempts} + 1`, purgeFailureCode: "staging_purge_failed", updatedAt: now })
          .where(and(eq(imapIngestionStagingObjects.messageId, claim.id), eq(imapIngestionStagingObjects.storageKey, attachment.storageKey)));
      }
    }
    for (const object of stagingObjects) {
      if (attachmentKeys.has(object.storageKey)) continue;
      try {
        await purgeHeldImapAttachment(object.storageKey);
        await getDb().delete(imapIngestionStagingObjects).where(and(eq(imapIngestionStagingObjects.messageId, claim.id), eq(imapIngestionStagingObjects.storageKey, object.storageKey), eq(imapIngestionStagingObjects.status, "purge_pending")));
      } catch {
        failed = true;
        await getDb().update(imapIngestionStagingObjects).set({ purgeAttempts: sql`${imapIngestionStagingObjects.purgeAttempts} + 1`, purgeFailureCode: "staging_purge_failed", updatedAt: now })
          .where(and(eq(imapIngestionStagingObjects.messageId, claim.id), eq(imapIngestionStagingObjects.storageKey, object.storageKey)));
      }
    }
    await getDb().update(imapIngestionMessages).set({
      status: failed ? "recoverable" : "expired",
      expiredAt: failed ? null : now,
      failureCode: failed ? "staging_purge_failed" : null,
      attachmentProcessingLockedAt: null,
      attachmentProcessingLeaseToken: null,
      attachmentProcessingNextAttemptAt: null,
      updatedAt: now,
    }).where(and(eq(imapIngestionMessages.id, claim.id), eq(imapIngestionMessages.attachmentProcessingLeaseToken, claim.token)));
  }
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
