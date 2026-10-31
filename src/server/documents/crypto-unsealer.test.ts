import { randomBytes, randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

// Records every key handed to createDecipheriv (the key-encryption key for the
// unwrap, then the data key for the content), so the data key's zeroing can be
// seen from outside. Everything passes through.
const decipherKeys = vi.hoisted(() => ({ calls: [] as Uint8Array[] }));
vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:crypto")>();
  return {
    ...actual,
    createDecipheriv: ((...args: Parameters<typeof actual.createDecipheriv>) => {
      decipherKeys.calls.push(args[1] as Uint8Array);
      return actual.createDecipheriv(...args);
    }) as typeof actual.createDecipheriv,
  };
});

import {
  createDocumentSealer,
  createDocumentUnsealer,
  decryptDocument,
  DocumentIntegrityError,
  encryptDocument,
  type CryptoEnvelope,
  type DocumentEncryptionContext,
  type DocumentUnsealer,
} from "./crypto";

/**
 * #1571: `createDocumentUnsealer(context, envelope, keyEncryptionKey)` is the
 * mirror of #1567's `DocumentSealer` over the same AES-256-GCM construction
 * (ADR-0017): `update(chunk)` returns the plaintext of one piece, `final()`
 * is GCM's tag check and throws `DocumentIntegrityError` for anything that is
 * not exactly what was sealed. Nothing downstream may release plaintext
 * before `final()` has passed, so the error is the one signal they read.
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

function seal(plaintext: Buffer, context: DocumentEncryptionContext, kek: Buffer): { ciphertext: Buffer; envelope: CryptoEnvelope } {
  const sealer = createDocumentSealer(context, kek, "key-1");
  const body = sealer.update(plaintext);
  const { tail, envelope } = sealer.final();
  return { ciphertext: Buffer.concat([body, tail]), envelope };
}

/** Feeds `ciphertext` in pieces of `size` and returns the plaintext pieces, joined, once `final()` has passed. */
function unseal(
  ciphertext: Buffer,
  context: DocumentEncryptionContext,
  envelope: CryptoEnvelope,
  kek: Buffer,
  size: number,
): Buffer {
  const unsealer = createDocumentUnsealer(context, envelope, kek);
  const pieces: Buffer[] = [];
  for (let at = 0; at < ciphertext.length; at += size) {
    const piece = unsealer.update(ciphertext.subarray(at, at + size));
    expect(Buffer.isBuffer(piece)).toBe(true);
    pieces.push(piece);
  }
  unsealer.final();
  return Buffer.concat(pieces);
}

/** What a caller sees when it opens `ciphertext` under `context` and `envelope`: the error that stopped it, or undefined. */
function failureOf(ciphertext: Buffer, context: DocumentEncryptionContext, envelope: CryptoEnvelope, kek: Buffer): unknown {
  try {
    unseal(ciphertext, context, envelope, kek, 4_096);
    return undefined;
  } catch (error) {
    return error;
  }
}

/** The error `work` throws, or undefined; so a class that does not exist yet fails the test, as `toThrow(undefined)` would not. */
function thrownBy(work: () => unknown): unknown {
  try {
    work();
    return undefined;
  } catch (error) {
    return error;
  }
}

describe("DocumentIntegrityError (#1571)", () => {
  it("is an Error whose name and message say the document failed its integrity check", () => {
    const error = new DocumentIntegrityError();
    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(DocumentIntegrityError);
    expect(error.name).toBe("DocumentIntegrityError");
    expect(error.message).toBe("Document failed its integrity check");
  });
});

describe("createDocumentUnsealer (#1571)", () => {
  const kek = randomBytes(32);

  it.each([
    [1, 20_000],
    [7, 300_011],
    [4_096, 2 * MIB + 13],
    [MIB, 2 * MIB + 13],
  ])("fed pieces of %i bytes, reproduces the original %i bytes of plaintext", (size, length) => {
    const plaintext = randomBytes(length);
    const context = contextFor(plaintext);
    const { ciphertext, envelope } = seal(plaintext, context, kek);

    const opened = unseal(ciphertext, context, envelope, kek, size);

    expect(opened.length).toBe(plaintext.length);
    expect(opened.equals(plaintext)).toBe(true);
  }, 30_000);

  it("opens what encryptDocument sealed, and what a sealer sealed in pieces", () => {
    const plaintext = randomBytes(70_001);
    const context = contextFor(plaintext);
    const whole = encryptDocument(plaintext, context, kek, "key-1");
    expect(unseal(whole.ciphertext, context, whole.envelope, kek, 5_000).equals(plaintext)).toBe(true);

    const sealer = createDocumentSealer(context, kek, "key-1");
    const pieces: Buffer[] = [];
    for (let at = 0; at < plaintext.length; at += 999) pieces.push(sealer.update(plaintext.subarray(at, at + 999)));
    const { tail, envelope } = sealer.final();
    pieces.push(tail);
    expect(unseal(Buffer.concat(pieces), context, envelope, kek, 31).equals(plaintext)).toBe(true);
  });

  it("opens a scanner-recovery staging object under its own purpose", () => {
    const plaintext = randomBytes(2_000);
    const context = contextFor(plaintext, { purpose: "scanner_recovery" });
    const { ciphertext, envelope } = seal(plaintext, context, kek);

    expect(unseal(ciphertext, context, envelope, kek, 300).equals(plaintext)).toBe(true);
  });

  it("returns every piece's plaintext from update, so none is held back for final", () => {
    const plaintext = randomBytes(10_000);
    const context = contextFor(plaintext);
    const { ciphertext, envelope } = seal(plaintext, context, kek);
    const unsealer = createDocumentUnsealer(context, envelope, kek);

    const first = unsealer.update(ciphertext.subarray(0, 4_096));
    const second = unsealer.update(ciphertext.subarray(4_096));
    unsealer.final();

    expect(first.length + second.length).toBe(plaintext.length);
    expect(Buffer.concat([first, second]).equals(plaintext)).toBe(true);
  });

  describe("final() refuses, with DocumentIntegrityError, anything that is not exactly what was sealed", () => {
    it.each([0, 5_000, 9_999])("a flipped ciphertext byte at %i", (position) => {
      const plaintext = randomBytes(10_000);
      const context = contextFor(plaintext);
      const { ciphertext, envelope } = seal(plaintext, context, kek);
      const changed = Buffer.from(ciphertext);
      changed[position] ^= 0xff;

      expect(failureOf(changed, context, envelope, kek)).toBeInstanceOf(DocumentIntegrityError);
    });

    it.each(["householdId", "itemId", "mediaType"] as const)("a changed context field: %s", (field) => {
      const plaintext = randomBytes(3_000);
      const context = contextFor(plaintext);
      const { ciphertext, envelope } = seal(plaintext, context, kek);
      const other = { ...context, [field]: field === "mediaType" ? "image/png" : randomUUID() };

      expect(failureOf(ciphertext, other, envelope, kek)).toBeInstanceOf(DocumentIntegrityError);
    });

    it("a changed plaintextSize in the context, whichever way it moves", () => {
      const plaintext = randomBytes(3_000);
      const context = contextFor(plaintext);
      const { ciphertext, envelope } = seal(plaintext, context, kek);

      for (const size of [context.plaintextSize - 1, context.plaintextSize + 1]) {
        expect(failureOf(ciphertext, { ...context, plaintextSize: size }, envelope, kek), `plaintextSize ${size}`).toBeInstanceOf(DocumentIntegrityError);
      }
    });

    it("a changed document id or purpose (the data key is bound to both, so it may refuse earlier, at creation)", () => {
      const plaintext = randomBytes(3_000);
      const context = contextFor(plaintext);
      const { ciphertext, envelope } = seal(plaintext, context, kek);

      expect(failureOf(ciphertext, context, envelope, kek), "the right context opens it").toBeUndefined();
      expect(failureOf(ciphertext, { ...context, documentId: randomUUID() }, envelope, kek)).toBeInstanceOf(Error);
      expect(failureOf(ciphertext, { ...context, purpose: "scanner_recovery" }, envelope, kek)).toBeInstanceOf(Error);
    });

    it("a wrong authentication tag", () => {
      const plaintext = randomBytes(3_000);
      const context = contextFor(plaintext);
      const { ciphertext, envelope } = seal(plaintext, context, kek);
      const tag = Buffer.from(envelope.contentAuthTag, "base64url");
      tag[0] ^= 0x01;

      expect(failureOf(ciphertext, context, { ...envelope, contentAuthTag: tag.toString("base64url") }, kek)).toBeInstanceOf(DocumentIntegrityError);
      expect(failureOf(ciphertext, context, { ...envelope, contentAuthTag: randomBytes(16).toString("base64url") }, kek)).toBeInstanceOf(DocumentIntegrityError);
    });

    it("one byte too few", () => {
      const plaintext = randomBytes(3_000);
      const context = contextFor(plaintext);
      const { ciphertext, envelope } = seal(plaintext, context, kek);

      expect(failureOf(ciphertext.subarray(0, ciphertext.length - 1), context, envelope, kek)).toBeInstanceOf(DocumentIntegrityError);
    });

    it("one byte too many", () => {
      const plaintext = randomBytes(3_000);
      const context = contextFor(plaintext);
      const { ciphertext, envelope } = seal(plaintext, context, kek);

      expect(failureOf(Buffer.concat([ciphertext, Buffer.from([0])]), context, envelope, kek)).toBeInstanceOf(DocumentIntegrityError);
    });

    it("nothing fed at all, for a document that has bytes", () => {
      const plaintext = randomBytes(100);
      const context = contextFor(plaintext);
      const { envelope } = seal(plaintext, context, kek);
      const unsealer = createDocumentUnsealer(context, envelope, kek);

      expect(thrownBy(() => unsealer.final())).toBeInstanceOf(DocumentIntegrityError);
    });

    it("the right bytes under the wrong key-encryption key do not open at all", () => {
      const plaintext = randomBytes(100);
      const context = contextFor(plaintext);
      const { ciphertext, envelope } = seal(plaintext, context, kek);

      expect(failureOf(ciphertext, context, envelope, kek), "the right key opens it").toBeUndefined();
      expect(failureOf(ciphertext, context, envelope, randomBytes(32))).toBeInstanceOf(Error);
    });
  });

  it("refuses a key-encryption key that is not 32 bytes", () => {
    const plaintext = randomBytes(100);
    const context = contextFor(plaintext);
    const { envelope } = seal(plaintext, context, kek);

    expect(() => createDocumentUnsealer(context, envelope, randomBytes(16))).toThrow(/32 bytes/);
  });

  describe("a stored record that does not open under its key is an integrity failure, at construction (A-F1, X-F2)", () => {
    function sealed() {
      const plaintext = randomBytes(100);
      const context = contextFor(plaintext);
      const { envelope } = seal(plaintext, context, kek);
      return { context, envelope };
    }

    function flipped(value: string): string {
      const bytes = Buffer.from(value, "base64url");
      bytes[0] ^= 0x01;
      return bytes.toString("base64url");
    }

    const damages: Array<[string, (envelope: CryptoEnvelope) => CryptoEnvelope, Buffer?]> = [
      ["one byte flipped in wrappedDek", (envelope) => ({ ...envelope, wrappedDek: flipped(envelope.wrappedDek) })],
      ["a wrapIv of 11 bytes", (envelope) => ({ ...envelope, wrapIv: randomBytes(11).toString("base64url") })],
      ["one byte flipped in wrapAuthTag", (envelope) => ({ ...envelope, wrapAuthTag: flipped(envelope.wrapAuthTag) })],
      ["a contentIv of 13 bytes", (envelope) => ({ ...envelope, contentIv: randomBytes(13).toString("base64url") })],
      ["a contentAuthTag of 15 bytes", (envelope) => ({ ...envelope, contentAuthTag: randomBytes(15).toString("base64url") })],
      ["a different 32-byte key-encryption key", (envelope) => envelope, randomBytes(32)],
      ["envelopeVersion 2", (envelope) => ({ ...envelope, envelopeVersion: 2 })],
    ];

    it.each(damages)("%s throws DocumentIntegrityError before any update", (_name, damage, otherKek) => {
      const { context, envelope } = sealed();

      const error = thrownBy(() => createDocumentUnsealer(context, damage(envelope), otherKek ?? kek));

      expect(error).toBeInstanceOf(DocumentIntegrityError);
    });
  });

  it("a key-encryption key that is not 32 bytes stays a plain configuration error, not an integrity failure", () => {
    const plaintext = randomBytes(100);
    const context = contextFor(plaintext);
    const { envelope } = seal(plaintext, context, kek);

    const error = thrownBy(() => createDocumentUnsealer(context, envelope, randomBytes(16)));

    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(DocumentIntegrityError);
    expect((error as Error).message).toMatch(/32 bytes/);
  });

  describe("an unsealer that is finished stays finished", () => {
    function finishedUnsealer(): { unsealer: DocumentUnsealer; chunk: Buffer } {
      const plaintext = randomBytes(500);
      const context = contextFor(plaintext);
      const { ciphertext, envelope } = seal(plaintext, context, kek);
      const unsealer = createDocumentUnsealer(context, envelope, kek);
      unsealer.update(ciphertext);
      unsealer.final();
      return { unsealer, chunk: ciphertext };
    }

    it("refuses a second final()", () => {
      const { unsealer } = finishedUnsealer();
      expect(() => unsealer.final()).toThrow();
    });

    it("refuses update() after final()", () => {
      const { unsealer, chunk } = finishedUnsealer();
      expect(() => unsealer.update(chunk)).toThrow();
    });

    it("refuses a second final(), and update(), after a final() that failed", () => {
      const plaintext = randomBytes(500);
      const context = contextFor(plaintext);
      const { ciphertext, envelope } = seal(plaintext, context, kek);
      const changed = Buffer.from(ciphertext);
      changed[10] ^= 0x80;
      const unsealer = createDocumentUnsealer(context, envelope, kek);
      unsealer.update(changed);
      expect(thrownBy(() => unsealer.final())).toBeInstanceOf(DocumentIntegrityError);

      expect(() => unsealer.final()).toThrow();
      expect(() => unsealer.update(changed)).toThrow();
    });
  });

  it("zeroes the data key once the cipher has its own copy, and leaves the caller's key-encryption key alone", () => {
    const plaintext = randomBytes(MIB + 3);
    const context = contextFor(plaintext);
    const { ciphertext, envelope } = seal(plaintext, context, kek);
    decipherKeys.calls.length = 0;

    const unsealer = createDocumentUnsealer(context, envelope, kek);

    // The unwrap uses the key-encryption key, the content cipher the data key.
    expect(decipherKeys.calls.length).toBe(2);
    const [wrapKey, dataKey] = decipherKeys.calls as [Uint8Array, Uint8Array];
    expect(Buffer.from(wrapKey).equals(kek)).toBe(true);
    expect(dataKey.length).toBe(32);
    expect(dataKey.every((byte) => byte === 0), "the data key is zeroed before the unsealer is returned").toBe(true);

    // The cipher still works: it kept its own copy.
    const opened: Buffer[] = [];
    for (let at = 0; at < ciphertext.length; at += MIB) opened.push(unsealer.update(ciphertext.subarray(at, at + MIB)));
    unsealer.final();
    expect(Buffer.concat(opened).equals(plaintext)).toBe(true);
  });
});

describe("decryptDocument, now built on the unsealer (#1571)", () => {
  const kek = randomBytes(32);

  it("still returns the plaintext of a sealed document", () => {
    const plaintext = randomBytes(300_000);
    const context = contextFor(plaintext);
    const encrypted = encryptDocument(plaintext, context, kek, "key-1");

    const opened = decryptDocument(encrypted.ciphertext, context, encrypted.envelope, kek);

    expect(Buffer.isBuffer(opened)).toBe(true);
    expect(opened.equals(plaintext)).toBe(true);
  });

  it("refuses a flipped ciphertext byte, and a changed context field, as an integrity failure", () => {
    const plaintext = randomBytes(5_000);
    const context = contextFor(plaintext);
    const encrypted = encryptDocument(plaintext, context, kek, "key-1");
    const changed = Buffer.from(encrypted.ciphertext);
    changed[0] ^= 0xff;

    expect(thrownBy(() => decryptDocument(changed, context, encrypted.envelope, kek))).toBeInstanceOf(DocumentIntegrityError);
    expect(thrownBy(() => decryptDocument(encrypted.ciphertext, { ...context, itemId: randomUUID() }, encrypted.envelope, kek))).toBeInstanceOf(DocumentIntegrityError);
  });

  it("refuses a flipped wrappedDek byte as an integrity failure (A-F1)", () => {
    const plaintext = randomBytes(1_000);
    const context = contextFor(plaintext);
    const encrypted = encryptDocument(plaintext, context, kek, "key-1");
    const wrapped = Buffer.from(encrypted.envelope.wrappedDek, "base64url");
    wrapped[0] ^= 0x01;

    expect(thrownBy(() => decryptDocument(encrypted.ciphertext, context, { ...encrypted.envelope, wrappedDek: wrapped.toString("base64url") }, kek))).toBeInstanceOf(DocumentIntegrityError);
  });

  it("refuses a ciphertext of the wrong length, either way", () => {
    const plaintext = randomBytes(5_000);
    const context = contextFor(plaintext);
    const encrypted = encryptDocument(plaintext, context, kek, "key-1");

    expect(thrownBy(() => decryptDocument(encrypted.ciphertext.subarray(0, 4_999), context, encrypted.envelope, kek))).toBeInstanceOf(DocumentIntegrityError);
    expect(thrownBy(() => decryptDocument(Buffer.concat([encrypted.ciphertext, Buffer.from([1])]), context, encrypted.envelope, kek))).toBeInstanceOf(DocumentIntegrityError);
  });

  it("still refuses a recovery stage opened as a document, and a wrong key", () => {
    const plaintext = randomBytes(1_000);
    const context = contextFor(plaintext, { purpose: "scanner_recovery" });
    const staged = encryptDocument(plaintext, context, kek, "key-1");

    expect(() => decryptDocument(staged.ciphertext, { ...context, purpose: "document" }, staged.envelope, kek)).toThrow();
    expect(() => decryptDocument(staged.ciphertext, context, staged.envelope, randomBytes(32))).toThrow();
  });
});
