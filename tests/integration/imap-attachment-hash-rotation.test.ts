import { randomBytes, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { getDb } from "@/db";
import { metadataKeys } from "@/db/schema";
import { deriveDocumentKeyId, getDocumentConfig, resetDocumentConfigForTests } from "@/server/documents/config";
import { ATTACHMENT_CONTENT_HASH_COLUMN, openContentHash, sealContentHash } from "@/server/documents/content-hash";
import { runKekRotationToCompletion, type RotationKeys } from "@/server/documents/rewrap-worker";
import { openInstanceMetadataReader, requireInstanceMetadataWriter } from "@/server/metadata/fields";
import { resetMetadataKeyCacheForTests } from "@/server/metadata/keys";
import { cleanupIntegrationEnvironment } from "./support/fixtures";
import { sha256Of } from "./support/imap-attachment-hash";

/* #1778: a mail-in attachment hash sealed and indexed under the INSTANCE
   metadata key, as the commit path stores it, is still readable after a
   document KEK rotation: the rotation re-wraps the instance key row, and the
   seal (under the data key) is untouched. Mirrors document-kek-rotation.test.ts. */

afterAll(async () => {
  await cleanupIntegrationEnvironment();
});

function keysFor(nextKek: Buffer): RotationKeys {
  const current = getDocumentConfig();
  return {
    currentKek: current.keyEncryptionKey,
    currentKeyId: current.keyId,
    nextKek,
    nextKeyId: deriveDocumentKeyId(nextKek),
  };
}

describe("an instance-sealed attachment hash survives a document KEK rotation (#1778)", () => {
  it("the instance key row carries the next key id afterwards, and the hash still opens to the original", async () => {
    const originalDocumentKek = process.env.DOCUMENT_KEK;
    const attachmentId = randomUUID();
    const messageId = randomUUID();
    const sha = sha256Of("rotation attachment hash");
    const keys = keysFor(randomBytes(32));
    try {
      const writer = await requireInstanceMetadataWriter();
      const sealed = sealContentHash(writer, attachmentId, sha, ATTACHMENT_CONTENT_HASH_COLUMN);
      const index = writer.attachmentContentIndex(messageId, sha);
      expect(index).not.toBeNull();
      const [before] = await getDb().select({ keyId: metadataKeys.keyId }).from(metadataKeys).where(eq(metadataKeys.scope, "instance"));
      expect(before?.keyId, "the instance key is wrapped under the current KEK").toBe(keys.currentKeyId);

      await runKekRotationToCompletion(keys);

      const [after] = await getDb().select({ keyId: metadataKeys.keyId }).from(metadataKeys).where(eq(metadataKeys.scope, "instance"));
      expect(after?.keyId, "the instance key row now carries the next key id").toBe(keys.nextKeyId);

      process.env.DOCUMENT_KEK = keys.nextKek.toString("hex");
      delete process.env.DOCUMENT_KEK_NEXT;
      resetDocumentConfigForTests();
      resetMetadataKeyCacheForTests();
      const reader = await openInstanceMetadataReader();
      expect(openContentHash(reader, attachmentId, { plain: null, sealed }, ATTACHMENT_CONTENT_HASH_COLUMN)).toEqual({ ok: true, sha256: sha });
      expect((await requireInstanceMetadataWriter()).attachmentContentIndex(messageId, sha), "the blind index is unchanged").toBe(index);
    } finally {
      if (originalDocumentKek === undefined) delete process.env.DOCUMENT_KEK;
      else process.env.DOCUMENT_KEK = originalDocumentKek;
      delete process.env.DOCUMENT_KEK_NEXT;
      resetDocumentConfigForTests();
      /* No later test may inherit a key wrapped under the throwaway KEK. */
      await getDb().delete(metadataKeys).where(eq(metadataKeys.scope, "instance"));
      resetMetadataKeyCacheForTests();
    }
  });
});
