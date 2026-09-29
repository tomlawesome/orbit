import { and, eq, gt } from "drizzle-orm";
import { getDb } from "@/db";
import { imapIngestionAttachments, imapIngestionMessages } from "@/db/schema";
import { AppError } from "@/lib/app-error";
import { renderDocumentPagePreview, type DocumentPagePreview } from "@/server/documents/preview";
import { validUuid } from "@/server/workspace-access";
import { readHeldImapAttachment } from "./imap-attachment-holding";
import { privateMailboxUser } from "./imap-inbox";

function inboxReceiptNotFound(): AppError {
  return new AppError("inbox_receipt_not_found", "That incoming document is not available", 404);
}

/**
 * A page-one picture of an attachment still staged inside a waiting mail
 * receipt (#1155) — decrypted under the same holding context acceptance
 * uses, rendered by the same `renderDocumentPagePreview` an accepted
 * document's preview uses, and answered only to the recipient the mail is
 * addressed to. No `documents` row is read or created; acceptance is
 * unchanged.
 *
 * Every case that is not the recipient's own live, stored attachment answers
 * the same `inbox_receipt_not_found` 404 as a missing mail — another
 * member, signed out, an instance admin, a right attachment id under the
 * wrong receipt id, a discarded or expired receipt, a purge-pending or
 * already-assigned attachment, a malformed uuid — mirroring `getImapReview`
 * (imap-inbox.ts:302-326). Never a 403: that would tell another user the
 * attachment exists.
 *
 * No audit row is written for a preview. `recordDocumentAudit` is keyed on a
 * household and a `documents` row, and a waiting attachment has neither; the
 * renderer's own bounded `document.preview` refusal log (#494) already
 * covers failures.
 */
export async function readHeldImapAttachmentPreview(
  userId: string,
  receiptId: string,
  attachmentId: string,
): Promise<DocumentPagePreview> {
  const user = await privateMailboxUser(userId);
  if (user.isInstanceAdmin) throw inboxReceiptNotFound();
  if (!validUuid(receiptId) || !validUuid(attachmentId)) throw inboxReceiptNotFound();

  const [row] = await getDb().select({
    id: imapIngestionAttachments.id,
    mediaType: imapIngestionAttachments.mediaType,
    sizeBytes: imapIngestionAttachments.sizeBytes,
    storageKey: imapIngestionAttachments.storageKey,
    envelopeVersion: imapIngestionAttachments.envelopeVersion,
    contentIv: imapIngestionAttachments.contentIv,
    contentAuthTag: imapIngestionAttachments.contentAuthTag,
    wrappedDek: imapIngestionAttachments.wrappedDek,
    wrapIv: imapIngestionAttachments.wrapIv,
    wrapAuthTag: imapIngestionAttachments.wrapAuthTag,
    keyId: imapIngestionAttachments.keyId,
  }).from(imapIngestionAttachments)
    .innerJoin(imapIngestionMessages, eq(imapIngestionMessages.id, imapIngestionAttachments.messageId))
    .where(and(
      eq(imapIngestionMessages.id, receiptId),
      eq(imapIngestionMessages.userId, userId),
      eq(imapIngestionMessages.status, "pending_review"),
      gt(imapIngestionMessages.expiresAt, new Date()),
      eq(imapIngestionAttachments.id, attachmentId),
      eq(imapIngestionAttachments.messageId, receiptId),
      eq(imapIngestionAttachments.status, "stored"),
      eq(imapIngestionAttachments.purgePending, false),
    ))
    .limit(1);
  if (!row) throw inboxReceiptNotFound();

  const bytes = await readHeldImapAttachment({
    id: row.id,
    mediaType: row.mediaType,
    sizeBytes: row.sizeBytes,
    storageKey: row.storageKey,
    envelope: {
      envelopeVersion: row.envelopeVersion as 1,
      algorithm: "aes-256-gcm",
      contentIv: row.contentIv,
      contentAuthTag: row.contentAuthTag,
      wrappedDek: row.wrappedDek,
      wrapIv: row.wrapIv,
      wrapAuthTag: row.wrapAuthTag,
      keyId: row.keyId,
    },
  }, { recipientUserId: userId, receiptId });
  try {
    // The row's real mediaType, not reviewAttachmentMediaType() -- that one
    // narrows to pdf/octet-stream for the list display and would misdraw
    // (or wrongly refuse) anything else the renderer actually supports.
    return await renderDocumentPagePreview(bytes, row.mediaType);
  } finally {
    bytes.fill(0);
  }
}
