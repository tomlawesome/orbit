import { describe, expect, it } from "vitest";
import { MetadataCipher } from "@/server/metadata/fields";
import { CONTENT_HASH_COLUMN, openContentHash, sealContentHash } from "@/server/documents/content-hash";

// #1771: the content hash is sealed under the household metadata key, bound to
// the row id, and read sealed-first with the legacy plain column as fallback.
// A sealed value that will not open answers no hash, never a guess.

const DOC = "00000000-0000-4000-8000-000000000001";
const OTHER_DOC = "00000000-0000-4000-8000-000000000002";
const SHA = "a".repeat(64);
const OTHER_SHA = "b".repeat(64);

function cipher(fill: number): MetadataCipher {
  return new MetadataCipher({ scope: "household", householdId: "household-1", keyId: `key-${fill}`, dataKey: Buffer.alloc(32, fill) });
}

describe("content hash sealing (#1771)", () => {
  it("names the documents.content_sha256 column key", () => {
    expect(CONTENT_HASH_COLUMN).toBe("documents.content_sha256");
  });

  it("round-trips a sealed hash under the same key and row", () => {
    const key = cipher(7);
    const sealed = sealContentHash(key, DOC, SHA);
    expect(sealed).not.toContain(SHA);
    expect(openContentHash(key, DOC, { plain: null, sealed })).toEqual({ ok: true, sha256: SHA });
  });

  it("refuses to seal an empty hash", () => {
    expect(() => sealContentHash(cipher(7), DOC, "")).toThrow(/empty content hash/);
  });

  it("throws on a locked cipher when sealing", () => {
    expect(() => sealContentHash(new MetadataCipher(undefined), DOC, SHA)).toThrow();
  });

  it("prefers the sealed value over a plain one still on the row", () => {
    const key = cipher(7);
    const sealed = sealContentHash(key, DOC, SHA);
    expect(openContentHash(key, DOC, { plain: OTHER_SHA, sealed })).toEqual({ ok: true, sha256: SHA });
  });

  it("answers metadata_locked for a sealed value with no cipher", () => {
    const sealed = sealContentHash(cipher(7), DOC, SHA);
    expect(openContentHash(undefined, DOC, { plain: SHA, sealed })).toEqual({ ok: false, reason: "metadata_locked" });
  });

  it("answers metadata_locked for a sealed value with a locked cipher", () => {
    const sealed = sealContentHash(cipher(7), DOC, SHA);
    expect(openContentHash(new MetadataCipher(undefined), DOC, { plain: null, sealed })).toEqual({ ok: false, reason: "metadata_locked" });
  });

  it("answers no hash for a sealed value moved from another row", () => {
    const key = cipher(7);
    const sealed = sealContentHash(key, OTHER_DOC, SHA);
    expect(openContentHash(key, DOC, { plain: SHA, sealed })).toEqual({ ok: false, reason: "metadata_integrity_failed" });
  });

  it("answers no hash for a sealed value under another household's key", () => {
    const sealed = sealContentHash(cipher(7), DOC, SHA);
    expect(openContentHash(cipher(8), DOC, { plain: null, sealed })).toEqual({ ok: false, reason: "metadata_integrity_failed" });
  });

  it("falls back to the plain hash on a row the backfill has not reached, with or without a cipher", () => {
    expect(openContentHash(undefined, DOC, { plain: SHA, sealed: null })).toEqual({ ok: true, sha256: SHA });
    expect(openContentHash(cipher(7), DOC, { plain: SHA, sealed: null })).toEqual({ ok: true, sha256: SHA });
  });

  it("answers content_hash_missing when neither column holds a hash", () => {
    expect(openContentHash(cipher(7), DOC, { plain: null, sealed: null })).toEqual({ ok: false, reason: "content_hash_missing" });
  });
});
