import { describe, expect, it } from "vitest";
import { getDocumentConfig } from "./config";

const key = "ab".repeat(32);

describe("document configuration", () => {
  it("loads secure defaults and derives a stable non-secret key identifier", () => {
    const config = getDocumentConfig({ NODE_ENV: "test", DOCUMENT_KEK: key });
    expect(config.maxBytes).toBe(25 * 1_048_576);
    expect(config.householdQuotaBytes).toBe(5 * 1_073_741_824);
    expect(config.instanceQuotaBytes).toBe(20 * 1_073_741_824);
    expect(config.scanMode).toBe("required");
    expect(config.keyEncryptionKey).toEqual(Buffer.from(key, "hex"));
    expect(config.keyId).toMatch(/^[a-f0-9]{24}$/);
  });

  it.each([
    [{ DOCUMENT_KEK: "short" }, "DOCUMENT_KEK"],
    [{ DOCUMENT_KEK: key, DOCUMENT_HOUSEHOLD_QUOTA_BYTES: "1000", DOCUMENT_INSTANCE_QUOTA_BYTES: "500" }, "Too small"],
    [{ DOCUMENT_KEK: key, DOCUMENTS_ROOT: "/same", DOCUMENTS_QUARANTINE_ROOT: "/same" }, "must be separate"],
  ])("rejects unsafe document configuration", (changes, message) => {
    expect(() => getDocumentConfig({ NODE_ENV: "test", ...changes })).toThrow(message);
  });
});
