import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  decryptDocument,
  encryptDocument,
  rewrapDocumentKey,
  type DocumentEncryptionContext,
} from "./crypto";

const plaintext = Buffer.from("a private household file");
const context: DocumentEncryptionContext = {
  documentId: "8d886a1f-ddfd-47be-aecc-bf88c16ed164",
  householdId: "50387ac3-1924-4a85-a97a-ad13411ef41f",
  itemId: "f0c427dd-7280-492d-94ac-62ace29d4a6c",
  mediaType: "application/pdf",
  plaintextSize: plaintext.length,
};

describe("document envelope encryption", () => {
  it("round trips authenticated content", () => {
    const kek = randomBytes(32);
    const encrypted = encryptDocument(plaintext, context, kek, "key-1");
    expect(encrypted.ciphertext).not.toEqual(plaintext);
    expect(decryptDocument(encrypted.ciphertext, context, encrypted.envelope, kek)).toEqual(plaintext);
  });

  it("rejects tampered ciphertext and metadata", () => {
    const kek = randomBytes(32);
    const encrypted = encryptDocument(plaintext, context, kek, "key-1");
    encrypted.ciphertext[0] ^= 0xff;
    expect(() => decryptDocument(encrypted.ciphertext, context, encrypted.envelope, kek)).toThrow();

    const fresh = encryptDocument(plaintext, context, kek, "key-1");
    expect(() => decryptDocument(fresh.ciphertext, { ...context, itemId: crypto.randomUUID() }, fresh.envelope, kek)).toThrow();
  });

  it("binds recovery staging ciphertext to its separate purpose", () => {
    const kek = randomBytes(32);
    const staged = encryptDocument(plaintext, { ...context, purpose: "scanner_recovery" }, kek, "key-1");
    expect(decryptDocument(staged.ciphertext, { ...context, purpose: "scanner_recovery" }, staged.envelope, kek)).toEqual(plaintext);
    expect(() => decryptDocument(staged.ciphertext, context, staged.envelope, kek)).toThrow();
  });

  it("rewraps the DEK without changing ciphertext", () => {
    const currentKek = randomBytes(32);
    const nextKek = randomBytes(32);
    const encrypted = encryptDocument(plaintext, context, currentKek, "key-1");
    const rewrapped = rewrapDocumentKey(context.documentId, encrypted.envelope, currentKek, nextKek, "key-2");
    expect(rewrapped.keyId).toBe("key-2");
    expect(decryptDocument(encrypted.ciphertext, context, rewrapped, nextKek)).toEqual(plaintext);
    expect(() => decryptDocument(encrypted.ciphertext, context, rewrapped, currentKek)).toThrow();
  });
});
