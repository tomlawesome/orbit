import { describe, expect, it, vi } from "vitest";
import { AppError } from "@/lib/app-error";
import type { EncryptedPortableArchive } from "@/server/portable-archive";
import { KDF_TEST_TIMEOUT_MS } from "../../scripts/process-budget.mjs";
import { previewPortableArchive } from "./portable-archive-repository";

// scrypt N=16384 by design; see KDF_TEST_TIMEOUT_MS
// (scripts/process-budget.mjs) for the cost and the figure it's set from.
vi.setConfig({ testTimeout: KDF_TEST_TIMEOUT_MS });

const passphrase = "correct-horse-battery-staple";

// Base64url has no padding, so this is the exact maximum length for a
// ciphertext that could decode to the module's 128 MiB archive bound
// (`Math.ceil(128 * 1024 * 1024 / 3) * 4`). One character over it can only
// decode to more than 128 MiB.
const MAX_ARCHIVE_CIPHERTEXT_CHARACTERS = 178_956_972;

function oversizedArchive(): EncryptedPortableArchive {
  return {
    version: 1,
    algorithm: "aes-256-gcm",
    kdf: "scrypt",
    salt: "AA",
    iv: "AA",
    authTag: "AA",
    // Garbage, not a real ciphertext: if `previewPortableArchive` ever
    // reached `decryptPortableArchive` with this, AES-GCM authentication
    // would fail and surface as `archive_passphrase_invalid`, not
    // `archive_too_large`. Seeing `archive_too_large` is proof the length
    // bound rejected the archive before scryptSync or the cipher ran on it.
    ciphertext: "A".repeat(MAX_ARCHIVE_CIPHERTEXT_CHARACTERS + 1),
  };
}

describe("portable archive size bound (#383 finding 3)", () => {
  it("rejects an oversized archive by ciphertext length before ever decrypting it", () => {
    let caught: unknown;
    try {
      previewPortableArchive(oversizedArchive(), passphrase);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(AppError);
    expect((caught as AppError).code).toBe("archive_too_large");
    expect((caught as AppError).status).toBe(413);
  });

  it("still rejects a ciphertext within the bound but with the wrong passphrase, proving the size check does not mask other failures", () => {
    let caught: unknown;
    try {
      previewPortableArchive({
        version: 1,
        algorithm: "aes-256-gcm",
        kdf: "scrypt",
        salt: "AA",
        iv: "AA",
        authTag: "AA",
        ciphertext: "AAAA",
      }, passphrase);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(AppError);
    expect((caught as AppError).code).toBe("archive_passphrase_invalid");
  });
});
