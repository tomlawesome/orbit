import { inspect } from "node:util";
import { describe, expect, it } from "vitest";

import {
  RecoveryBundleRefusal,
  buildBackupManifest,
  buildRecoveryManifest,
  computeBundleHmac,
  decryptDocumentArchive,
  decryptDocumentKek,
  documentKekFingerprint,
  encryptDocumentArchive,
  encryptDocumentKek,
  passphrasesMatch,
  requireMatchingPassphrase,
  verifyBundleHmac,
} from "./recovery-bundle";

// Determinism and secret-hygiene characterization for issue #296 slice 1.
// Every deterministic primitive here backs a Bash `cmp --silent` /
// byte-equality guarantee (docs/installer-guarantees.md Part 2); the one
// intentionally *non*-deterministic primitive (the ORBKEK envelope) is
// contrasted explicitly so a future regression toward determinism there
// (e.g. a reused salt/IV) is caught. The secrets-hygiene sweep asserts the
// SECURITY directive for this slice: no refusal path this module can throw
// ever surfaces a passphrase, a raw document KEK, or a bundle HMAC/fingerprint
// derived from one, in its message.

const KEK = "c".repeat(64);
const PASSPHRASE = "correct-horse-battery-staple-determinism";

describe("determinism", () => {
  it("buildBackupManifest is pure: identical fields produce byte-identical output across repeated calls", () => {
    const fields = {
      createdAt: "2026-08-13T00:00:00Z",
      databaseDump: "database.dump",
      documentsArchive: "documents.tar.enc",
      documentsEncryption: "aes-256-cbc-pbkdf2-sha256-iter-600000",
      documentKekSha256: documentKekFingerprint(KEK),
    };
    const outputs = Array.from({ length: 5 }, () => buildBackupManifest(fields));
    expect(new Set(outputs).size).toBe(1);
  });

  it("buildRecoveryManifest is pure: no inputs, always the same output", () => {
    const outputs = Array.from({ length: 5 }, () => buildRecoveryManifest());
    expect(new Set(outputs).size).toBe(1);
  });

  it("computeBundleHmac is deterministic for a fixed key and content", () => {
    const content = Buffer.from("deterministic-content-fixture");
    const outputs = Array.from({ length: 5 }, () => computeBundleHmac(KEK, content));
    expect(new Set(outputs).size).toBe(1);
  });

  it("documentKekFingerprint is deterministic for a fixed key", () => {
    const outputs = Array.from({ length: 5 }, () => documentKekFingerprint(KEK));
    expect(new Set(outputs).size).toBe(1);
  });

  it(
    "contrast: the ORBKEK envelope is deliberately non-deterministic (fresh salt/IV every call, recovery-crypto.mjs #3)",
    () => {
      // scrypt(N=131072) is deliberately expensive; this test performs 5
      // encrypt + 5 decrypt calls, well past vitest's default 5s timeout.
      const outputs = Array.from({ length: 5 }, () => encryptDocumentKek(KEK, PASSPHRASE).toString("hex"));
      expect(new Set(outputs).size).toBe(5);
      // ...but every one of them decrypts back to the identical key.
      for (const hex of outputs) {
        const recovered = decryptDocumentKek(Buffer.from(hex, "hex"), PASSPHRASE);
        expect(recovered.toString("ascii")).toBe(KEK);
      }
    },
    20_000,
  );

  it("contrast: the document-archive envelope is also deliberately non-deterministic (fresh salt every call, backup.sh #27)", () => {
    const plaintext = Buffer.from("fake document tar bytes for determinism fixture");
    const outputs = Array.from({ length: 5 }, () => encryptDocumentArchive(plaintext, KEK).toString("hex"));
    expect(new Set(outputs).size).toBe(5);
    // ...but every one of them decrypts back to the identical plaintext.
    for (const hex of outputs) {
      expect(decryptDocumentArchive(Buffer.from(hex, "hex"), KEK)).toEqual(plaintext);
    }
  });
});

describe("secrets are never printed (SECURITY: no plaintext secret in any thrown message)", () => {
  function assertNoSecretLeak(error: unknown, secrets: readonly string[]): void {
    expect(error).toBeInstanceOf(RecoveryBundleRefusal);
    const rendered = `${(error as Error).message}\n${inspect(error)}\n${String(error)}`;
    for (const secret of secrets) {
      expect(rendered).not.toContain(secret);
    }
  }

  it("wrong passphrase never appears in the refusal", () => {
    const envelope = encryptDocumentKek(KEK, PASSPHRASE);
    const wrongPassphrase = "an-entirely-different-passphrase-value";
    let error: unknown;
    try {
      decryptDocumentKek(envelope, wrongPassphrase);
    } catch (caught) {
      error = caught;
    }
    assertNoSecretLeak(error, [PASSPHRASE, wrongPassphrase, KEK]);
  });

  it("the document KEK never appears in a passphrase-too-short refusal", () => {
    let error: unknown;
    try {
      encryptDocumentKek(KEK, "short");
    } catch (caught) {
      error = caught;
    }
    assertNoSecretLeak(error, [KEK]);
  });

  it("a bad-magic envelope's bytes never appear in the invalid-envelope refusal", () => {
    const garbage = Buffer.from("definitely-not-an-orbkek-envelope-payload");
    let error: unknown;
    try {
      decryptDocumentKek(garbage, PASSPHRASE);
    } catch (caught) {
      error = caught;
    }
    assertNoSecretLeak(error, [PASSPHRASE, garbage.toString("utf8")]);
  });

  it("a mismatched HMAC never appears in the hmac-mismatch refusal, and the key never appears either", () => {
    const content = Buffer.from("some-manifest-and-checksums-bytes");
    const hmac = computeBundleHmac(KEK, content);
    let error: unknown;
    try {
      verifyBundleHmac(KEK, Buffer.from("tampered-content"), hmac);
    } catch (caught) {
      error = caught;
    }
    assertNoSecretLeak(error, [KEK, hmac]);
  });

  it("passphrase confirmation mismatch never echoes either candidate passphrase", () => {
    const a = "first-candidate-passphrase-value";
    const b = "second-candidate-passphrase-value";
    expect(passphrasesMatch(a, b)).toBe(false);
    let error: unknown;
    try {
      requireMatchingPassphrase(a, b);
    } catch (caught) {
      error = caught;
    }
    assertNoSecretLeak(error, [a, b]);
  });

  it("a document-KEK decryption failure never leaks the key or the plaintext document bytes (backup.sh #19)", () => {
    const plaintext = Buffer.from("sensitive document tar bytes that must never leak");
    const envelope = encryptDocumentArchive(plaintext, KEK);
    const wrongKey = "d".repeat(64);
    let error: unknown;
    try {
      decryptDocumentArchive(envelope, wrongKey);
    } catch (caught) {
      error = caught;
    }
    assertNoSecretLeak(error, [KEK, wrongKey, plaintext.toString("utf8")]);
  });
});
