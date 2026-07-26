import { createHash, randomUUID } from "node:crypto";
import { getDocumentConfig } from "@/server/documents/config";
import { decryptDocument, encryptDocument, type DocumentCryptoEnvelope } from "@/server/documents/crypto";
import { LocalDocumentStorage } from "@/server/documents/storage";

const HOLDING_HOUSEHOLD = "imap-holding";
const HOLDING_ITEM = "unassigned";

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
  const config = getDocumentConfig();
  const id = randomUUID();
  const contentSha256 = createHash("sha256").update(input.bytes).digest("hex");
  const encrypted = encryptDocument(input.bytes, {
    documentId: id, householdId: HOLDING_HOUSEHOLD, itemId: HOLDING_ITEM,
    mediaType: input.mediaType, plaintextSize: input.bytes.length,
  }, config.keyEncryptionKey, config.keyId);
  const storageKey = storage().createStorageKey();
  await storage().writeCiphertext(storageKey, encrypted.ciphertext);
  return { id, displayName: input.displayName, mediaType: input.mediaType, sizeBytes: input.bytes.length, contentSha256, storageKey, ciphertextSize: encrypted.ciphertext.length, envelope: encrypted.envelope };
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
