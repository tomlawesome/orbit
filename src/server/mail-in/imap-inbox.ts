import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, inArray, isNotNull, isNull, lte, lt, or, sql } from "drizzle-orm";
import { AppError } from "@/lib/app-error";
import { getDb } from "@/db";
import { documents, households, imapIngestionAttachments, imapIngestionMessages, imapIngestionStagingObjects, items, memberships, sections, users } from "@/db/schema";
import { purgeHeldImapAttachment } from "./imap-attachment-holding";
import { requestDocumentDeletion } from "@/server/document-repository";
import { sanitizeReviewDraftMetadata } from "@/server/reviewed-intake";
import { validUuid } from "@/server/workspace-access";
import {
  reviewInboxState,
  findReviewedIntakeCandidateReason,
  reviewAttachmentDisplayName,
  reviewAttachmentMediaType,
  reviewAttachmentScanState,
  type ReviewAttachmentMediaType,
  type ReviewInboxClassification,
  type ReviewInboxStateContext,
} from "./core/review-state";

// Re-exported so `@/server/imap-inbox` (now a deprecated stub pointing here)
// keeps every existing import path working churn-free. See
// src/server/mail-in/core/review-state.ts for the implementations.
export { reviewInboxState, findReviewedIntakeCandidateReason, reviewAttachmentDisplayName, reviewAttachmentMediaType, reviewAttachmentScanState };
export type { ReviewAttachmentMediaType, ReviewInboxClassification, ReviewInboxStateContext };

const IMAP_STAGING_PURGE_RETRY_DELAY_MS = 60_000;
/** Bounds every read on this endpoint: 50 receipts and 50 filed items, each
 * carrying at most IMAP_ATTACHMENT_LIMITS.attachmentCount (10) attachments. */
const REVIEW_INBOX_PAGE = 50;
const REVIEW_INBOX_ATTACHMENT_PAGE = 1_000;

/** Statuses a receipt can hold while it is still somewhere in the review journey. */
const reviewLaneStatuses = ["processing", "pending_review", "approving", "recoverable", "failed", "quarantined"] as const;

/** A staged attachment named for its recipient, and nobody else (#467). */
export type ReviewInboxAttachment = {
  id: string;
  ordinal: number;
  displayName: string;
  mediaType: ReviewAttachmentMediaType;
  sizeBytes: number;
  scanState: "clean" | "unknown";
};

/** One item the relay fed into the reader's orbit, and the document it rode in on. */
export type MailFiledItem = {
  itemId: string;
  householdId: string;
  title: string;
  itemStatus: string;
  documentName: string | null;
  documentCount: number;
  filedAt: Date | null;
};

function orderedAttachments(rows: Array<{ id: string; displayName: string; mediaType: string; sizeBytes: number; status: string }>): ReviewInboxAttachment[] {
  return rows.map((row, index) => ({
    id: row.id,
    ordinal: index + 1,
    displayName: reviewAttachmentDisplayName(row.displayName, row.mediaType),
    mediaType: reviewAttachmentMediaType(row.mediaType),
    sizeBytes: row.sizeBytes,
    scanState: reviewAttachmentScanState(row.status),
  }));
}

async function privateMailboxUser(userId: string): Promise<{ id: string; isInstanceAdmin: boolean }> {
  const [user] = await getDb().select({ id: users.id, isInstanceAdmin: users.isInstanceAdmin }).from(users)
    .where(and(eq(users.id, userId), isNull(users.disabledAt))).limit(1);
  if (!user) throw new AppError("account_disabled", "This Orbit account cannot read reviewed intake", 403);
  return user;
}

async function hasHouseholdMembership(userId: string, householdId: string): Promise<boolean> {
  const [membership] = await getDb().select({ householdId: memberships.householdId }).from(memberships)
    .innerJoin(households, eq(households.id, memberships.householdId))
    .where(and(eq(memberships.userId, userId), eq(memberships.householdId, householdId), isNull(households.deletionRequestedAt))).limit(1);
  return Boolean(membership);
}

/**
 * Returns only the caller's receipt states; subjects and headers stay
 * private. Since #467 each held attachment is also named — the sanitized
 * original filename, its size and its scanned-clean state — because the
 * sender was the reader themself and the count alone cannot say which
 * document is waiting.
 *
 * The `filed` lane answers the other half: which items this reader's relay
 * has already fed into their orbit. It is keyed on `approvedItemId` and
 * never on the receipt's status, so it survives the receipt's own burn-up —
 * the 45-day expiry sweeper only ever claims a receipt still in review, and
 * an approved one keeps its item link, its approval timestamp and its
 * assigned attachment rows for good.
 */
export async function listImapInbox(userId: string) {
  const activeUser = await privateMailboxUser(userId);
  if (activeUser.isInstanceAdmin) return { receipts: [], households: [], filed: [] as MailFiledItem[] };
  const filedAt = sql<Date | null>`coalesce(${imapIngestionMessages.approvedAt}, ${imapIngestionMessages.approvalStartedAt})`;
  const [receipts, choices, attachmentRows, filedRows] = await Promise.all([
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
      hasApprovalOperation: isNotNull(imapIngestionMessages.approvalOperationId),
      hasApprovedItem: isNotNull(imapIngestionMessages.approvedItemId),
      attachmentCount: sql<number>`count(${imapIngestionAttachments.id})::int`,
    }).from(imapIngestionMessages)
      .leftJoin(imapIngestionAttachments, eq(imapIngestionAttachments.messageId, imapIngestionMessages.id))
      .where(and(eq(imapIngestionMessages.userId, userId), inArray(imapIngestionMessages.status, [...reviewLaneStatuses])))
      .groupBy(imapIngestionMessages.id)
      .orderBy(desc(imapIngestionMessages.receivedAt))
      .limit(REVIEW_INBOX_PAGE),
    getDb().select({ id: households.id, name: households.name, currency: households.defaultCurrency })
      .from(memberships).innerJoin(households, eq(households.id, memberships.householdId))
      .where(and(eq(memberships.userId, userId), isNull(households.deletionRequestedAt))).orderBy(asc(households.name)),
    // Named attachments for both lanes in one bounded, user-scoped read: the
    // ones still held for review, and the ones already filed into an item.
    getDb().select({
      id: imapIngestionAttachments.id,
      messageId: imapIngestionAttachments.messageId,
      displayName: imapIngestionAttachments.displayName,
      mediaType: imapIngestionAttachments.mediaType,
      sizeBytes: imapIngestionAttachments.sizeBytes,
      status: imapIngestionAttachments.status,
    }).from(imapIngestionAttachments)
      .innerJoin(imapIngestionMessages, eq(imapIngestionMessages.id, imapIngestionAttachments.messageId))
      .where(and(
        eq(imapIngestionMessages.userId, userId),
        or(inArray(imapIngestionMessages.status, [...reviewLaneStatuses]), isNotNull(imapIngestionMessages.approvedItemId)),
        inArray(imapIngestionAttachments.status, ["stored", "assigned"]),
      ))
      // Newest first so that if a very long-lived mailbox ever reaches the
      // bound it is the oldest names that fall off — the same end the
      // receipt and filed pages drop. Each message's own rows are put back
      // into arrival order below, which is what the ordinal counts.
      .orderBy(desc(imapIngestionAttachments.createdAt), desc(imapIngestionAttachments.id))
      .limit(REVIEW_INBOX_ATTACHMENT_PAGE),
    getDb().select({
      itemId: items.id,
      householdId: items.householdId,
      title: items.title,
      itemStatus: items.status,
      messageId: imapIngestionMessages.id,
      filedAt,
    }).from(imapIngestionMessages)
      // The item is the authority on which household this belongs to; a
      // receipt whose household no longer matches its item is not filed
      // anywhere the reader can open, so it is simply absent.
      .innerJoin(items, and(eq(items.id, imapIngestionMessages.approvedItemId), eq(items.householdId, imapIngestionMessages.householdId)))
      .where(and(
        eq(imapIngestionMessages.userId, userId),
        isNotNull(imapIngestionMessages.approvedItemId),
        inArray(items.status, ["active", "expired", "cancelled"]),
      ))
      .orderBy(desc(filedAt), desc(imapIngestionMessages.receivedAt))
      .limit(REVIEW_INBOX_PAGE),
  ]);
  const visibleHouseholdIds = new Set(choices.map((choice) => choice.id));
  const attachmentsByMessage = new Map<string, typeof attachmentRows>();
  for (const row of attachmentRows) {
    const existing = attachmentsByMessage.get(row.messageId);
    if (existing) existing.push(row); else attachmentsByMessage.set(row.messageId, [row]);
  }
  for (const rows of attachmentsByMessage.values()) rows.reverse();
  return {
    receipts: receipts.filter((receipt) => !receipt.householdId || visibleHouseholdIds.has(receipt.householdId)).map((receipt) => {
      const state = reviewInboxState(receipt.status, receipt.failureCode, {
        hasApprovalOperation: Boolean(receipt.hasApprovalOperation),
        hasApprovedItem: Boolean(receipt.hasApprovedItem),
        expiresAt: receipt.expiresAt,
      });
      const metadata = state.classification === "ready" || state.classification === "retry"
        ? sanitizeReviewDraftMetadata({ proposal: receipt.proposal, fieldEvidence: receipt.fieldEvidence })
        : { proposal: {}, fieldEvidence: {} };
      return {
        id: receipt.id,
        status: receipt.status,
        householdId: receipt.householdId,
        draftVersion: receipt.draftVersion,
        expiresAt: receipt.expiresAt,
        receivedAt: receipt.receivedAt,
        attachmentCount: receipt.attachmentCount,
        attachments: orderedAttachments(attachmentsByMessage.get(receipt.id) ?? []),
        ...state,
        cleanupOnly: state.classification === "cleanup",
        ...metadata,
      };
    }),
    households: choices,
    // Same household boundary as the receipts above: an item in a household
    // the reader has left, or one scheduled for deletion, is not theirs to
    // see even though their own mail created it.
    filed: filedRows.filter((row) => visibleHouseholdIds.has(row.householdId)).map((row): MailFiledItem => {
      const filedDocuments = (attachmentsByMessage.get(row.messageId) ?? []).filter((attachment) => attachment.status === "assigned");
      return {
        itemId: row.itemId,
        householdId: row.householdId,
        title: row.title,
        itemStatus: row.itemStatus,
        documentName: filedDocuments.length ? reviewAttachmentDisplayName(filedDocuments[0].displayName, filedDocuments[0].mediaType) : null,
        documentCount: filedDocuments.length,
        filedAt: row.filedAt,
      };
    }),
  };
}

/** Reads one owned draft only after the selected household has been authorized. */
export async function getImapReview(userId: string, receiptId: string, householdId: string) {
  const user = await privateMailboxUser(userId);
  if (user.isInstanceAdmin) throw new AppError("inbox_receipt_not_found", "That incoming document is not available", 404);
  if (!(await hasHouseholdMembership(userId, householdId))) throw new AppError("inbox_receipt_not_found", "That incoming document is not available", 404);
  // A malformed id must fail the same bounded way an unknown one does,
  // rather than reach the uuid column as text and 500 (#383).
  if (!validUuid(receiptId)) throw new AppError("inbox_receipt_not_found", "That incoming document is not available", 404);
  const [receipt] = await getDb().select({
    id: imapIngestionMessages.id,
    status: imapIngestionMessages.status,
    householdId: imapIngestionMessages.householdId,
    draftVersion: imapIngestionMessages.draftVersion,
    proposal: imapIngestionMessages.proposal,
    fieldEvidence: imapIngestionMessages.fieldEvidence,
    expiresAt: imapIngestionMessages.expiresAt,
    receivedAt: imapIngestionMessages.receivedAt,
    failureCode: imapIngestionMessages.failureCode,
    hasApprovalOperation: isNotNull(imapIngestionMessages.approvalOperationId),
    hasApprovedItem: isNotNull(imapIngestionMessages.approvedItemId),
  }).from(imapIngestionMessages).where(and(
    eq(imapIngestionMessages.id, receiptId),
    eq(imapIngestionMessages.userId, userId),
    eq(imapIngestionMessages.householdId, householdId),
  )).limit(1);
  if (!receipt) throw new AppError("inbox_receipt_not_found", "That incoming document is not available", 404);
  const state = reviewInboxState(receipt.status, receipt.failureCode, {
    hasApprovalOperation: Boolean(receipt.hasApprovalOperation),
    hasApprovedItem: Boolean(receipt.hasApprovedItem),
    expiresAt: receipt.expiresAt,
  });
  const metadata = state.classification === "ready" || state.classification === "retry"
    ? sanitizeReviewDraftMetadata({ proposal: receipt.proposal, fieldEvidence: receipt.fieldEvidence })
    : { proposal: {}, fieldEvidence: {} };
  if (!state.canApprove) return { receipt: { id: receipt.id, status: receipt.status, householdId, draftVersion: receipt.draftVersion, expiresAt: receipt.expiresAt, receivedAt: receipt.receivedAt, ...state, ...metadata }, sections: [], candidates: [], attachments: [] };

  const [householdSections, householdItems, attachments] = await Promise.all([
    getDb().select({ id: sections.id, name: sections.name }).from(sections)
      .where(and(eq(sections.householdId, householdId), eq(sections.visible, true), isNull(sections.archivedAt))).orderBy(asc(sections.position)),
    getDb().select({ id: items.id, title: items.title, provider: items.provider, reference: items.reference, subtype: items.subtype })
      .from(items).where(and(eq(items.householdId, householdId), inArray(items.status, ["active", "expired", "cancelled"]))).orderBy(asc(items.title)).limit(200),
    getDb().select({
      id: imapIngestionAttachments.id,
      displayName: imapIngestionAttachments.displayName,
      mediaType: imapIngestionAttachments.mediaType,
      sizeBytes: imapIngestionAttachments.sizeBytes,
      status: imapIngestionAttachments.status,
    })
      .from(imapIngestionAttachments).where(and(eq(imapIngestionAttachments.messageId, receiptId), inArray(imapIngestionAttachments.status, ["stored", "assigned"])))
      .orderBy(asc(imapIngestionAttachments.createdAt), asc(imapIngestionAttachments.id)),
  ]);
  const candidates = householdItems.flatMap((item) => {
    const reason = findReviewedIntakeCandidateReason(metadata.proposal, item);
    return reason ? [{ itemId: item.id, title: item.title, reason }] : [];
  }).slice(0, 10);
  return {
    receipt: { id: receipt.id, status: receipt.status, householdId, draftVersion: receipt.draftVersion, expiresAt: receipt.expiresAt, receivedAt: receipt.receivedAt, ...state, ...metadata },
    sections: householdSections,
    candidates,
    attachments: orderedAttachments(attachments),
  };
}

/** Discards a private draft and purges unassigned holding ciphertext idempotently. */
export async function discardImapReviewItem(userId: string, receiptId: string): Promise<void> {
  const activeUser = await privateMailboxUser(userId);
  if (activeUser.isInstanceAdmin) throw new AppError("inbox_receipt_not_found", "That incoming document is not available", 404);
  // A malformed id must fail the same bounded way an unknown one does,
  // rather than reach the uuid column as text and 500 (#383).
  if (!validUuid(receiptId)) throw new AppError("inbox_receipt_not_found", "That incoming document is not available", 404);
  const [receipt] = await getDb().select().from(imapIngestionMessages)
    .where(and(eq(imapIngestionMessages.id, receiptId), eq(imapIngestionMessages.userId, userId))).limit(1);
  if (!receipt) throw new AppError("inbox_receipt_not_found", "That incoming document is not available", 404);
  if (receipt.householdId && !(await hasHouseholdMembership(userId, receipt.householdId))) throw new AppError("inbox_receipt_not_found", "That incoming document is not available", 404);
  if (["discarded", "expired"].includes(receipt.status)) return;

  const cleanupToken = randomUUID();
  const now = new Date();
  const claimed = await getDb().transaction(async (transaction) => {
    const [current] = await transaction.select({ id: imapIngestionMessages.id, status: imapIngestionMessages.status, lockedAt: imapIngestionMessages.attachmentProcessingLockedAt }).from(imapIngestionMessages)
      .where(and(
        eq(imapIngestionMessages.id, receipt.id),
        eq(imapIngestionMessages.userId, userId),
        or(
          inArray(imapIngestionMessages.status, ["pending_review", "recoverable"]),
          and(eq(imapIngestionMessages.status, "failed"), eq(imapIngestionMessages.failureCode, "legacy_review_item")),
        ),
      )).for("update").limit(1);
    if (!current || (current.lockedAt && current.lockedAt.getTime() > now.getTime() - 10 * 60_000)) return false;
    const [changed] = await transaction.update(imapIngestionMessages).set({ status: "recoverable", receiptStatus: "pending", failureCode: "staging_purge_pending", attachmentProcessingLockedAt: now, attachmentProcessingLeaseToken: cleanupToken, attachmentProcessingNextAttemptAt: null, updatedAt: now })
      .where(and(eq(imapIngestionMessages.id, receipt.id), eq(imapIngestionMessages.status, current.status))).returning({ id: imapIngestionMessages.id });
    if (!changed) return false;
    await transaction.update(imapIngestionAttachments).set({ purgePending: true, purgeFailureCode: null, updatedAt: now }).where(and(
      eq(imapIngestionAttachments.messageId, receipt.id),
      or(eq(imapIngestionAttachments.status, "stored"), eq(imapIngestionAttachments.status, "assigned")),
    ));
    await transaction.update(imapIngestionStagingObjects).set({ status: "purge_pending", purgeFailureCode: null, updatedAt: now }).where(eq(imapIngestionStagingObjects.messageId, receipt.id));
    return true;
  });
  if (!claimed) {
    const [latest] = await getDb().select({ status: imapIngestionMessages.status }).from(imapIngestionMessages).where(eq(imapIngestionMessages.id, receipt.id)).limit(1);
    if (latest && ["discarded", "expired"].includes(latest.status)) return;
    throw new AppError("staging_cleanup_busy", "The incoming document is already being cleaned up; retry discard", 409);
  }

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
    eq(imapIngestionAttachments.purgePending, true),
  ));
  const stagingObjects = await getDb().select({ storageKey: imapIngestionStagingObjects.storageKey }).from(imapIngestionStagingObjects).where(and(eq(imapIngestionStagingObjects.messageId, receipt.id), eq(imapIngestionStagingObjects.status, "purge_pending")));
  const keys = [...new Set([...held.map((attachment) => attachment.storageKey), ...stagingObjects.map((object) => object.storageKey)])];
  let fenced = false;
  for (const storageKey of keys) {
    try {
      await purgeHeldImapAttachment(storageKey);
      const applied = await getDb().transaction(async (transaction) => {
        const [current] = await transaction.select({ id: imapIngestionMessages.id }).from(imapIngestionMessages)
          .where(and(eq(imapIngestionMessages.id, receipt.id), eq(imapIngestionMessages.status, "recoverable"), eq(imapIngestionMessages.attachmentProcessingLeaseToken, cleanupToken))).for("update").limit(1);
        if (!current) return false;
        await transaction.update(imapIngestionAttachments).set({ status: "rejected", purgePending: false, purgeFailureCode: null, updatedAt: now })
          .where(and(eq(imapIngestionAttachments.messageId, receipt.id), eq(imapIngestionAttachments.storageKey, storageKey), inArray(imapIngestionAttachments.status, ["stored", "assigned"]), eq(imapIngestionAttachments.purgePending, true)));
        await transaction.delete(imapIngestionStagingObjects).where(and(eq(imapIngestionStagingObjects.messageId, receipt.id), eq(imapIngestionStagingObjects.storageKey, storageKey), eq(imapIngestionStagingObjects.status, "purge_pending")));
        return true;
      });
      if (!applied) { fenced = true; break; }
    } catch {
      await getDb().transaction(async (transaction) => {
        const [current] = await transaction.select({ id: imapIngestionMessages.id }).from(imapIngestionMessages)
          .where(and(eq(imapIngestionMessages.id, receipt.id), eq(imapIngestionMessages.status, "recoverable"), eq(imapIngestionMessages.attachmentProcessingLeaseToken, cleanupToken))).for("update").limit(1);
        if (!current) return;
        await transaction.update(imapIngestionAttachments).set({ purgePending: true, purgeAttempts: sql`${imapIngestionAttachments.purgeAttempts} + 1`, purgeFailureCode: "staging_purge_failed", updatedAt: now })
          .where(and(eq(imapIngestionAttachments.messageId, receipt.id), eq(imapIngestionAttachments.storageKey, storageKey), eq(imapIngestionAttachments.purgePending, true)));
        await transaction.update(imapIngestionStagingObjects).set({ status: "purge_pending", purgeAttempts: sql`${imapIngestionStagingObjects.purgeAttempts} + 1`, purgeFailureCode: "staging_purge_failed", updatedAt: now })
          .where(and(eq(imapIngestionStagingObjects.messageId, receipt.id), eq(imapIngestionStagingObjects.storageKey, storageKey), eq(imapIngestionStagingObjects.status, "purge_pending")));
        await transaction.update(imapIngestionMessages).set({ status: "recoverable", failureCode: "discard_purge_failed", attachmentProcessingLockedAt: null, attachmentProcessingLeaseToken: null, updatedAt: now })
          .where(and(eq(imapIngestionMessages.id, receipt.id), eq(imapIngestionMessages.attachmentProcessingLeaseToken, cleanupToken)));
      });
      throw new AppError("staging_purge_failed", "The private staged file could not be purged; retry discard", 503);
    }
  }
  if (fenced) return;
  const completed = await getDb().transaction(async (transaction) => {
    const [current] = await transaction.select({ id: imapIngestionMessages.id }).from(imapIngestionMessages)
      .where(and(eq(imapIngestionMessages.id, receipt.id), eq(imapIngestionMessages.status, "recoverable"), eq(imapIngestionMessages.attachmentProcessingLeaseToken, cleanupToken))).for("update").limit(1);
    if (!current) return false;
    await transaction.update(imapIngestionMessages).set({ status: "discarded", receiptStatus: "cancelled", failureCode: null, discardedAt: now, attachmentProcessingLockedAt: null, attachmentProcessingLeaseToken: null, updatedAt: now })
      .where(and(eq(imapIngestionMessages.id, receipt.id), eq(imapIngestionMessages.attachmentProcessingLeaseToken, cleanupToken)));
    return true;
  });
  if (!completed) throw new AppError("staging_cleanup_busy", "The incoming document changed while it was being discarded; retry discard", 409);
}

/** Expires bounded batches of private drafts only after their ciphertext is purged. */
export async function purgeExpiredImapStaging(now = new Date(), limit = 25): Promise<void> {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("IMAP staging purge limit is invalid");
  for (let processed = 0; processed < limit; processed += 1) {
    const claim = await getDb().transaction(async (transaction) => {
      const [candidate] = await transaction.select({
        id: imapIngestionMessages.id,
        status: imapIngestionMessages.status,
        failureCode: imapIngestionMessages.failureCode,
        disabledAt: users.disabledAt,
      }).from(imapIngestionMessages).leftJoin(users, eq(users.id, imapIngestionMessages.userId)).where(and(
        inArray(imapIngestionMessages.status, ["pending_review", "recoverable", "processing"]),
        or(lt(imapIngestionMessages.expiresAt, now), isNotNull(users.disabledAt), and(eq(imapIngestionMessages.status, "recoverable"), eq(imapIngestionMessages.failureCode, "attachment_processing_exhausted"))),
        or(isNull(imapIngestionMessages.attachmentProcessingLockedAt), lt(imapIngestionMessages.attachmentProcessingLockedAt, new Date(now.getTime() - 10 * 60_000))),
        or(isNull(imapIngestionMessages.attachmentProcessingNextAttemptAt), lte(imapIngestionMessages.attachmentProcessingNextAttemptAt, now)),
      )).orderBy(asc(imapIngestionMessages.expiresAt)).limit(1);
      if (!candidate) return undefined;
      const token = randomUUID();
      const [claimed] = await transaction.update(imapIngestionMessages).set({
        status: "recoverable",
        receiptStatus: "pending",
        failureCode: "staging_expiry_pending",
        attachmentProcessingLockedAt: now,
        attachmentProcessingLeaseToken: token,
        attachmentProcessingNextAttemptAt: null,
        updatedAt: now,
      }).where(and(eq(imapIngestionMessages.id, candidate.id), inArray(imapIngestionMessages.status, ["pending_review", "recoverable", "processing"]), or(isNull(imapIngestionMessages.attachmentProcessingLockedAt), lt(imapIngestionMessages.attachmentProcessingLockedAt, new Date(now.getTime() - 10 * 60_000))), or(isNull(imapIngestionMessages.attachmentProcessingNextAttemptAt), lte(imapIngestionMessages.attachmentProcessingNextAttemptAt, now)))).returning({ id: imapIngestionMessages.id, token: imapIngestionMessages.attachmentProcessingLeaseToken });
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
      return { id: claimed.id, token: claimed.token, terminalFailure: candidate.failureCode === "attachment_processing_exhausted", disabled: Boolean(candidate.disabledAt) };
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
    let fenced = false;
    for (const attachment of attachments) {
      try {
        await purgeHeldImapAttachment(attachment.storageKey);
        const applied = await getDb().transaction(async (transaction) => {
          const [current] = await transaction.select({ id: imapIngestionMessages.id }).from(imapIngestionMessages)
            .where(and(eq(imapIngestionMessages.id, claim.id), eq(imapIngestionMessages.status, "recoverable"), eq(imapIngestionMessages.attachmentProcessingLeaseToken, claim.token))).for("update").limit(1);
          if (!current) return false;
          if (attachment.status === "stored") {
            await transaction.update(imapIngestionAttachments).set({ status: "rejected", purgePending: false, purgeFailureCode: null, updatedAt: now })
              .where(and(eq(imapIngestionAttachments.id, attachment.id), eq(imapIngestionAttachments.status, "stored"), eq(imapIngestionAttachments.purgePending, true)));
          } else {
            await transaction.update(imapIngestionAttachments).set({ purgePending: false, purgeFailureCode: null, updatedAt: now })
              .where(and(eq(imapIngestionAttachments.id, attachment.id), eq(imapIngestionAttachments.status, "assigned"), eq(imapIngestionAttachments.purgePending, true)));
          }
          await transaction.delete(imapIngestionStagingObjects).where(and(eq(imapIngestionStagingObjects.messageId, claim.id), eq(imapIngestionStagingObjects.storageKey, attachment.storageKey), eq(imapIngestionStagingObjects.status, "purge_pending")));
          return true;
        });
        if (!applied) { fenced = true; break; }
      } catch {
        failed = true;
        await getDb().transaction(async (transaction) => {
          const [current] = await transaction.select({ id: imapIngestionMessages.id }).from(imapIngestionMessages)
            .where(and(eq(imapIngestionMessages.id, claim.id), eq(imapIngestionMessages.status, "recoverable"), eq(imapIngestionMessages.attachmentProcessingLeaseToken, claim.token))).for("update").limit(1);
          if (!current) return;
          await transaction.update(imapIngestionAttachments).set({ purgePending: true, purgeAttempts: sql`${imapIngestionAttachments.purgeAttempts} + 1`, purgeFailureCode: "staging_purge_failed", updatedAt: now })
            .where(and(eq(imapIngestionAttachments.id, attachment.id), eq(imapIngestionAttachments.purgePending, true)));
          await transaction.update(imapIngestionStagingObjects).set({ purgeAttempts: sql`${imapIngestionStagingObjects.purgeAttempts} + 1`, purgeFailureCode: "staging_purge_failed", updatedAt: now })
            .where(and(eq(imapIngestionStagingObjects.messageId, claim.id), eq(imapIngestionStagingObjects.storageKey, attachment.storageKey), eq(imapIngestionStagingObjects.status, "purge_pending")));
        });
      }
    }
    for (const object of stagingObjects) {
      if (fenced) break;
      if (attachmentKeys.has(object.storageKey)) continue;
      try {
        await purgeHeldImapAttachment(object.storageKey);
        const applied = await getDb().transaction(async (transaction) => {
          const [current] = await transaction.select({ id: imapIngestionMessages.id }).from(imapIngestionMessages)
            .where(and(eq(imapIngestionMessages.id, claim.id), eq(imapIngestionMessages.status, "recoverable"), eq(imapIngestionMessages.attachmentProcessingLeaseToken, claim.token))).for("update").limit(1);
          if (!current) return false;
          await transaction.delete(imapIngestionStagingObjects).where(and(eq(imapIngestionStagingObjects.messageId, claim.id), eq(imapIngestionStagingObjects.storageKey, object.storageKey), eq(imapIngestionStagingObjects.status, "purge_pending")));
          return true;
        });
        if (!applied) { fenced = true; break; }
      } catch {
        failed = true;
        await getDb().transaction(async (transaction) => {
          const [current] = await transaction.select({ id: imapIngestionMessages.id }).from(imapIngestionMessages)
            .where(and(eq(imapIngestionMessages.id, claim.id), eq(imapIngestionMessages.status, "recoverable"), eq(imapIngestionMessages.attachmentProcessingLeaseToken, claim.token))).for("update").limit(1);
          if (!current) return;
          await transaction.update(imapIngestionStagingObjects).set({ purgeAttempts: sql`${imapIngestionStagingObjects.purgeAttempts} + 1`, purgeFailureCode: "staging_purge_failed", updatedAt: now })
            .where(and(eq(imapIngestionStagingObjects.messageId, claim.id), eq(imapIngestionStagingObjects.storageKey, object.storageKey), eq(imapIngestionStagingObjects.status, "purge_pending")));
        });
      }
    }
    if (fenced) continue;
    await getDb().update(imapIngestionMessages).set({
      status: failed ? "recoverable" : claim.terminalFailure ? "failed" : "expired",
      receiptStatus: failed ? "pending" : claim.terminalFailure || claim.disabled ? "cancelled" : "pending",
      expiredAt: failed ? null : now,
      failureCode: failed ? (claim.terminalFailure ? "attachment_processing_exhausted" : "staging_purge_failed") : claim.terminalFailure ? "attachment_processing_exhausted" : claim.disabled ? "account_disabled" : null,
      attachmentProcessingLockedAt: null,
      attachmentProcessingLeaseToken: null,
      attachmentProcessingNextAttemptAt: failed ? new Date(now.getTime() + IMAP_STAGING_PURGE_RETRY_DELAY_MS) : null,
      updatedAt: now,
    }).where(and(eq(imapIngestionMessages.id, claim.id), eq(imapIngestionMessages.attachmentProcessingLeaseToken, claim.token)));
  }
}

export async function assignImapReceiptHousehold(userId: string, receiptId: string, householdId: string): Promise<{ receiptId: string }> {
  const activeUser = await privateMailboxUser(userId);
  if (activeUser.isInstanceAdmin) throw new AppError("inbox_receipt_not_found", "That incoming document is not available", 404);
  // A malformed id must fail the same bounded way an unknown one does,
  // rather than reach the uuid column as text and 500 (#383).
  if (!validUuid(receiptId)) throw new AppError("inbox_receipt_not_found", "That incoming document is not available", 404);
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
