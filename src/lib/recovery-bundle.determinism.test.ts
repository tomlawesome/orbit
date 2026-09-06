import { inspect } from "node:util";
import { describe, expect, it, vi } from "vitest";

import { KDF_TEST_TIMEOUT_MS } from "../../scripts/process-budget.mjs";
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

// scrypt N=131072 by design; see KDF_TEST_TIMEOUT_MS
// (scripts/process-budget.mjs) for the cost and the figure it's set from.
vi.setConfig({ testTimeout: KDF_TEST_TIMEOUT_MS });

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

  describe("a document-KEK decryption failure never leaks the key or the plaintext document bytes (backup.sh #19, #772)", () => {
    // decryptDocumentArchive is unauthenticated AES-256-CBC by design
    // (recovery-bundle.ts:569-584, byte-compatible with `openssl enc
    // -pbkdf2` as backup.sh writes it): a wrong key is only *noticed* when
    // PKCS#7 unpadding fails on the final block, so about 1 wrong key in
    // 256 decrypts to garbage that happens to unpad and is returned rather
    // than refused. Asserting "always throws" against a freshly random salt
    // therefore flaked roughly 1 CI run in 278 (#772, which absorbed #727 —
    // same defect, same root cause #723 already fixed in the sibling
    // recovery-bundle.test.ts). The contract this module actually keeps: a
    // wrong key never yields the original plaintext, and neither branch —
    // refusal or returned garbage — leaks the KEK, the wrong key, or the
    // plaintext.
    //
    // The two envelopes below pin one salt from each side of that coin
    // flip, so both branches run on every test execution instead of being
    // sampled at random. To regenerate: for salt = the 8-byte big-endian
    // counter in the header bytes, PBKDF2-HMAC-SHA256(kek, salt, 600000,
    // 48)-derive key||iv, AES-256-CBC-encrypt PLAINTEXT under KEK, then try
    // to decrypt the resulting ciphertext under WRONG_KEY and keep the
    // first salt that throws and the first that doesn't. Walking salts
    // 0-999: salt 0 refuses, salt 24 silently "succeeds" (1 of 1,000,
    // consistent with the ~1/278 measured rate).
    const PLAINTEXT = Buffer.from("sensitive document tar bytes that must never leak");
    const WRONG_KEY = "d".repeat(64);
    // salt 0x0000000000000000 — decrypting under WRONG_KEY fails to unpad (the common case).
    const REFUSED_ENVELOPE = Buffer.from(
      "53616c7465645f5f0000000000000000bf621ba45921f0b75b765b2d3adfccab58fd4423f301a537888b66341f296456575bd73018ac7f1e1ad07d52456f55d800b35bbd5cd43d59931956d41a7a510d",
      "hex",
    );
    // salt 0x0000000000000018 (24) — decrypting under WRONG_KEY unpads by luck (the rare case).
    const ACCEPTED_ENVELOPE = Buffer.from(
      "53616c7465645f5f0000000000000018ac3a2b0611e86c4436c1b92edf9b4c66d3263ac63bc4362530c6815b7bbaf3c538871b617a26f76bca4a08f9c1a1b993d8c58b0d9d014b39b8551f563d6eb98c",
      "hex",
    );

    it("both fixtures are genuine envelopes: each decrypts to the same plaintext under the right KEK", () => {
      expect(decryptDocumentArchive(REFUSED_ENVELOPE, KEK)).toEqual(PLAINTEXT);
      expect(decryptDocumentArchive(ACCEPTED_ENVELOPE, KEK)).toEqual(PLAINTEXT);
    });

    it("the refusing branch: throws RecoveryBundleRefusal and leaks neither key nor plaintext", () => {
      let error: unknown;
      try {
        decryptDocumentArchive(REFUSED_ENVELOPE, WRONG_KEY);
      } catch (caught) {
        error = caught;
      }
      assertNoSecretLeak(error, [KEK, WRONG_KEY, PLAINTEXT.toString("utf8")]);
    });

    it("the silent-garbage branch (#659): never returns the original plaintext, and the garbage leaks neither key nor plaintext", () => {
      const decrypted = decryptDocumentArchive(ACCEPTED_ENVELOPE, WRONG_KEY);
      expect(decrypted.equals(PLAINTEXT)).toBe(false);
      const rendered = decrypted.toString("utf8");
      for (const secret of [KEK, WRONG_KEY, PLAINTEXT.toString("utf8")]) {
        expect(rendered).not.toContain(secret);
      }
    });
  });
});
