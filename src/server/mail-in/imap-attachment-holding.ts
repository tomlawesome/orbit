import { randomUUID } from "node:crypto";
import { sql, type SQL } from "drizzle-orm";
import type { getDb } from "@/db";
import { imapIngestionAttachments } from "@/db/schema";
import { getDocumentConfig, keyEncryptionKeyFor, wrappingKey } from "@/server/documents/config";
import { readEffectiveUploadLimit } from "@/server/upload-limit";
import { createDocumentSealer, decryptDocument, type CryptoEnvelope } from "@/server/documents/crypto";
import { openDocumentStorage, type ReceivedDocument } from "@/server/documents/storage";
import { scanFileWithClamAv } from "@/server/documents/scanner";
import { classifyScan, documentScanCodes } from "@/server/documents/scan-outcome";
import { identifyImapAttachmentBytes, normalizeImapAttachmentName } from "./core/imap-attachment-validation";
import { validateSupportedDocumentStructure, type SupportedDocumentMediaType } from "@/server/documents/validation";

/** A database or a transaction: anything that can run an UPDATE. */
type DbWriter = Pick<ReturnType<typeof getDb>, "update">;

/**
 * Records that deleting a held attachment's private copy failed, and counts
 * the attempt. The caller names the rows in `where` (#1349, engine-18): the
 * predicates differ per caller on purpose, and each one must say what it
 * means to be the same outstanding purge.
 *
 * Only re-flag a purge that is still outstanding (#722). A concurrent caller
 * may have purged the private copy and cleared the flag while this attempt
 * was in flight, in which case this failure is of a delete with nothing left
 * to delete: stamping purgePending and a failure code here would advertise
 * work already done, and count an attempt against it. A caller that does not
 * already hold the row's lock says so in `where`, with `purgePending = true`.
 */
export async function flagStagingPurgeFailed(db: DbWriter, where: SQL | undefined, at = new Date()): Promise<void> {
  await db.update(imapIngestionAttachments).set({
    purgePending: true,
    purgeAttempts: sql`${imapIngestionAttachments.purgeAttempts} + 1`,
    purgeFailureCode: "staging_purge_failed",
    updatedAt: at,
  }).where(where);
}

let purgeImplementationForTests: ((storageKey: string) => Promise<void>) | undefined;

export type HeldImapAttachment = {
  id: string;
  recipientUserId: string;
  receiptId: string;
  displayName: string;
  mediaType: string;
  sizeBytes: number;
  contentSha256: string;
  storageKey: string;
  ciphertextSize: number;
  envelope: CryptoEnvelope;
};

function stagingContext(id: string, userId: string, receiptId: string, mediaType: string, plaintextSize: number) {
  if (!userId || !receiptId) throw new Error("IMAP staging owner is required");
  return {
    documentId: id,
    // These are deliberately not a household/item identity. The recipient
    // and receipt are authenticated AAD, and approval supplies the eventual
    // household only after explicit user action.
    householdId: `imap-staging:${userId}`,
    itemId: `receipt:${receiptId}`,
    mediaType,
    plaintextSize,
  };
}

async function holdBytes(
  id: string,
  input: { quarantinePath: string; sizeBytes: number; contentSha256: string; displayName: string; mediaType: SupportedDocumentMediaType },
  recipientUserId: string,
  receiptId: string,
  onCiphertextAllocated?: (object: { id: string; storageKey: string }) => Promise<void>,
): Promise<HeldImapAttachment> {
  const config = getDocumentConfig();
  // The next key while a rotation is in progress, the current key otherwise (#955).
  const wrap = wrappingKey(config);
  const sealer = createDocumentSealer(stagingContext(id, recipientUserId, receiptId, input.mediaType, input.sizeBytes), wrap.keyEncryptionKey, wrap.keyId);
  const storageKey = openDocumentStorage().createStorageKey();
  try {
    await onCiphertextAllocated?.({ id, storageKey });
    const sealed = await openDocumentStorage().sealQuarantine(
      input.quarantinePath,
      { sizeBytes: input.sizeBytes, contentSha256: input.contentSha256 },
      sealer,
      { kind: "object", storageKey },
    );
    return { id, recipientUserId, receiptId, displayName: input.displayName, mediaType: input.mediaType, sizeBytes: input.sizeBytes, contentSha256: input.contentSha256, storageKey, ciphertextSize: sealed.ciphertextSize, envelope: sealed.envelope };
  } catch (error) {
    await openDocumentStorage().deleteCiphertext(storageKey).catch(() => undefined);
    throw error;
  }
}

/**
 * Identifies, scans and structure-checks the received file. The check's one
 * copy of it lives in this frame only and is zeroed here, so the seal that
 * follows never runs with it held (#1571, as the upload's own check does).
 */
async function checkReceivedAttachment(
  received: ReceivedDocument,
  input: { filename?: string; declaredMediaType?: string; mailboxIngestion?: boolean },
  maxBytes: number,
): Promise<{ mediaType: SupportedDocumentMediaType; displayName: string }> {
  const config = getDocumentConfig();
  const bytes = await openDocumentStorage().readQuarantine(received.quarantinePath, maxBytes);
  try {
    // Size, magic bytes and declared type only: nothing opens the file yet.
    const identified = identifyImapAttachmentBytes(bytes, input.declaredMediaType, { maximumDocumentBytes: maxBytes, pdfOnly: input.mailboxIngestion === true });
    if (!identified.ok) throw new Error(identified.code);
    const mediaType = identified.mediaType;
    const displayName = normalizeImapAttachmentName(input.filename ?? "email-attachment", mediaType);
    if (input.mailboxIngestion && config.scanMode !== "required") throw new Error("scanner_disabled");
    if (config.scanMode === "required") {
      const outcome = classifyScan(await scanFileWithClamAv(received.quarantinePath, config.clamAv), documentScanCodes);
      // The shared mapping, so a protocol error is recorded as one rather
      // than folded into "unavailable" (engine-7). Anything but a clean scan
      // stops here: nothing is opened or held.
      if (outcome.status !== "clean") throw new Error(outcome.code);
    }
    // ADR-0033: the renderer opens it only once the scan has passed.
    if (!await validateSupportedDocumentStructure(bytes, mediaType, { path: received.quarantinePath, sizeBytes: received.sizeBytes })) throw new Error("mime_structure_invalid");
    return { mediaType, displayName };
  } finally {
    bytes.fill(0);
  }
}

/** Streams an inbound attachment through the existing bounded scanner before holding it encrypted. */
export async function scanAndHoldImapAttachment(input: {
  bytes: Buffer;
  filename?: string;
  declaredMediaType?: string;
  recipientUserId: string;
  receiptId: string;
  mailboxIngestion?: boolean;
  onCiphertextAllocated?: (object: { id: string; storageKey: string }) => Promise<void>;
}): Promise<HeldImapAttachment> {
  const config = getDocumentConfig();
  // The administrator's limit, read now so a change needs no restart (#1285).
  const maxBytes = await readEffectiveUploadLimit(config);
  const id = randomUUID();
  const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(input.bytes); controller.close(); } });
  const received = await openDocumentStorage().receive(body, id, maxBytes, input.bytes.length);
  try {
    const { mediaType, displayName } = await checkReceivedAttachment(received, input, maxBytes);
    return await holdBytes(id, { quarantinePath: received.quarantinePath, sizeBytes: received.sizeBytes, contentSha256: received.contentSha256, displayName, mediaType }, input.recipientUserId, input.receiptId, input.onCiphertextAllocated);
  } finally {
    received.leadingBytes.fill(0);
    await openDocumentStorage().discardQuarantine(received.quarantinePath).catch(() => undefined);
  }
}

/** Opens holding bytes for re-encryption into an explicitly selected household,
 * and (#1155) for a page-one render that never leaves memory: both callers
 * decrypt the same ciphertext under the same recipient/receipt-bound context
 * and the plaintext never reaches disk either way. */
export async function readHeldImapAttachment(
  attachment: Pick<HeldImapAttachment, "id" | "mediaType" | "sizeBytes" | "storageKey" | "envelope">,
  owner: { recipientUserId: string; receiptId: string },
): Promise<Buffer> {
  const config = getDocumentConfig();
  // Picks by the envelope's own key_id (#954): held attachments are
  // short-lived, but not so short-lived that a rotation in progress can be
  // assumed never to span one.
  const holdingKek = keyEncryptionKeyFor(config, attachment.envelope.keyId);
  if (!holdingKek) throw new Error("held attachment is wrapped under a key this instance does not hold");
  const ciphertext = await openDocumentStorage().readCiphertext(attachment.storageKey, attachment.sizeBytes + 64);
  try {
    return decryptDocument(ciphertext, stagingContext(attachment.id, owner.recipientUserId, owner.receiptId, attachment.mediaType, attachment.sizeBytes), attachment.envelope, holdingKek);
  } finally {
    ciphertext.fill(0);
  }
}

/** Idempotently removes private holding ciphertext after durable transfer or discard. */
export async function purgeHeldImapAttachment(storageKey: string): Promise<void> {
  if (purgeImplementationForTests) return purgeImplementationForTests(storageKey);
  await openDocumentStorage().deleteCiphertext(storageKey);
}

/** Test seam for deterministic purge-failure recovery coverage. */
export function setImapHoldingPurgeImplementationForTests(implementation: ((storageKey: string) => Promise<void>) | undefined): void {
  purgeImplementationForTests = implementation;
}
