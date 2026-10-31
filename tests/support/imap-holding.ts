import { randomUUID } from "node:crypto";
import { getDocumentConfig, wrappingKey } from "@/server/documents/config";
import { createDocumentSealer } from "@/server/documents/crypto";
import { openDocumentStorage } from "@/server/documents/storage";
import type { HeldImapAttachment } from "@/server/mail-in/imap-attachment-holding";

/**
 * Holds `bytes` as a private mail-in attachment the way a test needs one: not
 * validated, not scanned, any content (the worker tests hold text that is not
 * a PDF). It goes through the storage's public calls only (`receive` into
 * quarantine, then `sealQuarantine` into an object, under the holding-only
 * context `readHeldImapAttachment` opens), so it does not depend on which
 * holding functions the module keeps. The module's own write path is
 * `scanAndHoldImapAttachment`, which the holding tests cover.
 */
export async function holdAttachmentBytes(input: {
  bytes: Buffer;
  displayName: string;
  mediaType: HeldImapAttachment["mediaType"];
  recipientUserId: string;
  receiptId: string;
  onCiphertextAllocated?: (object: { id: string; storageKey: string }) => Promise<void>;
}): Promise<HeldImapAttachment> {
  const id = randomUUID();
  const config = getDocumentConfig();
  const storage = openDocumentStorage(config);
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(input.bytes));
      controller.close();
    },
  });
  const received = await storage.receive(body, id, Math.max(config.maxBytes, input.bytes.length), input.bytes.length);
  const storageKey = storage.createStorageKey();
  try {
    await input.onCiphertextAllocated?.({ id, storageKey });
    const wrap = wrappingKey(config);
    const sealer = createDocumentSealer({
      documentId: id,
      householdId: `imap-staging:${input.recipientUserId}`,
      itemId: `receipt:${input.receiptId}`,
      mediaType: input.mediaType,
      plaintextSize: input.bytes.length,
    }, wrap.keyEncryptionKey, wrap.keyId);
    const sealed = await storage.sealQuarantine(
      received.quarantinePath,
      { sizeBytes: received.sizeBytes, contentSha256: received.contentSha256 },
      sealer,
      { kind: "object", storageKey },
    );
    return {
      id,
      recipientUserId: input.recipientUserId,
      receiptId: input.receiptId,
      displayName: input.displayName,
      mediaType: input.mediaType,
      sizeBytes: input.bytes.length,
      contentSha256: received.contentSha256,
      storageKey,
      ciphertextSize: sealed.ciphertextSize,
      envelope: sealed.envelope,
    };
  } catch (error) {
    await storage.deleteCiphertext(storageKey).catch(() => undefined);
    throw error;
  } finally {
    await storage.discardQuarantine(received.quarantinePath).catch(() => undefined);
  }
}
