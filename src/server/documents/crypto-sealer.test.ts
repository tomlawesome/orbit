import { randomBytes, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  createDocumentSealer,
  decryptDocument,
  encryptDocument,
  rewrapDocumentKey,
  type CryptoEnvelope,
  type DocumentEncryptionContext,
} from "./crypto";

/**
 * #1567: `createDocumentSealer(context, keyEncryptionKey, keyId)` is the same
 * AES-256-GCM construction as `encryptDocument` (ADR-0017), fed in pieces:
 * `update(chunk)` returns ciphertext for that chunk, `final()` returns the
 * last bytes and the envelope, tag included. GCM is a counter mode, so the
 * stored bytes are the same however the input is cut, and nothing that reads a
 * stored document changes.
 */

const MIB = 1_048_576;

function contextFor(plaintext: Buffer, extra: Partial<DocumentEncryptionContext> = {}): DocumentEncryptionContext {
  return {
    documentId: randomUUID(),
    householdId: randomUUID(),
    itemId: randomUUID(),
    mediaType: "application/pdf",
    plaintextSize: plaintext.length,
    ...extra,
  };
}

/** Feeds `plaintext` in pieces of `size`, then one empty chunk, and returns what a reader would store. */
function seal(plaintext: Buffer, context: DocumentEncryptionContext, kek: Buffer, size: number): { ciphertext: Buffer; envelope: CryptoEnvelope } {
  const sealer = createDocumentSealer(context, kek, "key-1");
  const pieces: Buffer[] = [];
  for (let at = 0; at < plaintext.length; at += size) {
    const piece = sealer.update(plaintext.subarray(at, at + size));
    expect(Buffer.isBuffer(piece)).toBe(true);
    pieces.push(piece);
  }
  pieces.push(sealer.update(Buffer.alloc(0)));
  const { tail, envelope } = sealer.final();
  pieces.push(tail);
  return { ciphertext: Buffer.concat(pieces), envelope };
}

describe("createDocumentSealer (#1567)", () => {
  const kek = randomBytes(32);

  it.each([
    [1, 20_000],
    [7, 300_011],
    [4_096, 2 * MIB + 13],
    [MIB, 2 * MIB + 13],
  ])("produces, from chunks of %i bytes and one empty last chunk, ciphertext that decryptDocument opens to the original %i bytes", (size, length) => {
    const plaintext = randomBytes(length);
    const context = contextFor(plaintext);

    const { ciphertext, envelope } = seal(plaintext, context, kek, size);

    expect(ciphertext.length).toBe(plaintext.length);
    expect(ciphertext.equals(plaintext)).toBe(false);
    const opened = decryptDocument(ciphertext, context, envelope, kek);
    expect(opened.length).toBe(context.plaintextSize);
    expect(opened.equals(plaintext)).toBe(true);
  }, 30_000);

  it("gives the same bytes however the input is cut: every chunking decrypts to the same plaintext", () => {
    const plaintext = randomBytes(100_003);
    const context = contextFor(plaintext);
    for (const size of [1_000, 4_096, 65_536, 100_003]) {
      const { ciphertext, envelope } = seal(plaintext, context, kek, size);
      expect(decryptDocument(ciphertext, context, envelope, kek).equals(plaintext), `chunks of ${size}`).toBe(true);
    }
  });

  it("agrees with encryptDocument on everything a reader can see: the eight envelope columns, and the ciphertext length", () => {
    const plaintext = randomBytes(70_001);
    const context = contextFor(plaintext);

    const one = encryptDocument(plaintext, context, kek, "key-1");
    const streamed = seal(plaintext, context, kek, 4_096);

    expect(Object.keys(streamed.envelope).sort()).toEqual(Object.keys(one.envelope).sort());
    expect(Object.keys(streamed.envelope).sort()).toEqual([
      "algorithm", "contentAuthTag", "contentIv", "envelopeVersion", "keyId", "wrapAuthTag", "wrapIv", "wrappedDek",
    ]);
    expect(streamed.envelope.algorithm).toBe(one.envelope.algorithm);
    expect(streamed.envelope.envelopeVersion).toBe(one.envelope.envelopeVersion);
    expect(streamed.envelope.keyId).toBe("key-1");
    for (const column of ["contentIv", "contentAuthTag", "wrappedDek", "wrapIv", "wrapAuthTag"] as const) {
      expect(typeof streamed.envelope[column], column).toBe("string");
      expect(streamed.envelope[column].length, column).toBe(one.envelope[column].length);
    }
    expect(streamed.ciphertext.length).toBe(one.ciphertext.length);
    // A fresh data key and IV each time.
    expect(streamed.envelope.contentIv).not.toBe(one.envelope.contentIv);
    expect(streamed.envelope.wrappedDek).not.toBe(one.envelope.wrappedDek);
  });

  it("makes a key-rewrap of the sealer's envelope work, leaving the ciphertext alone", () => {
    const plaintext = randomBytes(5_000);
    const context = contextFor(plaintext);
    const nextKek = randomBytes(32);
    const { ciphertext, envelope } = seal(plaintext, context, kek, 512);

    const rewrapped = rewrapDocumentKey(context.documentId, envelope, kek, nextKek, "key-2");

    expect(decryptDocument(ciphertext, context, rewrapped, nextKek).equals(plaintext)).toBe(true);
    expect(() => decryptDocument(ciphertext, context, rewrapped, kek)).toThrow();
  });

  it("refuses a changed byte of the streamed ciphertext, in the body and in the tail", () => {
    const plaintext = randomBytes(10_000);
    const context = contextFor(plaintext);
    const { ciphertext, envelope } = seal(plaintext, context, kek, 777);

    for (const position of [0, 5_000, ciphertext.length - 1]) {
      const changed = Buffer.from(ciphertext);
      changed[position] ^= 0xff;
      expect(() => decryptDocument(changed, context, envelope, kek), `byte ${position}`).toThrow();
    }
    expect(() => decryptDocument(ciphertext.subarray(0, ciphertext.length - 1), context, envelope, kek)).toThrow();
  });

  it.each([
    ["documentId", { documentId: randomUUID() }],
    ["householdId", { householdId: randomUUID() }],
    ["itemId", { itemId: randomUUID() }],
    ["mediaType", { mediaType: "image/png" }],
    ["purpose", { purpose: "scanner_recovery" as const }],
  ])("refuses to decrypt the sealer's output under a changed %s", (_field, change) => {
    const plaintext = randomBytes(2_000);
    const context = contextFor(plaintext);
    const { ciphertext, envelope } = seal(plaintext, context, kek, 300);

    expect(() => decryptDocument(ciphertext, { ...context, ...change }, envelope, kek)).toThrow();
  });

  it("binds scanner-recovery staging output to its own purpose", () => {
    const plaintext = randomBytes(2_000);
    const context = contextFor(plaintext, { purpose: "scanner_recovery" });
    const { ciphertext, envelope } = seal(plaintext, context, kek, 300);

    expect(decryptDocument(ciphertext, context, envelope, kek).equals(plaintext)).toBe(true);
    expect(() => decryptDocument(ciphertext, { ...context, purpose: "document" }, envelope, kek)).toThrow();
  });

  it("refuses to open the output under another key-encryption key", () => {
    const plaintext = randomBytes(2_000);
    const context = contextFor(plaintext);
    const { ciphertext, envelope } = seal(plaintext, context, kek, 300);

    expect(() => decryptDocument(ciphertext, context, envelope, randomBytes(32))).toThrow();
  });

  it("still refuses a key-encryption key that is not 32 bytes, and encryptDocument still refuses a plaintext of the wrong size", () => {
    const plaintext = randomBytes(100);
    expect(() => createDocumentSealer(contextFor(plaintext), randomBytes(16), "key-1")).toThrow(/32 bytes/);
    expect(() => encryptDocument(plaintext, contextFor(plaintext, { plaintextSize: 99 }), kek, "key-1")).toThrow(/size/i);
    expect(() => encryptDocument(plaintext, contextFor(plaintext), randomBytes(16), "key-1")).toThrow(/32 bytes/);
  });

  it("makes a fresh data key and IV for every sealer, even for the same plaintext and context", () => {
    const plaintext = randomBytes(1_000);
    const context = contextFor(plaintext);
    const first = seal(plaintext, context, kek, 100);
    const second = seal(plaintext, context, kek, 100);

    expect(first.envelope.contentIv).not.toBe(second.envelope.contentIv);
    expect(first.envelope.wrappedDek).not.toBe(second.envelope.wrappedDek);
    expect(first.ciphertext.equals(second.ciphertext)).toBe(false);
  });
});
