import { spawnSync } from "node:child_process";
import { createHmac } from "node:crypto";
import * as fs from "node:fs";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  BACKUP_BUNDLE_FORMAT_VERSION,
  BACKUP_BUNDLE_MEMBERS,
  DOCUMENT_ARCHIVE_ENCRYPTION_ALGORITHM,
  MIN_RECOVERY_PASSPHRASE_LENGTH,
  RECOVERY_BUNDLE_FORMAT_VERSION,
  RECOVERY_BUNDLE_MEMBERS,
  RECOVERY_KEY_ENCRYPTION_ALGORITHM,
  RecoveryBundleRefusal,
  SECURE_DIRECTORY_MODE,
  SECURE_FILE_MODE,
  buildBackupManifest,
  buildRecoveryManifest,
  computeBundleHmac,
  createTar,
  decryptDocumentArchive,
  decryptDocumentKek,
  documentKekFingerprint,
  encryptDocumentArchive,
  encryptDocumentArchiveToFile,
  encryptDocumentKek,
  extractTar,
  isValidBundleHmac,
  isValidDocumentKekFingerprint,
  isValidDocumentKekHex,
  isValidPassphrase,
  listTarEntriesVerbose,
  listTarMembers,
  manifestDeclares,
  passphrasesMatch,
  readManifestField,
  requireMatchingPassphrase,
  requireValidPassphrase,
  sha256Buffer,
  sha256File,
  validateBackupBundleLayout,
  validateBackupManifestAndAuth,
  validateDocumentArchiveEntries,
  validateRecoveryBundleLayout,
  validateRecoveryManifestFormatVersion,
  verifyBundleHmac,
  verifyChecksumsFile,
  verifyRecoveryBundleChecksums,
  writeSecretFile,
} from "./recovery-bundle";

// Ported from scripts/recovery-crypto.mjs, scripts/backup.sh's validate_bundle
// / validate_document_archive, and scripts/export-recovery-bundle.sh /
// scripts/import-recovery-bundle.sh (issue #296 slice 1). Guarantee numbers
// cited below are from docs/installer-guarantees.md, Part 2. See
// docs/adr-notes/296-backup-port-plan.md for the slice this belongs to and
// byte-for-byte parity coverage against the real scripts
// (recovery-bundle.parity.test.ts).

let workDir: string;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "orbit-recovery-bundle-"));
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

const KEK_A = "a".repeat(64);
const KEK_B = "b".repeat(64);

function mode(path: string): number {
  return lstatSync(path).mode & 0o777;
}

describe("permission constants", () => {
  it("matches backup.sh #21 / export-recovery-bundle.sh #9 (private work directories)", () => {
    expect(SECURE_DIRECTORY_MODE).toBe(0o700);
  });

  it("matches import-recovery-bundle.sh #11/#16 (secret-bearing members)", () => {
    expect(SECURE_FILE_MODE).toBe(0o600);
  });
});

describe("writeSecretFile", () => {
  it("forces the final mode before any content is written, never briefly world-readable", () => {
    const path = join(workDir, "document-kek");
    writeSecretFile(path, `${KEK_A}\n`, 0o600);
    expect(mode(path)).toBe(0o600);
    expect(readFileSync(path, "utf8")).toBe(`${KEK_A}\n`);
  });
});

describe("passphrase validation (recovery-crypto.mjs #1, export-recovery-bundle.sh #6-7)", () => {
  it("MIN_RECOVERY_PASSPHRASE_LENGTH is 12", () => {
    expect(MIN_RECOVERY_PASSPHRASE_LENGTH).toBe(12);
  });

  it("accepts a 12-character passphrase and refuses an 11-character one", () => {
    expect(isValidPassphrase("x".repeat(12))).toBe(true);
    expect(isValidPassphrase("x".repeat(11))).toBe(false);
    expect(() => requireValidPassphrase("x".repeat(11))).toThrow(RecoveryBundleRefusal);
  });

  it("requires the confirmation to match exactly (typo protection, #7)", () => {
    expect(passphrasesMatch("correct-horse-battery", "correct-horse-battery")).toBe(true);
    expect(passphrasesMatch("correct-horse-battery", "correct-horse-batteryy")).toBe(false);
    expect(() => requireMatchingPassphrase("a".repeat(12), "b".repeat(12))).toThrow(RecoveryBundleRefusal);
  });
});

describe("ORBKEK envelope crypto (recovery-crypto.mjs #2-9)", () => {
  it("round-trips a valid document KEK through encrypt/decrypt", () => {
    const envelope = encryptDocumentKek(KEK_A, "correct-horse-battery-staple");
    const recovered = decryptDocumentKek(envelope, "correct-horse-battery-staple");
    expect(recovered.toString("ascii")).toBe(KEK_A);
  });

  it("produces a different envelope every time (fresh salt/IV never reused, #3)", () => {
    const first = encryptDocumentKek(KEK_A, "correct-horse-battery-staple");
    const second = encryptDocumentKek(KEK_A, "correct-horse-battery-staple");
    expect(first.equals(second)).toBe(false);
  });

  it("refuses to encrypt a non-hex key (#2)", () => {
    expect(() => encryptDocumentKek("not-hex", "correct-horse-battery-staple")).toThrow(RecoveryBundleRefusal);
  });

  it("refuses to encrypt under a too-short passphrase, independent of any caller check (#1)", () => {
    let error: unknown;
    try {
      encryptDocumentKek(KEK_A, "short");
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(RecoveryBundleRefusal);
    expect((error as RecoveryBundleRefusal).code).toBe("passphrase-too-short");
  });

  it("refuses a too-short or bad-magic envelope before any cryptographic operation (#6)", () => {
    expect(() => decryptDocumentKek(Buffer.from("short"), "correct-horse-battery-staple")).toThrow(RecoveryBundleRefusal);
    const badMagic = Buffer.concat([Buffer.from("NOTMAGIC"), Buffer.alloc(64)]);
    let error: unknown;
    try {
      decryptDocumentKek(badMagic, "correct-horse-battery-staple");
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(RecoveryBundleRefusal);
    expect((error as RecoveryBundleRefusal).code).toBe("invalid-envelope");
  });

  it("reports a wrong passphrase generically, not a detailed crypto error (#7)", () => {
    const envelope = encryptDocumentKek(KEK_A, "correct-horse-battery-staple");
    let error: unknown;
    try {
      decryptDocumentKek(envelope, "wrong-passphrase-wrong-passphrase");
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(RecoveryBundleRefusal);
    expect((error as RecoveryBundleRefusal).code).toBe("wrong-passphrase");
    expect((error as Error).message).not.toMatch(/passphrase-wrong-passphrase/);
  });

  it("reports tampered ciphertext the same as a wrong passphrase (GCM auth-tag failure, #7)", () => {
    const envelope = encryptDocumentKek(KEK_A, "correct-horse-battery-staple");
    const tampered = Buffer.from(envelope);
    tampered[tampered.length - 1] ^= 0xff;
    let error: unknown;
    try {
      decryptDocumentKek(tampered, "correct-horse-battery-staple");
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(RecoveryBundleRefusal);
    expect((error as RecoveryBundleRefusal).code).toBe("wrong-passphrase");
  });

  it("never leaks the passphrase or key material in a refusal message", () => {
    const secretPassphrase = "correct-horse-battery-staple";
    const envelope = encryptDocumentKek(KEK_A, secretPassphrase);
    let message = "";
    try {
      decryptDocumentKek(envelope, "another-wrong-passphrase-value");
    } catch (caught) {
      message = (caught as Error).message;
    }
    expect(message).not.toContain(secretPassphrase);
    expect(message).not.toContain(KEK_A);
  });
});

describe("AES-256-CBC document-archive crypto (backup.sh #19-20,27-28)", () => {
  it("round-trips a plaintext document tar through encrypt/decrypt", () => {
    const plaintext = Buffer.from("fake document tar bytes for round-trip fixture");
    const envelope = encryptDocumentArchive(plaintext, KEK_A);
    expect(decryptDocumentArchive(envelope, KEK_A)).toEqual(plaintext);
  });

  it("prefixes the envelope with OpenSSL's own `Salted__` + 8-byte-salt header (byte-compatible with `openssl enc -salt`)", () => {
    const envelope = encryptDocumentArchive(Buffer.from("x"), KEK_A);
    expect(envelope.subarray(0, 8).toString("ascii")).toBe("Salted__");
    expect(envelope.length).toBeGreaterThan(16);
  });

  it("produces a different envelope every time (fresh salt never reused, mirrors #3's ORBKEK discipline)", () => {
    const plaintext = Buffer.from("fixed plaintext");
    const first = encryptDocumentArchive(plaintext, KEK_A);
    const second = encryptDocumentArchive(plaintext, KEK_A);
    expect(first.equals(second)).toBe(false);
  });

  it("refuses a too-short or bad-magic envelope before any cryptographic operation", () => {
    let error: unknown;
    try {
      decryptDocumentArchive(Buffer.from("short"), KEK_A);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(RecoveryBundleRefusal);
    expect((error as RecoveryBundleRefusal).code).toBe("document-archive-invalid");

    const badMagic = Buffer.concat([Buffer.from("NOTSALT!"), Buffer.alloc(32)]);
    expect(() => decryptDocumentArchive(badMagic, KEK_A)).toThrow(RecoveryBundleRefusal);
  });

  // #659: this used to be one test that encrypted under a fresh random salt
  // and asserted a refusal every run. AES-256-CBC carries no authentication
  // tag — deliberately, so the envelope stays byte-compatible with `openssl
  // enc -pbkdf2` as backup.sh writes it — so a wrong KEK is only noticed when
  // PKCS#7 unpadding fails on the final block. About 1 wrong key in 256
  // decrypts to garbage ending in a plausible pad and is returned instead,
  // which made the test fail roughly 1 CI run in 256 with `expected undefined
  // to be an instance of RecoveryBundleRefusal` on diffs that could not
  // possibly have caused it.
  //
  // The two envelopes below pin one salt from each side of that coin flip, so
  // both branches are exercised on every run rather than sampled at random.
  // To regenerate: for salt = the 8-byte big-endian counter shown in the
  // header bytes, derive key||iv with PBKDF2-HMAC-SHA256(KEK, salt, 600000,
  // 48), AES-256-CBC-encrypt WRONG_KEK_PLAINTEXT under KEK_A, then try to
  // decrypt under KEK_B and keep the first salt that refuses and the first
  // that does not. Over 4,400 consecutive salts, 13 were silently accepted
  // (0.30%, consistent with 1/256 = 0.39%); salt 0 refuses, salt 116 does not.
  const WRONG_KEK_PLAINTEXT = Buffer.from("fake document tar bytes");
  // salt 0x0000000000000000 — decrypting under KEK_B fails to unpad (255/256 case).
  const WRONG_KEK_REFUSED_ENVELOPE = Buffer.from(
    "53616c7465645f5f00000000000000007ac14c5117abf2fc03922f47688b1e859d02b7c753303ccad842b7dd033ac4eb",
    "hex",
  );
  // salt 0x0000000000000074 (116) — decrypting under KEK_B unpads by luck (1/256 case).
  const WRONG_KEK_ACCEPTED_ENVELOPE = Buffer.from(
    "53616c7465645f5f0000000000000074ae8b1bc1026677fff3c30109ba494852a72bb386a8b5895e9f9e2d519a5ead6a",
    "hex",
  );

  it("both wrong-KEK fixtures are genuine envelopes: each decrypts to the same plaintext under the right KEK", () => {
    expect(decryptDocumentArchive(WRONG_KEK_REFUSED_ENVELOPE, KEK_A)).toEqual(WRONG_KEK_PLAINTEXT);
    expect(decryptDocumentArchive(WRONG_KEK_ACCEPTED_ENVELOPE, KEK_A)).toEqual(WRONG_KEK_PLAINTEXT);
  });

  it("reports a wrong document KEK generically as decryption failure, not a detailed crypto error (#19)", () => {
    let error: unknown;
    try {
      decryptDocumentArchive(WRONG_KEK_REFUSED_ENVELOPE, KEK_B);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(RecoveryBundleRefusal);
    expect((error as RecoveryBundleRefusal).code).toBe("document-archive-invalid");
    expect((error as Error).message).toBe("Document archive decryption failed.");
  });

  it("does not promise refusal for every wrong KEK: unauthenticated CBC accepts about 1 in 256, and returns garbage rather than the plaintext (#659)", () => {
    // Documents the hole rather than pretending it is closed. If the envelope
    // ever gains a MAC this test is the one that must change, and the change
    // is a deliberate bundle-format decision, not an incidental fix.
    const decrypted = decryptDocumentArchive(WRONG_KEK_ACCEPTED_ENVELOPE, KEK_B);
    expect(decrypted.equals(WRONG_KEK_PLAINTEXT)).toBe(false);
    expect(sha256Buffer(decrypted)).not.toBe(sha256Buffer(WRONG_KEK_PLAINTEXT));
    // Not a data-loss path: the bundle layers above catch a wrong KEK every
    // time, and none of them depend on the coin flip. See
    // validateBackupManifestAndAuth's `document_kek_sha256` fingerprint
    // refusal ("refuses when the bundle was encrypted with a different
    // document KEK ('wrong key', #15)" below), its HMAC over manifest +
    // checksums, and validateBackupBundleContents refusing garbage that is
    // not a tar (recovery-bundle.docker-adapter.test.ts).
  });

  it("never returns the original plaintext under a wrong KEK, whatever salt is rolled (the property behind #659)", () => {
    // The honest randomised assertion: refusal OR garbage, never a silent
    // successful decrypt. This holds for every salt, so it cannot flake.
    const envelope = encryptDocumentArchive(WRONG_KEK_PLAINTEXT, KEK_A);
    let decrypted: Buffer | undefined;
    try {
      decrypted = decryptDocumentArchive(envelope, KEK_B);
    } catch (caught) {
      expect(caught).toBeInstanceOf(RecoveryBundleRefusal);
      expect((caught as RecoveryBundleRefusal).code).toBe("document-archive-invalid");
    }
    if (decrypted !== undefined) expect(decrypted.equals(WRONG_KEK_PLAINTEXT)).toBe(false);
  });

  it("DOCUMENT_ARCHIVE_ENCRYPTION_ALGORITHM matches the manifest identifier backup.sh records (#27)", () => {
    expect(DOCUMENT_ARCHIVE_ENCRYPTION_ALGORITHM).toBe("aes-256-cbc-pbkdf2-sha256-iter-600000");
  });
});

describe("HMAC bundle authentication (recovery-crypto.mjs #12-13, backup.sh #5,#7,#16)", () => {
  it("computes a base64 HMAC matching the format check", () => {
    const hmac = computeBundleHmac(KEK_A, Buffer.from("manifest-and-checksums"));
    expect(isValidBundleHmac(hmac)).toBe(true);
  });

  it("is deterministic for identical inputs (unlike the ORBKEK envelope)", () => {
    const content = Buffer.from("manifest-and-checksums");
    expect(computeBundleHmac(KEK_A, content)).toBe(computeBundleHmac(KEK_A, content));
  });

  it("verifies successfully when the HMAC matches", () => {
    const content = Buffer.from("manifest-and-checksums");
    const hmac = computeBundleHmac(KEK_A, content);
    expect(() => verifyBundleHmac(KEK_A, content, hmac)).not.toThrow();
  });

  it("refuses when the content has been tampered with after signing (#7)", () => {
    const hmac = computeBundleHmac(KEK_A, Buffer.from("original-content"));
    expect(() => verifyBundleHmac(KEK_A, Buffer.from("tampered-content"), hmac)).toThrow(RecoveryBundleRefusal);
  });

  it("refuses a malformed HMAC value before comparing", () => {
    expect(() => verifyBundleHmac(KEK_A, Buffer.from("x"), "not-base64!!")).toThrow(RecoveryBundleRefusal);
  });

  it("uses a key-separated sub-key, not the raw document KEK (#12)", () => {
    // If the raw KEK were used directly as the HMAC key, this would equal a
    // plain HMAC-SHA256(KEK_A, content); it must not.
    const content = Buffer.from("manifest-and-checksums");
    const naive = createHmac("sha256", Buffer.from(KEK_A, "hex")).update(content).digest("base64");
    expect(computeBundleHmac(KEK_A, content)).not.toBe(naive);
  });
});

describe("document KEK fingerprint (recovery-crypto.mjs #15, backup.sh #6)", () => {
  it("is a deterministic 64-char lowercase hex sha256 of the key", () => {
    const fingerprint = documentKekFingerprint(KEK_A);
    expect(isValidDocumentKekFingerprint(fingerprint)).toBe(true);
    expect(documentKekFingerprint(KEK_A)).toBe(fingerprint);
  });

  it("differs for a different key", () => {
    expect(documentKekFingerprint(KEK_A)).not.toBe(documentKekFingerprint(KEK_B));
  });

  it("never appears verbatim as the raw key in its own output", () => {
    expect(documentKekFingerprint(KEK_A)).not.toBe(KEK_A);
  });
});

describe("key format validation", () => {
  it("isValidDocumentKekHex accepts 64 hex chars and rejects anything else", () => {
    expect(isValidDocumentKekHex(KEK_A)).toBe(true);
    expect(isValidDocumentKekHex(`${KEK_A}0`)).toBe(false);
    expect(isValidDocumentKekHex("not-hex-at-all-not-hex-at-all-not-hex-at-all-not-hex-at-all1234")).toBe(false);
  });
});

describe("checksum helpers", () => {
  it("sha256File matches sha256Buffer of the same content", () => {
    const path = join(workDir, "sample.txt");
    writeFileSync(path, "sample content");
    expect(sha256File(path)).toBe(sha256Buffer(Buffer.from("sample content")));
  });

  // #383: sha256File used to be `createHash("sha256").update(readFileSync(path))`,
  // which both materialises the whole file at once and hard-fails
  // (ERR_FS_FILE_TOO_LARGE) above 2 GiB regardless of available memory. It
  // is now a chunked O_NOFOLLOW readSync loop, the same incremental shape
  // `sha256sum` itself uses. A file large enough to actually exceed 2 GiB is
  // impractical in a test; these instead prove the *mechanism* (chunked
  // reads, never one huge allocation) via instrumentation, plus a
  // large-but-tractable real file that stays within an asserted memory
  // bound.
  describe("sha256File streams in bounded chunks (#383)", () => {
    it("never allocates a read buffer anywhere near the file's size, however large the file is (mechanism instrumentation)", () => {
      // Node's builtin "node:fs" module namespace can't be spied on directly
      // under Vitest's ESM runtime ("Module namespace is not configurable in
      // ESM"), so this instruments the one thing sha256File *does* touch
      // that's spy-able: Buffer allocation. A whole-file-buffering
      // implementation (the old `readFileSync(path)`) allocates a buffer
      // sized to the file; the chunked implementation must never allocate
      // anywhere near that, regardless of how large the file is.
      const path = join(workDir, "chunked.bin");
      const size = 6 * 1024 * 1024;
      const content = Buffer.alloc(size, 7);
      writeFileSync(path, content);

      const allocSpy = vi.spyOn(Buffer, "allocUnsafe");
      try {
        const digest = sha256File(path);
        expect(digest).toBe(sha256Buffer(content));

        expect(allocSpy).toHaveBeenCalled();
        for (const call of allocSpy.mock.calls) {
          const requestedSize = call[0] as number;
          expect(requestedSize).toBeLessThan(size);
        }
      } finally {
        allocSpy.mockRestore();
      }
    });

    it("digests a 100 MB file without an RSS spike proportional to its size", () => {
      const path = join(workDir, "large.bin");
      const size = 100 * 1024 * 1024;
      writeFileSync(path, Buffer.alloc(size, 9));

      const before = process.memoryUsage().rss;
      const digest = sha256File(path);
      const after = process.memoryUsage().rss;

      expect(digest).toMatch(/^[0-9a-f]{64}$/);
      // A whole-file buffering approach needs to grow the process's memory
      // by roughly the file's size (100 MB) to hold it; the chunked
      // implementation never holds more than ~1 MB at once, so RSS growth
      // attributable to the read itself should be a small fraction of that.
      expect(after - before).toBeLessThan(40 * 1024 * 1024);
    }, 30_000);

    it("refuses to follow a symlink (O_NOFOLLOW discipline, matching readRegularFileNoFollow)", () => {
      const target = join(workDir, "target.txt");
      writeFileSync(target, "target content");
      const link = join(workDir, "link.txt");
      symlinkSync(target, link);
      expect(() => sha256File(link)).toThrow();
    });
  });
});

// #383: encryptDocumentArchive holds the plaintext, the ciphertext, and a
// concatenated header+ciphertext copy in memory simultaneously —
// encryptDocumentArchiveToFile is the bounded-memory sibling createBackupBundle
// now uses, streaming plaintext -> cipher -> ciphertext through fixed-size
// chunks while producing the exact same `Salted__`+salt+ciphertext format
// (proven here by round-tripping through the existing decryptDocumentArchive,
// which is itself parity-tested against real `openssl` in
// recovery-bundle.parity.test.ts).
describe("encryptDocumentArchiveToFile streams in bounded chunks (#383)", () => {
  it("round-trips a multi-chunk plaintext through decryptDocumentArchive", () => {
    // (Buffer.allocUnsafe instrumentation, as used for sha256File above, was
    // tried here too but made pbkdf2Sync's 600,000 iterations pathologically
    // slow under a global spy; the mechanism is instead covered by
    // sha256File's instrumentation test plus the real 100 MB memory-bound
    // test below, which exercises the identical chunked read/cipher loop.
    // Note: comparing multi-MB buffers with Vitest's `toEqual` is itself
    // catastrophically slow — element-by-element deep equality, not a native
    // memcmp — so buffer content here is compared with `.equals()`, not
    // `toEqual`.)
    const plaintextPath = join(workDir, "documents.tar");
    const outputPath = join(workDir, "documents.tar.enc");
    const size = 6 * 1024 * 1024;
    const content = Buffer.alloc(size, 3);
    writeFileSync(plaintextPath, content);

    encryptDocumentArchiveToFile(plaintextPath, KEK_A, outputPath);

    const encrypted = readFileSync(outputPath);
    // Never buffers plaintext-sized output growth beyond the format's own
    // ~16-byte CBC padding overhead.
    expect(encrypted.length).toBeLessThanOrEqual(size + 8 /* magic */ + 8 /* salt */ + 16 /* CBC padding block */);
    expect(decryptDocumentArchive(encrypted, KEK_A).equals(content)).toBe(true);
  });

  it("produces output decryptDocumentArchive accepts, byte-identical in shape to encryptDocumentArchive's in-memory output for the same plaintext/key (modulo the random salt)", () => {
    const plaintextPath = join(workDir, "documents-small.tar");
    const outputPath = join(workDir, "documents-small.tar.enc");
    const content = Buffer.from("a small document archive fixture\n");
    writeFileSync(plaintextPath, content);

    encryptDocumentArchiveToFile(plaintextPath, KEK_A, outputPath);
    const streamed = readFileSync(outputPath);
    const buffered = encryptDocumentArchive(content, KEK_A);

    expect(streamed.length).toBe(buffered.length);
    expect(streamed.subarray(0, 8)).toEqual(buffered.subarray(0, 8)); // "Salted__" magic
    expect(decryptDocumentArchive(streamed, KEK_A)).toEqual(content);
  });

  it("digests/encrypts a 100 MB plaintext without an RSS spike proportional to its size", () => {
    const plaintextPath = join(workDir, "large-documents.tar");
    const outputPath = join(workDir, "large-documents.tar.enc");
    const size = 100 * 1024 * 1024;
    writeFileSync(plaintextPath, Buffer.alloc(size, 4));

    const before = process.memoryUsage().rss;
    encryptDocumentArchiveToFile(plaintextPath, KEK_A, outputPath);
    const after = process.memoryUsage().rss;

    expect(after - before).toBeLessThan(60 * 1024 * 1024);

    const outputStat = fs.statSync(outputPath);
    expect(outputStat.size).toBeLessThanOrEqual(size + 8 + 8 + 16);
  }, 30_000);
});

// #383 (addon): checksums.sha256 member names must be plain basenames.
// verifyChecksumsFile previously joined `(.+)` straight onto extractedDir
// with no confinement check, and for the outer recovery bundle this content
// is read (verifyRecoveryBundleChecksums, called from
// runImportRecoveryBundle before decryptDocumentKek) before any secret
// material is verified — deliberately so, since the module comment on
// verifyRecoveryBundleChecksums notes that layer's checksums.sha256 is not
// HMAC-authenticated. A `../`-laden member name let a maliciously crafted
// recovery bundle turn `orbit import-recovery-bundle` into a digest-guessing
// / existence oracle against arbitrary paths outside the extraction
// directory (or hang against a device file).
describe("verifyChecksumsFile rejects path-traversal member names (#383)", () => {
  it("refuses a member name containing a directory traversal, without ever hashing the escaped path", () => {
    const dir = join(workDir, "traversal-target");
    mkdirSync(dir, { recursive: true });
    const outsideSecret = join(workDir, "outside-secret.txt");
    writeFileSync(outsideSecret, "a secret that must never be probed via checksums.sha256\n");
    const outsideDigest = sha256File(outsideSecret);

    const checksumsPath = join(dir, "checksums.sha256");
    writeFileSync(checksumsPath, `${outsideDigest}  ../outside-secret.txt\n`);

    let error: unknown;
    try {
      verifyChecksumsFile(dir, checksumsPath);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(RecoveryBundleRefusal);
    expect((error as RecoveryBundleRefusal).code).toBe("checksum-mismatch");
  });

  it("refuses a member name that is an absolute-looking path", () => {
    const dir = join(workDir, "traversal-absolute");
    mkdirSync(dir, { recursive: true });
    const checksumsPath = join(dir, "checksums.sha256");
    writeFileSync(checksumsPath, `${"0".repeat(64)}  /etc/passwd\n`);
    expect(() => verifyChecksumsFile(dir, checksumsPath)).toThrow(RecoveryBundleRefusal);
  });

  it("still accepts a legitimate plain-basename member name", () => {
    const dir = join(workDir, "traversal-legit");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "database.dump"), "fixture dump bytes");
    const checksumsPath = join(dir, "checksums.sha256");
    writeFileSync(checksumsPath, `${sha256File(join(dir, "database.dump"))}  database.dump\n`);
    expect(() => verifyChecksumsFile(dir, checksumsPath)).not.toThrow();
  });
});

describe("manifest text (byte-for-byte format)", () => {
  it("buildBackupManifest matches backup.sh's field order exactly", () => {
    const content = buildBackupManifest({
      createdAt: "2026-08-13T00:00:00Z",
      databaseDump: "database.dump",
      documentsArchive: "documents.tar.enc",
      documentsEncryption: "aes-256-cbc-pbkdf2-sha256-iter-600000",
      documentKekSha256: documentKekFingerprint(KEK_A),
    });
    expect(content).toBe(
      `format_version=${BACKUP_BUNDLE_FORMAT_VERSION}\n` +
        "created_at=2026-08-13T00:00:00Z\n" +
        "database_dump=database.dump\n" +
        "documents_archive=documents.tar.enc\n" +
        "documents_encryption=aes-256-cbc-pbkdf2-sha256-iter-600000\n" +
        `document_kek_sha256=${documentKekFingerprint(KEK_A)}\n`,
    );
  });

  it("buildRecoveryManifest matches export-recovery-bundle.sh's printf exactly", () => {
    expect(buildRecoveryManifest()).toBe(
      `format_version=${RECOVERY_BUNDLE_FORMAT_VERSION}\nkey_encryption=${RECOVERY_KEY_ENCRYPTION_ALGORITHM}\n`,
    );
  });

  it("manifestDeclares does an exact single-line match, not a substring search", () => {
    const content = "format_version=1\ncreated_at=2026-08-13T00:00:00Z\n";
    expect(manifestDeclares(content, "format_version", "1")).toBe(true);
    expect(manifestDeclares(content, "format_version", "10")).toBe(false);
    expect(manifestDeclares(content, "created_at", "2026-08-13T00:00:00")).toBe(false);
  });

  it("readManifestField returns the field value or undefined", () => {
    const content = "format_version=1\ncreated_at=2026-08-13T00:00:00Z\n";
    expect(readManifestField(content, "created_at")).toBe("2026-08-13T00:00:00Z");
    expect(readManifestField(content, "missing_field")).toBeUndefined();
  });
});

function buildBackupBundleFixture(dir: string, documentKekHex: string): string {
  mkdirSync(dir, { recursive: true });
  const manifest = buildBackupManifest({
    createdAt: "2026-08-13T00:00:00Z",
    databaseDump: "database.dump",
    documentsArchive: "documents.tar.enc",
    documentsEncryption: "aes-256-cbc-pbkdf2-sha256-iter-600000",
    documentKekSha256: documentKekFingerprint(documentKekHex),
  });
  writeFileSync(join(dir, "manifest"), manifest);
  writeFileSync(join(dir, "database.dump"), "fake-pg-dump-bytes");
  writeFileSync(join(dir, "documents.tar.enc"), "fake-encrypted-documents-bytes");
  const checksums =
    `${sha256File(join(dir, "database.dump"))}  database.dump\n` +
    `${sha256File(join(dir, "documents.tar.enc"))}  documents.tar.enc\n`;
  writeFileSync(join(dir, "checksums.sha256"), checksums);
  const manifestAndChecksums = Buffer.concat([Buffer.from(manifest), Buffer.from(checksums)]);
  writeFileSync(join(dir, "manifest.hmac"), computeBundleHmac(documentKekHex, manifestAndChecksums));
  const tarPath = join(dir, "..", "bundle.tar");
  createTar(dir, tarPath, [...BACKUP_BUNDLE_MEMBERS]);
  return tarPath;
}

describe("backup bundle layout (backup.sh #11-13)", () => {
  it("accepts a bundle with exactly the five expected members", () => {
    const dir = join(workDir, "valid-bundle");
    const tarPath = buildBackupBundleFixture(dir, KEK_A);
    expect(() => validateBackupBundleLayout(tarPath)).not.toThrow();
    expect([...listTarMembers(tarPath)].sort()).toEqual([...BACKUP_BUNDLE_MEMBERS].sort());
  });

  it("refuses a bundle missing an expected member", () => {
    const dir = join(workDir, "missing-member");
    mkdirSync(dir, { recursive: true });
    for (const name of BACKUP_BUNDLE_MEMBERS) writeFileSync(join(dir, name), "x");
    const tarPath = join(workDir, "missing-member.tar");
    createTar(dir, tarPath, BACKUP_BUNDLE_MEMBERS.filter((name) => name !== "manifest.hmac"));
    let error: unknown;
    try {
      validateBackupBundleLayout(tarPath);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(RecoveryBundleRefusal);
    expect((error as RecoveryBundleRefusal).code).toBe("unexpected-members");
  });

  it("refuses a bundle with an extra, attacker-controlled member", () => {
    const dir = join(workDir, "extra-member");
    mkdirSync(dir, { recursive: true });
    for (const name of BACKUP_BUNDLE_MEMBERS) writeFileSync(join(dir, name), "x");
    writeFileSync(join(dir, "attacker-controlled"), "x");
    const tarPath = join(workDir, "extra-member.tar");
    createTar(dir, tarPath, [...BACKUP_BUNDLE_MEMBERS, "attacker-controlled"]);
    expect(() => validateBackupBundleLayout(tarPath)).toThrow(RecoveryBundleRefusal);
  });

  it("refuses a bundle containing a symlink entry (#12)", () => {
    const dir = join(workDir, "symlink-member");
    mkdirSync(dir, { recursive: true });
    for (const name of BACKUP_BUNDLE_MEMBERS) {
      if (name === "manifest.hmac") continue;
      writeFileSync(join(dir, name), "x");
    }
    writeFileSync(join(dir, "real-target"), "x");
    symlinkSync(join(dir, "real-target"), join(dir, "manifest.hmac"));
    const tarPath = join(workDir, "symlink-member.tar");
    createTar(dir, tarPath, [...BACKUP_BUNDLE_MEMBERS]);
    let error: unknown;
    try {
      validateBackupBundleLayout(tarPath);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(RecoveryBundleRefusal);
    expect((error as RecoveryBundleRefusal).code).toBe("link-or-special-entry");
  });
});

describe("document archive path allow-list (backup.sh #8-10)", () => {
  const HASH = "a".repeat(64);

  it("accepts the directory scaffolding plus a correctly-prefixed object", () => {
    const entries = [
      { typeChar: "d", name: "./" },
      { typeChar: "d", name: "./objects/" },
      { typeChar: "d", name: "./objects/aa/" },
      { typeChar: "d", name: "./objects/aa/aa/" },
      { typeChar: "-", name: `./objects/aa/aa/${HASH}.bin` },
      { typeChar: "d", name: "./staging/" },
    ];
    expect(() => validateDocumentArchiveEntries(entries)).not.toThrow();
  });

  it("accepts a staging object", () => {
    expect(() => validateDocumentArchiveEntries([{ typeChar: "-", name: `./staging/${HASH}.bin` }])).not.toThrow();
  });

  it("refuses an object whose directory prefix does not match its own hash (#9)", () => {
    let error: unknown;
    try {
      validateDocumentArchiveEntries([{ typeChar: "-", name: `./objects/bb/bb/${HASH}.bin` }]);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(RecoveryBundleRefusal);
    expect((error as RecoveryBundleRefusal).code).toBe("misplaced-object");
  });

  it("refuses an unexpected path (path traversal / injection attempt, #8)", () => {
    expect(() => validateDocumentArchiveEntries([{ typeChar: "-", name: "../../etc/passwd" }])).toThrow(RecoveryBundleRefusal);
  });

  it("refuses a symlink or special file even at an otherwise-valid path (#10)", () => {
    let error: unknown;
    try {
      validateDocumentArchiveEntries([{ typeChar: "l", name: `./objects/aa/aa/${HASH}.bin` }]);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(RecoveryBundleRefusal);
    expect((error as RecoveryBundleRefusal).code).toBe("link-or-special-entry");
  });

  describe("hostile member names (issue #383 finding 4: tar -tvf column parsing must not truncate names containing a space)", () => {
    /**
     * Builds a real archive with a single member whose stored name is
     * `hostileName`, using GNU tar's `--transform` to rename it at archive
     * -creation time (no path on the real filesystem is ever created with
     * that literal name, so this stays entirely inside the sandbox).
     */
    function buildArchiveWithHostileMemberName(hostileName: string): string {
      const sourceDir = join(workDir, "hostile-source");
      mkdirSync(sourceDir, { recursive: true });
      writeFileSync(join(sourceDir, "f"), "x");
      const tarPath = join(workDir, "hostile.tar");
      const result = spawnSync("tar", ["-cf", tarPath, "--transform", `s@^f$@${hostileName}@`, "-C", sourceDir, "f"], { encoding: "utf8" });
      if (result.status !== 0) throw new Error(`test setup: tar --transform failed: ${result.stderr}`);
      return tarPath;
    }

    it("listTarEntriesVerbose reports the member's real, full name — never the tail after its last space", () => {
      const hostileName = `pwn-file ./staging/${HASH}.bin`;
      const tarPath = buildArchiveWithHostileMemberName(hostileName);

      const entries = listTarEntriesVerbose(tarPath);

      expect(entries).toHaveLength(1);
      // Before the fix: name parsing took everything after the line's last
      // space, so this reported `./staging/<hash>.bin` — a
      // STAGING_PATH_PATTERN-matching name that was never the archive's
      // actual member name.
      expect(entries[0].name).toBe(hostileName);
    });

    it("validateDocumentArchiveEntries refuses a hostile member whose truncated tail would otherwise match the staging allow-list", () => {
      const hostileName = `pwn-file ./staging/${HASH}.bin`;
      const tarPath = buildArchiveWithHostileMemberName(hostileName);

      const entries = listTarEntriesVerbose(tarPath);
      let error: unknown;
      try {
        validateDocumentArchiveEntries(entries);
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(RecoveryBundleRefusal);
      expect((error as RecoveryBundleRefusal).code).toBe("link-or-special-entry");
    });

    it("refuses a hostile member whose space-separated tail would otherwise match the objects allow-list", () => {
      const hostileName = `pwn-file ./objects/${HASH.slice(0, 2)}/${HASH.slice(2, 4)}/${HASH}.bin`;
      const tarPath = buildArchiveWithHostileMemberName(hostileName);

      const entries = listTarEntriesVerbose(tarPath);
      expect(entries[0].name).toBe(hostileName);
      expect(() => validateDocumentArchiveEntries(entries)).toThrow(RecoveryBundleRefusal);
    });
  });
});

describe("backup bundle manifest + HMAC + checksum verification (backup.sh #7,#14-17)", () => {
  it("accepts a validly-built bundle", () => {
    const dir = join(workDir, "valid");
    buildBackupBundleFixture(dir, KEK_A);
    const fields = validateBackupManifestAndAuth(dir, KEK_A);
    expect(fields.documentKekSha256).toBe(documentKekFingerprint(KEK_A));
    expect(fields.databaseDump).toBe("database.dump");
  });

  it("refuses when the bundle was encrypted with a different document KEK ('wrong key', #15)", () => {
    const dir = join(workDir, "wrong-key");
    buildBackupBundleFixture(dir, KEK_A);
    let error: unknown;
    try {
      validateBackupManifestAndAuth(dir, KEK_B);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(RecoveryBundleRefusal);
    expect((error as RecoveryBundleRefusal).code).toBe("wrong-key");
  });

  it("refuses an unsupported format_version (#14)", () => {
    const dir = join(workDir, "bad-version");
    buildBackupBundleFixture(dir, KEK_A);
    writeFileSync(join(dir, "manifest"), readFileSync(join(dir, "manifest"), "utf8").replace("format_version=1", "format_version=2"));
    let error: unknown;
    try {
      validateBackupManifestAndAuth(dir, KEK_A);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(RecoveryBundleRefusal);
    expect((error as RecoveryBundleRefusal).code).toBe("unsupported-format-version");
  });

  it("refuses a tampered manifest (HMAC no longer matches, corrupt-manifest scenario)", () => {
    const dir = join(workDir, "corrupt-manifest");
    buildBackupBundleFixture(dir, KEK_A);
    writeFileSync(join(dir, "manifest"), `${readFileSync(join(dir, "manifest"), "utf8")}corruption\n`);
    let error: unknown;
    try {
      validateBackupManifestAndAuth(dir, KEK_A);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(RecoveryBundleRefusal);
    expect((error as RecoveryBundleRefusal).code).toBe("hmac-mismatch");
  });

  it("refuses a tampered manifest.hmac (corrupt-hmac scenario)", () => {
    const dir = join(workDir, "corrupt-hmac");
    buildBackupBundleFixture(dir, KEK_A);
    writeFileSync(join(dir, "manifest.hmac"), `${readFileSync(join(dir, "manifest.hmac"), "utf8")}x`);
    expect(() => validateBackupManifestAndAuth(dir, KEK_A)).toThrow(RecoveryBundleRefusal);
  });

  it("refuses a tampered checksums.sha256 (corrupt-checksum scenario, #17)", () => {
    const dir = join(workDir, "corrupt-checksum");
    buildBackupBundleFixture(dir, KEK_A);
    const originalChecksums = readFileSync(join(dir, "checksums.sha256"), "utf8");
    const tamperedChecksums = originalChecksums.replace(/^[0-9a-f]{64}(?=  database\.dump)/m, "0".repeat(64));
    writeFileSync(join(dir, "checksums.sha256"), tamperedChecksums);
    // Re-sign the tampered manifest+checksums so the failure under test is
    // specifically the checksum-vs-content mismatch, not the HMAC.
    const manifest = readFileSync(join(dir, "manifest"), "utf8");
    const manifestAndChecksums = Buffer.concat([Buffer.from(manifest), Buffer.from(tamperedChecksums)]);
    writeFileSync(join(dir, "manifest.hmac"), computeBundleHmac(KEK_A, manifestAndChecksums));
    let error: unknown;
    try {
      validateBackupManifestAndAuth(dir, KEK_A);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(RecoveryBundleRefusal);
    expect((error as RecoveryBundleRefusal).code).toBe("checksum-mismatch");
  });

  it("verifyChecksumsFile is exercised directly and refuses a missing file", () => {
    const dir = join(workDir, "missing-checksummed-file");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "checksums.sha256"), `${"0".repeat(64)}  does-not-exist\n`);
    expect(() => verifyChecksumsFile(dir, join(dir, "checksums.sha256"))).toThrow(RecoveryBundleRefusal);
  });
});

function buildRecoveryBundleFixture(dir: string, innerBundleContent: Buffer, kekEnvelope: Buffer): string {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "manifest"), buildRecoveryManifest());
  writeFileSync(join(dir, "orbit-backup.tar"), innerBundleContent);
  writeFileSync(join(dir, "document-kek.enc"), kekEnvelope);
  const checksums =
    `${sha256File(join(dir, "orbit-backup.tar"))}  orbit-backup.tar\n` +
    `${sha256File(join(dir, "document-kek.enc"))}  document-kek.enc\n`;
  writeFileSync(join(dir, "checksums.sha256"), checksums);
  const tarPath = join(dir, "..", "recovery-bundle.tar");
  createTar(dir, tarPath, [...RECOVERY_BUNDLE_MEMBERS]);
  return tarPath;
}

describe("recovery bundle layout (import-recovery-bundle.sh #5-7)", () => {
  it("accepts a bundle with exactly the four expected members", () => {
    const dir = join(workDir, "valid-recovery");
    const envelope = encryptDocumentKek(KEK_A, "correct-horse-battery-staple");
    const tarPath = buildRecoveryBundleFixture(dir, Buffer.from("fake-inner-backup-tar-bytes"), envelope);
    expect(() => validateRecoveryBundleLayout(tarPath)).not.toThrow();
  });

  it("refuses a bundle with an unexpected member set (test_recovery_bundle_diagnostics)", () => {
    const dir = join(workDir, "unexpected-member");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "attacker-controlled-member"), "attacker-controlled-content\n");
    const tarPath = join(workDir, "unexpected-member.tar");
    createTar(dir, tarPath, ["attacker-controlled-member"]);
    let error: unknown;
    try {
      validateRecoveryBundleLayout(tarPath);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(RecoveryBundleRefusal);
    expect((error as RecoveryBundleRefusal).code).toBe("unexpected-members");
    expect((error as Error).message).not.toContain("attacker-controlled-member");
  });

  it("refuses a bundle containing a symlink entry (#6)", () => {
    const dir = join(workDir, "recovery-symlink");
    mkdirSync(dir, { recursive: true });
    for (const name of RECOVERY_BUNDLE_MEMBERS) {
      if (name === "document-kek.enc") continue;
      writeFileSync(join(dir, name), "x");
    }
    writeFileSync(join(dir, "real-target"), "x");
    symlinkSync(join(dir, "real-target"), join(dir, "document-kek.enc"));
    const tarPath = join(workDir, "recovery-symlink.tar");
    createTar(dir, tarPath, [...RECOVERY_BUNDLE_MEMBERS]);
    let error: unknown;
    try {
      validateRecoveryBundleLayout(tarPath);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(RecoveryBundleRefusal);
    expect((error as RecoveryBundleRefusal).code).toBe("link-or-special-entry");
  });
});

describe("recovery bundle manifest and checksums (import-recovery-bundle.sh #8-9)", () => {
  it("accepts a matching format_version and passes checksum verification", () => {
    const dir = join(workDir, "recovery-valid");
    const envelope = encryptDocumentKek(KEK_A, "correct-horse-battery-staple");
    buildRecoveryBundleFixture(dir, Buffer.from("fake-inner-backup-tar-bytes"), envelope);
    expect(() => validateRecoveryManifestFormatVersion(dir)).not.toThrow();
    expect(() => verifyRecoveryBundleChecksums(dir)).not.toThrow();
  });

  it("refuses an unsupported format_version (#8)", () => {
    const dir = join(workDir, "recovery-bad-version");
    const envelope = encryptDocumentKek(KEK_A, "correct-horse-battery-staple");
    buildRecoveryBundleFixture(dir, Buffer.from("fake-inner-backup-tar-bytes"), envelope);
    writeFileSync(join(dir, "manifest"), "format_version=2\nkey_encryption=aes-256-gcm-scrypt-n131072-r8-p1\n");
    let error: unknown;
    try {
      validateRecoveryManifestFormatVersion(dir);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(RecoveryBundleRefusal);
    expect((error as RecoveryBundleRefusal).code).toBe("unsupported-format-version");
  });

  it("refuses a corrupt checksum (corrupt-recovery-checksum scenario, #9)", () => {
    const dir = join(workDir, "recovery-bad-checksum");
    const envelope = encryptDocumentKek(KEK_A, "correct-horse-battery-staple");
    buildRecoveryBundleFixture(dir, Buffer.from("fake-inner-backup-tar-bytes"), envelope);
    const bad = readFileSync(join(dir, "checksums.sha256"), "utf8").replace(/^[0-9a-f]{64}(?=  orbit-backup\.tar)/m, "0".repeat(64));
    writeFileSync(join(dir, "checksums.sha256"), bad);
    let error: unknown;
    try {
      verifyRecoveryBundleChecksums(dir);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(RecoveryBundleRefusal);
    expect((error as RecoveryBundleRefusal).code).toBe("checksum-mismatch");
    expect((error as Error).message).not.toContain("orbit-backup.tar");
  });
});

describe("end-to-end recovery bundle round trip", () => {
  it("wraps and unwraps a document KEK across a full recovery-bundle-shaped fixture", () => {
    const passphrase = "correct-horse-battery-staple";
    const envelope = encryptDocumentKek(KEK_A, passphrase);
    const dir = join(workDir, "round-trip");
    const tarPath = buildRecoveryBundleFixture(dir, Buffer.from("inner-bundle-bytes"), envelope);

    validateRecoveryBundleLayout(tarPath);
    const extractDir = join(workDir, "round-trip-extracted");
    mkdirSync(extractDir);
    extractTar(tarPath, extractDir);
    validateRecoveryManifestFormatVersion(extractDir);
    verifyRecoveryBundleChecksums(extractDir);
    const recoveredEnvelope = readFileSync(join(extractDir, "document-kek.enc"));
    const recoveredKey = decryptDocumentKek(recoveredEnvelope, passphrase);
    expect(recoveredKey.toString("ascii")).toBe(KEK_A);
  });
});

describe("listTarEntriesVerbose", () => {
  it("parses type characters for regular files and directories", () => {
    const dir = join(workDir, "listing");
    mkdirSync(join(dir, "sub"), { recursive: true });
    writeFileSync(join(dir, "sub", "file.txt"), "x");
    const tarPath = join(workDir, "listing.tar");
    createTar(dir, tarPath, ["sub"]);
    const entries = listTarEntriesVerbose(tarPath);
    expect(entries.some((entry) => entry.typeChar === "d")).toBe(true);
    expect(entries.some((entry) => entry.typeChar === "-" && entry.name.endsWith("file.txt"))).toBe(true);
  });
});
