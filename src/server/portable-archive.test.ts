import { createCipheriv, randomBytes, scryptSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { decryptPortableArchive, encryptPortableArchive, type EncryptedPortableArchive } from "./portable-archive";

describe("portable archive encryption", () => {
  it("round-trips an archive only with its passphrase", () => {
    const encrypted = encryptPortableArchive(Buffer.from('{"format":"orbit"}'), "correct-horse-battery-staple");
    expect(decryptPortableArchive(encrypted, "correct-horse-battery-staple").toString()).toBe('{"format":"orbit"}');
    expect(() => decryptPortableArchive(encrypted, "wrong-passphrase-123")).toThrow();
  });
});

/** The format as it was written, built by hand, so a passphrase the floor would refuse today can still seal one. */
function sealWithAnyPassphrase(plaintext: Buffer, passphrase: string): EncryptedPortableArchive {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = scryptSync(passphrase, salt, 32, { N: 16_384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from("orbit-portable-archive:1"));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return {
    version: 1, algorithm: "aes-256-gcm", kdf: "scrypt",
    salt: salt.toString("base64url"), iv: iv.toString("base64url"),
    authTag: cipher.getAuthTag().toString("base64url"), ciphertext: ciphertext.toString("base64url"),
  };
}

describe("the passphrase floor is enforced when an archive is made, not when it is opened (#1333)", () => {
  const body = Buffer.from('{"format":"orbit"}');

  it("counts characters the way a person does: NFC, one code point each", () => {
    // Twelve UTF-16 units, six characters.
    expect(() => encryptPortableArchive(body, "\u{1F44D}".repeat(6))).toThrow(/at least 12 characters/u);
    expect(() => encryptPortableArchive(body, "e\u0301".repeat(6))).toThrow(/at least 12 characters/u);
    expect(() => encryptPortableArchive(body, "\u{1F44D}".repeat(11))).toThrow(/at least 12 characters/u);
    expect(() => encryptPortableArchive(body, "\u{1F44D}".repeat(12))).not.toThrow();
    expect(() => encryptPortableArchive(body, "e\u0301".repeat(12))).not.toThrow();
  });

  it("opens an archive sealed under a passphrase below today's floor", () => {
    const sealed = sealWithAnyPassphrase(body, "short");
    expect(decryptPortableArchive(sealed, "short").toString()).toBe('{"format":"orbit"}');
  });

  it("a wrong short passphrase fails as a wrong passphrase, not as a length complaint", () => {
    const sealed = sealWithAnyPassphrase(body, "short");
    expect(() => decryptPortableArchive(sealed, "wrong")).toThrow();
    expect(() => decryptPortableArchive(sealed, "wrong")).not.toThrow(/at least 12 characters/u);
  });
});
