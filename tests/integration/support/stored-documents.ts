import { createHash, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { documentCrypto, documents } from "@/db/schema";
import { deriveDocumentKeyId, getDocumentConfig } from "@/server/documents/config";
import { encryptDocument, type DocumentEncryptionContext } from "@/server/documents/crypto";
import { openDocumentStorage } from "@/server/documents/storage";
import type { IntegrationFixture } from "./fixtures";

/**
 * Real, readable documents for the fixture's item: each one is encrypted and
 * written to the document store the way an upload leaves it, with its row and
 * crypto row, so `readDocumentDownload` (and anything built on it) returns the
 * exact bytes given. The fixture's own placeholder document has a row but no
 * stored file, so it is removed first; otherwise an export that reads every
 * document of the household would stop on it.
 *
 * Returns the ids in the order of `contents`.
 */
export async function seedStoredDocuments(fixture: IntegrationFixture, contents: Buffer[]): Promise<string[]> {
  const db = getDb();
  await db.delete(documents).where(eq(documents.id, fixture.document.id));
  const config = getDocumentConfig();
  const kek = config.keyEncryptionKey;
  const keyId = deriveDocumentKeyId(kek);
  const storage = openDocumentStorage(config);
  await storage.initialize();
  const ids: string[] = [];
  for (const [index, plaintext] of contents.entries()) {
    const documentId = randomUUID();
    const context: DocumentEncryptionContext = {
      documentId,
      householdId: fixture.household.id,
      itemId: fixture.item.id,
      mediaType: "application/pdf",
      plaintextSize: plaintext.length,
    };
    const encrypted = encryptDocument(plaintext, context, kek, keyId);
    const storageKey = storage.createStorageKey();
    await storage.writeCiphertext(storageKey, encrypted.ciphertext);
    await db.insert(documents).values({
      id: documentId,
      householdId: fixture.household.id,
      itemId: fixture.item.id,
      uploadedByUserId: fixture.users.owner.id,
      displayName: `stored-${index}.pdf`,
      mediaType: context.mediaType,
      sizeBytes: plaintext.length,
      contentSha256: createHash("sha256").update(plaintext).digest("hex"),
      lifecycle: "available",
      scanStatus: "skipped",
      availableAt: new Date(),
    });
    await db.insert(documentCrypto).values({
      documentId,
      storageKey,
      ciphertextSize: encrypted.ciphertext.length,
      envelopeVersion: encrypted.envelope.envelopeVersion,
      contentIv: encrypted.envelope.contentIv,
      contentAuthTag: encrypted.envelope.contentAuthTag,
      wrappedDek: encrypted.envelope.wrappedDek,
      wrapIv: encrypted.envelope.wrapIv,
      wrapAuthTag: encrypted.envelope.wrapAuthTag,
      keyId: encrypted.envelope.keyId,
    });
    ids.push(documentId);
  }
  return ids;
}
