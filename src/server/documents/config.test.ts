import { describe, expect, it } from "vitest";
import { getDocumentConfig, keyEncryptionKeyFor } from "./config";

const key = "ab".repeat(32);
const nextKey = "cd".repeat(32);

describe("document configuration", () => {
  it("loads secure defaults and derives a stable non-secret key identifier", () => {
    const config = getDocumentConfig({ NODE_ENV: "test", DOCUMENT_KEK: key });
    expect(config.maxBytes).toBe(25 * 1_048_576);
    expect(config.householdQuotaBytes).toBe(5 * 1_073_741_824);
    expect(config.instanceQuotaBytes).toBe(20 * 1_073_741_824);
    expect(config.scanRecoveryRetentionHours).toBe(24);
    expect(config.scanMode).toBe("required");
    expect(config.keyEncryptionKey).toEqual(Buffer.from(key, "hex"));
    expect(config.keyId).toMatch(/^[a-f0-9]{24}$/);
    expect(config.nextKeyEncryptionKey).toBeNull();
    expect(config.nextKeyId).toBeNull();
  });

  it.each([
    [{ DOCUMENT_KEK: "short" }, "DOCUMENT_KEK"],
    [{ DOCUMENT_KEK: key, DOCUMENT_HOUSEHOLD_QUOTA_BYTES: "1000", DOCUMENT_INSTANCE_QUOTA_BYTES: "500" }, "Too small"],
    [{ DOCUMENT_KEK: key, DOCUMENTS_ROOT: "/same", DOCUMENTS_QUARANTINE_ROOT: "/same" }, "must be separate"],
    [{ DOCUMENT_KEK: key, DOCUMENT_KEK_NEXT: "short" }, "DOCUMENT_KEK_NEXT"],
    [{ DOCUMENT_KEK: key, DOCUMENT_KEK_NEXT: "zz".repeat(32) }, "DOCUMENT_KEK_NEXT"],
    [{ DOCUMENT_KEK: key, DOCUMENT_KEK_NEXT: key }, "nothing to rotate"],
  ])("rejects unsafe document configuration", (changes, message) => {
    expect(() => getDocumentConfig({ NODE_ENV: "test", ...changes })).toThrow(message);
  });

  it("#954: holds a second key only while DOCUMENT_KEK_NEXT is set, distinct from the current one", () => {
    const config = getDocumentConfig({ NODE_ENV: "test", DOCUMENT_KEK: key, DOCUMENT_KEK_NEXT: nextKey });
    expect(config.nextKeyEncryptionKey).toEqual(Buffer.from(nextKey, "hex"));
    expect(config.nextKeyId).toMatch(/^[a-f0-9]{24}$/);
    expect(config.nextKeyId).not.toBe(config.keyId);
  });

  describe("keyEncryptionKeyFor (#954, ADR-0024 decision 4)", () => {
    it("picks the current key for a row wrapped under it, even with no rotation in progress", () => {
      const config = getDocumentConfig({ NODE_ENV: "test", DOCUMENT_KEK: key });
      expect(keyEncryptionKeyFor(config, config.keyId)).toEqual(config.keyEncryptionKey);
    });

    it("picks whichever of the current or next key matches a row's key_id during a rotation", () => {
      const config = getDocumentConfig({ NODE_ENV: "test", DOCUMENT_KEK: key, DOCUMENT_KEK_NEXT: nextKey });
      expect(keyEncryptionKeyFor(config, config.keyId)).toEqual(config.keyEncryptionKey);
      expect(keyEncryptionKeyFor(config, config.nextKeyId!)).toEqual(config.nextKeyEncryptionKey);
    });

    it("returns undefined for a key_id that matches neither held key", () => {
      const config = getDocumentConfig({ NODE_ENV: "test", DOCUMENT_KEK: key, DOCUMENT_KEK_NEXT: nextKey });
      expect(keyEncryptionKeyFor(config, "some-other-key-id")).toBeUndefined();
    });
  });
});
