import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { decryptMailInSecret, encryptMailInSecret, type MailInSecretContext } from "./secret-crypto";

const plaintext = Buffer.from("super-secret-imap-password");
const context: MailInSecretContext = {
  secretId: "8d886a1f-ddfd-47be-aecc-bf88c16ed164",
  kind: "imap_password",
  host: "imap.example.test",
  user: "orbit@example.test",
};

describe("mail-in secret envelope encryption (ADR-0017 decision 1)", () => {
  it("round trips authenticated content (acceptance 1)", () => {
    const kek = randomBytes(32);
    const encrypted = encryptMailInSecret(plaintext, context, kek, "key-1");
    expect(encrypted.ciphertext).not.toEqual(plaintext);
    expect(decryptMailInSecret(encrypted.ciphertext, context, encrypted.envelope, kek)).toEqual(plaintext);
  });

  it("fails authentication when a row is re-pointed at a different kind, host, or user (acceptance 2)", () => {
    const kek = randomBytes(32);
    const encrypted = encryptMailInSecret(plaintext, context, kek, "key-1");
    expect(() => decryptMailInSecret(encrypted.ciphertext, { ...context, kind: "alias_key" }, encrypted.envelope, kek)).toThrow();
    expect(() => decryptMailInSecret(encrypted.ciphertext, { ...context, host: "other-imap.example.test" }, encrypted.envelope, kek)).toThrow();
    expect(() => decryptMailInSecret(encrypted.ciphertext, { ...context, user: "someone-else@example.test" }, encrypted.envelope, kek)).toThrow();
    expect(() => decryptMailInSecret(encrypted.ciphertext, { ...context, secretId: crypto.randomUUID() }, encrypted.envelope, kek)).toThrow();
  });

  it("fails closed when the wrapping KEK does not match (acceptance 3)", () => {
    const kek = randomBytes(32);
    const wrongKek = randomBytes(32);
    const encrypted = encryptMailInSecret(plaintext, context, kek, "key-1");
    expect(() => decryptMailInSecret(encrypted.ciphertext, context, encrypted.envelope, wrongKek)).toThrow();
  });

  it("rejects a tampered ciphertext or authentication tag (acceptance 4)", () => {
    const kek = randomBytes(32);
    const encrypted = encryptMailInSecret(plaintext, context, kek, "key-1");
    const tamperedCiphertext = Buffer.from(encrypted.ciphertext);
    tamperedCiphertext[0] ^= 0xff;
    expect(() => decryptMailInSecret(tamperedCiphertext, context, encrypted.envelope, kek)).toThrow();

    const tamperedTagEnvelope = {
      ...encrypted.envelope,
      contentAuthTag: encrypted.envelope.contentAuthTag === "A".repeat(encrypted.envelope.contentAuthTag.length)
        ? "B".repeat(encrypted.envelope.contentAuthTag.length)
        : "A".repeat(encrypted.envelope.contentAuthTag.length),
    };
    expect(() => decryptMailInSecret(encrypted.ciphertext, context, tamperedTagEnvelope, kek)).toThrow();
  });

  it("rejects an unsupported envelope version or algorithm", () => {
    const kek = randomBytes(32);
    const encrypted = encryptMailInSecret(plaintext, context, kek, "key-1");
    expect(() => decryptMailInSecret(encrypted.ciphertext, context, { ...encrypted.envelope, envelopeVersion: 2 as 1 }, kek)).toThrow();
  });
});
