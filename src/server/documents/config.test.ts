import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { documentKeyProblem, documentRetentionDays, getDocumentConfig, keyEncryptionKeyFor } from "./config";

const key = "ab".repeat(32);
const nextKey = "cd".repeat(32);

describe("document configuration", () => {
  it("loads secure defaults and derives a stable non-secret key identifier", () => {
    const config = getDocumentConfig({ NODE_ENV: "test", DOCUMENT_KEK: key });
    expect(config.maxBytes).toBe(50 * 1_048_576);
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

  it("treats an empty DOCUMENT_SCAN_MODE as unset, like the install-time contract does (#1151 SF2-F3)", () => {
    const config = getDocumentConfig({ NODE_ENV: "test", DOCUMENT_KEK: key, DOCUMENT_SCAN_MODE: "" });
    expect(config.scanMode).toBe("required");
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

/* #1336 review: the session route reports the document retention window to
   every signed-in screen, so reading it must not need the document key. A
   missing or mistyped DOCUMENT_KEK is the degraded path the administration
   screen explains (document-health.ts); it must not take the session with it. */
describe("documentRetentionDays", () => {
  it("reads the window without the document key", () => {
    expect(documentRetentionDays({ DOCUMENT_RETENTION_DAYS: "90" })).toBe(90);
  });

  it("defaults to 30 days as the full config does", () => {
    expect(documentRetentionDays({})).toBe(30);
  });

  it("is null for a value the full config would refuse, rather than throwing", () => {
    expect(documentRetentionDays({ DOCUMENT_RETENTION_DAYS: "0" })).toBeNull();
    expect(documentRetentionDays({ DOCUMENT_RETENTION_DAYS: "nine" })).toBeNull();
  });

  it("is what the session route reads, not the whole document config", () => {
    const route = readFileSync(new URL("../../../web/src/routes/api/auth/session/+server.js", import.meta.url), "utf8");
    expect(route).not.toMatch(/getDocumentConfig/);
    expect(route).toMatch(/documentRetentionDays\(\)/);
  });
});


/*
 * #1405: no usable key puts Orbit into maintenance. The first four of the five
 * faults are found from the key settings alone (the fifth, a key that is not
 * the database's, needs the database and is src/server/key-state.ts's).
 * `documentKeyProblem` answers the reason token, or null when the settings
 * hold a key; it reads only the key inputs, so an unrelated bad setting never
 * counts as a key fault, and it never throws and never returns key material.
 */
describe("documentKeyProblem (#1405)", () => {
  const withSecretFile = (content: string | null) => {
    const directory = mkdtempSync(join(tmpdir(), "orbit-kek-"));
    const path = join(directory, "document-kek");
    if (content !== null) writeFileSync(path, content);
    return { path, remove: () => rmSync(directory, { recursive: true, force: true }) };
  };

  it("finds no fault in a well-formed key, direct or from a file", () => {
    expect(documentKeyProblem({ NODE_ENV: "test", DOCUMENT_KEK: key })).toBeNull();
    const file = withSecretFile(`${key}\n`);
    try {
      expect(documentKeyProblem({ NODE_ENV: "test", DOCUMENT_KEK_FILE: file.path })).toBeNull();
    } finally {
      file.remove();
    }
  });

  it("reports a key that was never set as missing", () => {
    expect(documentKeyProblem({ NODE_ENV: "test" })).toBe("missing");
    expect(documentKeyProblem({ NODE_ENV: "test", DOCUMENT_KEK: "" })).toBe("missing");
  });

  it("reports an empty key file as missing", () => {
    const file = withSecretFile("");
    try {
      expect(documentKeyProblem({ NODE_ENV: "test", DOCUMENT_KEK_FILE: file.path })).toBe("missing");
    } finally {
      file.remove();
    }
  });

  it("reports a key file that cannot be read as unreadable", () => {
    const file = withSecretFile(null);
    try {
      expect(documentKeyProblem({ NODE_ENV: "test", DOCUMENT_KEK_FILE: file.path })).toBe("unreadable");
    } finally {
      file.remove();
    }
  });

  it.each([
    ["too short", { DOCUMENT_KEK: "short" }],
    ["not hexadecimal", { DOCUMENT_KEK: "zz".repeat(32) }],
    ["a malformed next key", { DOCUMENT_KEK: key, DOCUMENT_KEK_NEXT: "short" }],
    ["a next key equal to the current key", { DOCUMENT_KEK: key, DOCUMENT_KEK_NEXT: key }],
  ])("reports %s as malformed", (_label, changes) => {
    expect(documentKeyProblem({ NODE_ENV: "test", ...changes })).toBe("malformed");
  });

  it("reports a key set both directly and by file as both_forms", () => {
    const file = withSecretFile(key);
    try {
      expect(documentKeyProblem({ NODE_ENV: "test", DOCUMENT_KEK: key, DOCUMENT_KEK_FILE: file.path })).toBe("both_forms");
    } finally {
      file.remove();
    }
  });

  it("does not count an unrelated bad document setting as a key fault", () => {
    expect(documentKeyProblem({ NODE_ENV: "test", DOCUMENT_KEK: key, DOCUMENTS_ROOT: "/same", DOCUMENTS_QUARANTINE_ROOT: "/same" })).toBeNull();
  });

  it("never carries the key in what it returns", () => {
    const answers = [
      documentKeyProblem({ NODE_ENV: "test", DOCUMENT_KEK: key }),
      documentKeyProblem({ NODE_ENV: "test", DOCUMENT_KEK: key, DOCUMENT_KEK_NEXT: key }),
      documentKeyProblem({ NODE_ENV: "test", DOCUMENT_KEK: `${key}00` }),
    ];
    expect(JSON.stringify(answers)).not.toContain(key);
  });
});
