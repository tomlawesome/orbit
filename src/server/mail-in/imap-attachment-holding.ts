import { createHash, randomUUID } from "node:crypto";
import { getDocumentConfig } from "@/server/documents/config";
import { decryptDocument, encryptDocument, type DocumentCryptoEnvelope } from "@/server/documents/crypto";
import { LocalDocumentStorage } from "@/server/documents/storage";
import { scanFileWithClamAv } from "@/server/documents/scanner";
import { validateImapAttachmentBytes, normalizeImapAttachmentName } from "./core/imap-attachment-validation";
import type { SupportedDocumentMediaType } from "@/server/documents/validation";

let purgeImplementationForTests: ((storageKey: string) => Promise<void>) | undefined;

function storage() {
  const config = getDocumentConfig();
  return new LocalDocumentStorage(config.storageRoot, config.quarantineRoot);
}

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
  envelope: DocumentCryptoEnvelope;
};

/** Encrypts already-scanned attachment bytes under a holding-only AAD context. */
export async function holdImapAttachment(input: {
  bytes: Buffer;
  displayName: string;
  mediaType: SupportedDocumentMediaType;
  recipientUserId: string;
  receiptId: string;
  onCiphertextAllocated?: (object: { id: string; storageKey: string }) => Promise<void>;
}): Promise<HeldImapAttachment> {
  return holdBytes(randomUUID(), input, input.recipientUserId, input.receiptId, input.onCiphertextAllocated);
}

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
  input: { bytes: Buffer; displayName: string; mediaType: SupportedDocumentMediaType },
  recipientUserId: string,
  receiptId: string,
  onCiphertextAllocated?: (object: { id: string; storageKey: string }) => Promise<void>,
): Promise<HeldImapAttachment> {
  const config = getDocumentConfig();
  const contentSha256 = createHash("sha256").update(input.bytes).digest("hex");
  const encrypted = encryptDocument(input.bytes, stagingContext(id, recipientUserId, receiptId, input.mediaType, input.bytes.length), config.keyEncryptionKey, config.keyId);
  const storageKey = storage().createStorageKey();
  try {
    await onCiphertextAllocated?.({ id, storageKey });
    await storage().writeCiphertext(storageKey, encrypted.ciphertext);
  } catch (error) {
    await storage().deleteCiphertext(storageKey).catch(() => undefined);
    throw error;
  } finally {
    encrypted.ciphertext.fill(0);
  }
  return { id, recipientUserId, receiptId, displayName: input.displayName, mediaType: input.mediaType, sizeBytes: input.bytes.length, contentSha256, storageKey, ciphertextSize: encrypted.ciphertext.length, envelope: encrypted.envelope };
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
  const id = randomUUID();
  const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(input.bytes); controller.close(); } });
  const received = await storage().receive(body, id, config.maxBytes, input.bytes.length);
  try {
    const bytes = await storage().readQuarantine(received.quarantinePath, config.maxBytes);
    try {
      const validated = await validateImapAttachmentBytes(bytes, input.declaredMediaType, { maximumDocumentBytes: config.maxBytes, pdfOnly: input.mailboxIngestion === true });
      if (!validated.ok) throw new Error(validated.code);
      const mediaType = validated.mediaType;
      const displayName = normalizeImapAttachmentName(input.filename ?? "email-attachment", mediaType);
      if (input.mailboxIngestion && config.scanMode !== "required") throw new Error("scanner_disabled");
      if (config.scanMode === "required") {
        const scan = await scanFileWithClamAv(received.quarantinePath, config.clamAv);
        if (scan.status !== "clean") throw new Error(scan.status === "infected" ? "malware_detected" : "scanner_unavailable");
      }
      return await holdBytes(id, { bytes, displayName, mediaType }, input.recipientUserId, input.receiptId, input.onCiphertextAllocated);
    } finally { bytes.fill(0); }
  } finally {
    received.leadingBytes.fill(0);
    await storage().discardQuarantine(received.quarantinePath).catch(() => undefined);
  }
}

/** Opens holding bytes only for re-encryption into an explicitly selected household. */
export async function readHeldImapAttachment(
  attachment: Pick<HeldImapAttachment, "id" | "mediaType" | "sizeBytes" | "storageKey" | "envelope">,
  owner: { recipientUserId: string; receiptId: string },
): Promise<Buffer> {
  const config = getDocumentConfig();
  const ciphertext = await storage().readCiphertext(attachment.storageKey, attachment.sizeBytes + 64);
  try {
    return decryptDocument(ciphertext, stagingContext(attachment.id, owner.recipientUserId, owner.receiptId, attachment.mediaType, attachment.sizeBytes), attachment.envelope, config.keyEncryptionKey);
  } finally {
    ciphertext.fill(0);
  }
}

/** Idempotently removes private holding ciphertext after durable transfer or discard. */
export async function purgeHeldImapAttachment(storageKey: string): Promise<void> {
  if (purgeImplementationForTests) return purgeImplementationForTests(storageKey);
  await storage().deleteCiphertext(storageKey);
}

/** Test seam for deterministic purge-failure recovery coverage. */
export function setImapHoldingPurgeImplementationForTests(implementation: ((storageKey: string) => Promise<void>) | undefined): void {
  purgeImplementationForTests = implementation;
}
