import { afterEach, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { metadataKeys } from "@/db/schema";
import { resetMetadataKeyCacheForTests } from "@/server/metadata/keys";
import { householdOfMessage, indexFor, sealFor } from "./imap-attachment-hash";

/* Column values for a seeded `imap_ingestion_attachments` row the way the #1778
   writer stores them (design note 58551): the plain hash is NULL, the hash is
   sealed under the receipt's scope key (the household's, or the instance key
   while the receipt has none) bound to the attachment id, and the blind index
   covers `<messageId>:<sha256>` under the instance key. The message row must
   already exist. Spread the result into an insert:
   `{ id, messageId, ..., ...await sealedHash(messageId, id, sha) }`. */
export async function sealedHash(messageId: string, attachmentId: string, sha256: string) {
  const household = await householdOfMessage(messageId);
  return {
    contentSha256: null,
    contentSha256Sealed: await sealFor(household ? { household } : "instance", attachmentId, sha256),
    contentIndex: await indexFor(messageId, sha256),
  };
}

/** For tests that rotate the document KEK to a throwaway key: that rewraps the
 * shared instance `metadata_keys` row (which `sealedHash` mints on first use)
 * under the throwaway key, and a later test would find it unreadable. Call at
 * the top level of the file: each test starts from, and is put back to, the
 * instance row it found (or none). */
export function preserveInstanceMetadataKey() {
  let before: Array<typeof metadataKeys.$inferSelect> = [];
  beforeEach(async () => {
    before = await getDb().select().from(metadataKeys).where(eq(metadataKeys.scope, "instance"));
  });
  afterEach(async () => {
    await getDb().transaction(async (tx) => {
      await tx.delete(metadataKeys).where(eq(metadataKeys.scope, "instance"));
      if (before.length > 0) await tx.insert(metadataKeys).values(before);
    });
    resetMetadataKeyCacheForTests();
  });
}
