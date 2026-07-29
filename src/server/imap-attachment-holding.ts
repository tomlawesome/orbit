import { createHash, randomUUID } from "node:crypto";
import { getDocumentConfig } from "@/server/documents/config";
import { decryptDocument, encryptDocument, type DocumentCryptoEnvelope } from "@/server/documents/crypto";
import { LocalDocumentStorage } from "@/server/documents/storage";
import { scanFileWithClamAv } from "@/server/documents/scanner";
import { detectDocumentMediaType, normalizedDocumentFilename } from "@/server/documents/validation";

const HOLDING_HOUSEHOLD = "imap-holding";
const HOLDING_ITEM = "unassigned";
let purgeImplementationForTests: ((storageKey: string) => Promise<void>) | undefined;

function storage() {
  const config = getDocumentConfig();
  return new LocalDocumentStorage(config.storageRoot, config.quarantineRoot);
}

export type HeldImapAttachment = {
  id: string;
  displayName: string;
  mediaType: string;
  sizeBytes: number;
  contentSha256: string;
  storageKey: string;
  ciphertextSize: number;
  envelope: DocumentCryptoEnvelope;
};

/** Encrypts already-scanned attachment bytes under a holding-only AAD context. */
export async function holdImapAttachment(input: { bytes: Buffer; displayName: string; mediaType: string }): Promise<HeldImapAttachment> {
  return holdBytes(randomUUID(), input);
}

async function holdBytes(id: string, input: { bytes: Buffer; displayName: string; mediaType: string }): Promise<HeldImapAttachment> {
  const config = getDocumentConfig();
  const contentSha256 = createHash("sha256").update(input.bytes).digest("hex");
  const encrypted = encryptDocument(input.bytes, {
    documentId: id, householdId: HOLDING_HOUSEHOLD, itemId: HOLDING_ITEM,
    mediaType: input.mediaType, plaintextSize: input.bytes.length,
  }, config.keyEncryptionKey, config.keyId);
  const storageKey = storage().createStorageKey();
  await storage().writeCiphertext(storageKey, encrypted.ciphertext);
  return { id, displayName: input.displayName, mediaType: input.mediaType, sizeBytes: input.bytes.length, contentSha256, storageKey, ciphertextSize: encrypted.ciphertext.length, envelope: encrypted.envelope };
}

/** Streams an inbound attachment through the existing bounded scanner before holding it encrypted. */
export async function scanAndHoldImapAttachment(input: { bytes: Buffer; filename?: string; declaredMediaType?: string }): Promise<HeldImapAttachment> {
  const config = getDocumentConfig();
  const id = randomUUID();
  const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(input.bytes); controller.close(); } });
  const received = await storage().receive(body, id, config.maxBytes, input.bytes.length);
  try {
    const mediaType = detectDocumentMediaType(received.leadingBytes);
    const displayName = normalizedDocumentFilename(input.filename ?? "email-attachment", mediaType);
    if (config.scanMode === "required") {
      const scan = await scanFileWithClamAv(received.quarantinePath, config.clamAv);
      if (scan.status !== "clean") throw new Error(scan.status === "infected" ? "malware_detected" : "scanner_unavailable");
    }
    const bytes = await storage().readQuarantine(received.quarantinePath, config.maxBytes);
    try { return await holdBytes(id, { bytes, displayName, mediaType }); } finally { bytes.fill(0); }
  } finally {
    await storage().discardQuarantine(received.quarantinePath).catch(() => undefined);
  }
}

/** Opens holding bytes only for re-encryption into an explicitly selected household. */
export async function readHeldImapAttachment(attachment: Pick<HeldImapAttachment, "id" | "mediaType" | "sizeBytes" | "storageKey" | "envelope">): Promise<Buffer> {
  const config = getDocumentConfig();
  const ciphertext = await storage().readCiphertext(attachment.storageKey, attachment.sizeBytes + 64);
  return decryptDocument(ciphertext, {
    documentId: attachment.id, householdId: HOLDING_HOUSEHOLD, itemId: HOLDING_ITEM,
    mediaType: attachment.mediaType, plaintextSize: attachment.sizeBytes,
  }, attachment.envelope, config.keyEncryptionKey);
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
