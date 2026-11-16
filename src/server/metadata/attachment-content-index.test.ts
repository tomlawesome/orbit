import { createHash, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ATTACHMENT_CONTENT_HASH_COLUMN, CONTENT_HASH_COLUMN, openContentHash, sealContentHash } from "@/server/documents/content-hash";
import { MetadataCipher } from "@/server/metadata/fields";

/* #1778, build note B (design note 58551): the primitives of #1771 gain a
   column, and a fourth blind-indexed column appears:
   - `MetadataColumn` gains "imap_ingestion_attachments.content_sha256";
   - `MetadataCipher.attachmentContentIndex(messageId, sha256Hex)` is the blind
     index of `<messageId>:<sha256Hex>` under that column;
   - `sealContentHash` / `openContentHash` take a trailing `column` argument
     (default `CONTENT_HASH_COLUMN`) and `ATTACHMENT_CONTENT_HASH_COLUMN` is
     exported. */

const messageA = "11111111-1111-4111-8111-111111111111";
const messageB = "22222222-2222-4222-8222-222222222222";
const attachmentA = "33333333-3333-4333-8333-333333333333";
const attachmentB = "44444444-4444-4444-8444-444444444444";
const householdId = "66666666-6666-4666-8666-666666666666";
const sha = createHash("sha256").update("the same bytes").digest("hex");
const otherSha = createHash("sha256").update("other bytes").digest("hex");

const dataKey = randomBytes(32);
const cipherOf = (key = dataKey) => new MetadataCipher({ scope: "household", householdId, keyId: "key-one", dataKey: key });

describe("the attachment blind index (#1778)", () => {
  it("names its column as the mail-in attachment hash", () => {
    expect(ATTACHMENT_CONTENT_HASH_COLUMN).toBe("imap_ingestion_attachments.content_sha256");
    expect(ATTACHMENT_CONTENT_HASH_COLUMN).not.toBe(CONTENT_HASH_COLUMN);
  });

  it("equals itself for the same message and bytes, and is a value, not null", () => {
    const metadata = cipherOf();
    const index = metadata.attachmentContentIndex(messageA, sha);
    expect(index).toEqual(expect.any(String));
    expect(index).toBe(metadata.attachmentContentIndex(messageA, sha));
    expect(index).not.toContain(sha);
  });

  it("differs between two messages for the same bytes, so a dump cannot see equal files across mails", () => {
    const metadata = cipherOf();
    expect(metadata.attachmentContentIndex(messageA, sha)).not.toBe(metadata.attachmentContentIndex(messageB, sha));
  });

  it("differs between two different files of one message", () => {
    const metadata = cipherOf();
    expect(metadata.attachmentContentIndex(messageA, sha)).not.toBe(metadata.attachmentContentIndex(messageA, otherSha));
  });

  it("differs from the document index of the same bytes under the same key", () => {
    const metadata = cipherOf();
    expect(metadata.attachmentContentIndex(messageA, sha)).not.toBe(metadata.contentIndex(sha));
  });

  it("is the blind index of `<messageId>:<sha256>` under the attachment column", () => {
    const metadata = cipherOf();
    expect(metadata.attachmentContentIndex(messageA, sha))
      .toBe(metadata.blindIndex("imap_ingestion_attachments.content_sha256", `${messageA}:${sha}`));
  });

  it("is keyed: another key gives another value", () => {
    expect(cipherOf().attachmentContentIndex(messageA, sha)).not.toBe(cipherOf(randomBytes(32)).attachmentContentIndex(messageA, sha));
  });

  it("is case-insensitive in the hex, as normalisation makes every blind index", () => {
    const metadata = cipherOf();
    expect(metadata.attachmentContentIndex(messageA, sha.toUpperCase())).toBe(metadata.attachmentContentIndex(messageA, sha));
  });
});

describe("a content hash sealed under the attachment column (#1778)", () => {
  it("opens back to the hash with the same column and row id, and the plain hash is not in the envelope", () => {
    const metadata = cipherOf();
    const sealed = sealContentHash(metadata, attachmentA, sha, ATTACHMENT_CONTENT_HASH_COLUMN);
    expect(sealed).not.toContain(sha);
    expect(openContentHash(metadata, attachmentA, { plain: null, sealed }, ATTACHMENT_CONTENT_HASH_COLUMN)).toEqual({ ok: true, sha256: sha });
  });

  it("does not open as a document's hash (documents.content_sha256), the default column", () => {
    const metadata = cipherOf();
    const sealed = sealContentHash(metadata, attachmentA, sha, ATTACHMENT_CONTENT_HASH_COLUMN);
    const opened = openContentHash(metadata, attachmentA, { plain: null, sealed });
    expect(opened.ok).toBe(false);
    expect(opened).toMatchObject({ reason: "metadata_integrity_failed" });
  });

  it("a document's seal does not open under the attachment column", () => {
    const metadata = cipherOf();
    const sealed = sealContentHash(metadata, attachmentA, sha);
    expect(openContentHash(metadata, attachmentA, { plain: null, sealed }, ATTACHMENT_CONTENT_HASH_COLUMN).ok).toBe(false);
  });

  it("does not open under another attachment's id", () => {
    const metadata = cipherOf();
    const sealed = sealContentHash(metadata, attachmentA, sha, ATTACHMENT_CONTENT_HASH_COLUMN);
    expect(openContentHash(metadata, attachmentB, { plain: null, sealed }, ATTACHMENT_CONTENT_HASH_COLUMN).ok).toBe(false);
  });

  it("does not open under another scope's key, and a missing cipher answers locked", () => {
    const sealed = sealContentHash(cipherOf(), attachmentA, sha, ATTACHMENT_CONTENT_HASH_COLUMN);
    expect(openContentHash(cipherOf(randomBytes(32)), attachmentA, { plain: null, sealed }, ATTACHMENT_CONTENT_HASH_COLUMN).ok).toBe(false);
    expect(openContentHash(undefined, attachmentA, { plain: null, sealed }, ATTACHMENT_CONTENT_HASH_COLUMN)).toEqual({ ok: false, reason: "metadata_locked" });
  });

  it("falls back to the plain hash for a row the backfill has not reached, whatever the column", () => {
    expect(openContentHash(undefined, attachmentA, { plain: sha, sealed: null }, ATTACHMENT_CONTENT_HASH_COLUMN)).toEqual({ ok: true, sha256: sha });
  });
});
