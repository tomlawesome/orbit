import { randomUUID } from "node:crypto";
import { and, asc, eq, isNull } from "drizzle-orm";
import { getDb } from "@/db";
import { households, imapIngestionAttachments, imapIngestionMessages, items, sections } from "@/db/schema";
import { readHeldImapAttachment } from "@/server/imap-attachment-holding";
import { createDocumentDraft } from "@/server/document-drafts";
import { uploadItemDocument } from "@/server/document-repository";
import { getDocumentConfig } from "@/server/documents/config";
import { LocalDocumentStorage } from "@/server/documents/storage";

function streamFrom(bytes: Buffer): ReadableStream<Uint8Array> {
  return new ReadableStream({ start(controller) { controller.enqueue(bytes); controller.close(); } });
}

/**
 * Converts a verified IMAP receipt into one hidden, archived item.  The item
 * is scoped before any document is made household-readable; this preserves
 * the ownership boundary while leaving nothing for the recipient to upload
 * again.  A receipt without a household deliberately remains private.
 */
export async function materializeImapReviewItem(userId: string, receiptId: string): Promise<string | undefined> {
  const [receipt] = await getDb().select().from(imapIngestionMessages)
    .where(and(eq(imapIngestionMessages.id, receiptId), eq(imapIngestionMessages.userId, userId), eq(imapIngestionMessages.status, "pending_review"))).limit(1);
  if (!receipt?.householdId) return undefined;

  const [section] = await getDb().select({ id: sections.id }).from(sections)
    .where(and(eq(sections.householdId, receipt.householdId), eq(sections.visible, true)))
    .orderBy(asc(sections.position)).limit(1);
  if (!section) throw new Error("IMAP review item needs a visible household section");

  const [household] = await getDb().select({ currency: households.defaultCurrency }).from(households).where(eq(households.id, receipt.householdId)).limit(1);
  if (!household) return undefined;

  let itemId = receipt.reviewItemId;
  if (!itemId) {
    const proposedItemId = randomUUID();
    await getDb().insert(items).values({
      id: proposedItemId, householdId: receipt.householdId, sectionId: section.id,
      title: "Incoming document awaiting review", currency: household.currency, status: "archived", requiresReview: true,
    });
    const [claimed] = await getDb().update(imapIngestionMessages).set({ reviewItemId: proposedItemId, updatedAt: new Date() })
      .where(and(eq(imapIngestionMessages.id, receipt.id), isNull(imapIngestionMessages.reviewItemId))).returning({ id: imapIngestionMessages.id });
    if (!claimed) {
      await getDb().delete(items).where(eq(items.id, proposedItemId));
      itemId = (await getDb().select({ reviewItemId: imapIngestionMessages.reviewItemId }).from(imapIngestionMessages).where(eq(imapIngestionMessages.id, receipt.id)).limit(1))[0]?.reviewItemId;
      if (!itemId) return undefined;
    } else itemId = proposedItemId;
  }

  const attachments = await getDb().select().from(imapIngestionAttachments)
    .where(and(eq(imapIngestionAttachments.messageId, receipt.id), eq(imapIngestionAttachments.status, "stored")));
  const storage = new LocalDocumentStorage(getDocumentConfig().storageRoot, getDocumentConfig().quarantineRoot);
  for (const attachment of attachments) {
    const bytes = await readHeldImapAttachment({
      id: attachment.id, mediaType: attachment.mediaType, sizeBytes: attachment.sizeBytes, storageKey: attachment.storageKey,
      envelope: { envelopeVersion: attachment.envelopeVersion as 1, algorithm: "aes-256-gcm", contentIv: attachment.contentIv, contentAuthTag: attachment.contentAuthTag, wrappedDek: attachment.wrappedDek, wrapIv: attachment.wrapIv, wrapAuthTag: attachment.wrapAuthTag, keyId: attachment.keyId },
    });
    try {
      const document = await uploadItemDocument({ userId, householdId: receipt.householdId, itemId, filename: attachment.displayName, body: streamFrom(bytes), declaredBytes: attachment.sizeBytes });
      await getDb().update(imapIngestionAttachments).set({ status: "assigned", assignedDocumentId: document.id, updatedAt: new Date() }).where(eq(imapIngestionAttachments.id, attachment.id));
      await storage.deleteCiphertext(attachment.storageKey).catch(() => undefined);
      // Extraction is advisory: a scanner/Tika outage never loses the stored review item.
      await createDocumentDraft(userId, document.id).catch(() => undefined);
    } finally { bytes.fill(0); }
  }
  return itemId;
}
