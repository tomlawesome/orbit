/**
 * Settling a mail attachment whose staged document ended terminally (#1802).
 *
 * The mailbox approval is a saga: upload the held bytes, mark the attachment
 * `assigned`/`purgePending`, purge the held copy once the document is
 * `available`. When the document ends terminally the attachment needs the
 * compensating transition, made in the same transaction that rejects the
 * document so the two never disagree: a judged failure ends the attachment,
 * anything else releases it back to `stored` for a member retry.
 */
import { and, eq, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { imapIngestionAttachments, imapIngestionMessages } from "@/db/schema";
import type { MetadataExecutor } from "@/server/metadata/fields";
import { flagStagingPurgeFailed, purgeHeldImapAttachment } from "./imap-attachment-holding";

export type StagedTransferEnd = "released" | "rejected";

/** The receipt code and the attachment's end for a document failure code. */
export function stagedTransferOutcomeOf(documentFailureCode: string): { end: StagedTransferEnd; receiptFailureCode: string } {
  if (documentFailureCode === "unsupported_structure") return { end: "rejected", receiptFailureCode: "attachment_rejected_structure" };
  if (documentFailureCode === "malware_detected") return { end: "rejected", receiptFailureCode: "attachment_rejected_malware" };
  // Unjudged ends (and any future code) release: a wrong release costs one failed retry, a wrong end destroys the held copy.
  return { end: "released", receiptFailureCode: "scan_recovery_expired" };
}

/**
 * Settles the mail attachment whose id is `documentId` after its staged
 * document ended terminally. Runs inside the caller's transaction, which
 * holds the document's advisory lock. Returns what to purge after commit,
 * or undefined when there was nothing to settle (idempotent).
 */
export async function settleStagedMailTransfer(
  transaction: MetadataExecutor,
  documentId: string,
  documentFailureCode: string,
  now: Date,
): Promise<{ end: StagedTransferEnd; messageId: string; purgeStorageKey?: string } | undefined> {
  const held = and(
    eq(imapIngestionAttachments.id, documentId),
    eq(imapIngestionAttachments.status, "assigned"),
    eq(imapIngestionAttachments.assignedDocumentId, documentId),
    eq(imapIngestionAttachments.purgePending, true),
  );
  const [attachment] = await transaction.select({
    id: imapIngestionAttachments.id,
    messageId: imapIngestionAttachments.messageId,
    storageKey: imapIngestionAttachments.storageKey,
  }).from(imapIngestionAttachments).where(held).for("update").limit(1);
  if (!attachment) return undefined;
  const { end, receiptFailureCode } = stagedTransferOutcomeOf(documentFailureCode);
  if (end === "released") {
    await transaction.update(imapIngestionAttachments).set({
      status: "stored",
      assignedDocumentId: null,
      purgePending: false,
      purgeFailureCode: null,
      transferClaimToken: null,
      transferClaimedAt: null,
      transferLeaseExpiresAt: null,
      updatedAt: now,
    }).where(held);
  } else {
    // The bytes are still there until the post-commit purge: purge_pending keeps that meaning.
    await transaction.update(imapIngestionAttachments).set({ status: "rejected", updatedAt: now }).where(held);
  }
  await transaction.update(imapIngestionMessages).set({ failureCode: receiptFailureCode, updatedAt: now }).where(and(
    eq(imapIngestionMessages.id, attachment.messageId),
    eq(imapIngestionMessages.status, "recoverable"),
    eq(imapIngestionMessages.failureCode, "scanner_unavailable"),
  ));
  return { end, messageId: attachment.messageId, purgeStorageKey: end === "rejected" ? attachment.storageKey : undefined };
}

/**
 * Post-commit purge of an ended attachment's held copy. A failure leaves
 * `rejected`/`purgePending` with the bytes present; the storage orphan sweep
 * removes the unreferenced object after its grace period.
 */
export async function purgeRejectedHeldCopy(attachmentId: string, storageKey: string): Promise<void> {
  const outstanding = and(
    eq(imapIngestionAttachments.id, attachmentId),
    eq(imapIngestionAttachments.status, "rejected"),
    eq(imapIngestionAttachments.purgePending, true),
  );
  try {
    await purgeHeldImapAttachment(storageKey);
    await getDb().update(imapIngestionAttachments).set({ purgePending: false, purgeFailureCode: null, updatedAt: new Date() }).where(outstanding);
  } catch {
    await flagStagingPurgeFailed(getDb(), outstanding);
  }
}

/** Settles inside a short transaction of its own, under the document's advisory lock (the approval's route, #1802). */
export async function settleStagedMailTransferLocked(documentId: string, documentFailureCode: string): Promise<void> {
  const settled = await getDb().transaction(async (transaction) => {
    await transaction.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`orbit:document:${documentId}`}, 0))`);
    return settleStagedMailTransfer(transaction, documentId, documentFailureCode, new Date());
  });
  if (settled?.purgeStorageKey) await purgeRejectedHeldCopy(documentId, settled.purgeStorageKey);
}
