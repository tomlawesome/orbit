import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import { metadataKeys } from "@/db/schema";
import { heldToRotate, requireCurrentKey, type RotationKeys } from "./rewrap-worker";

// The held-row filter and the current-key check are only reached from queries
// a database runs; these cover them by behaviour (#1536).

const keys: RotationKeys = {
  currentKek: Buffer.alloc(32, 1),
  currentKeyId: "a".repeat(16),
  nextKek: Buffer.alloc(32, 2),
  nextKeyId: "b".repeat(16),
};

describe("requireCurrentKey", () => {
  it("accepts a row wrapped under the current key", () => {
    expect(() => requireCurrentKey("metadata_keys", keys.currentKeyId, keys)).not.toThrow();
  });

  it.each([
    ["the next key", keys.nextKeyId],
    ["an older key", "c".repeat(16)],
  ])("fails closed for a row wrapped under %s", (_label, keyId) => {
    expect(() => requireCurrentKey("metadata_keys", keyId, keys)).toThrow(
      "metadata_keys row is wrapped under neither the current nor the next key",
    );
  });
});

describe("heldToRotate", () => {
  it("excludes rows already on the next key and rows skipped on an older key", () => {
    const condition = heldToRotate(metadataKeys.keyId, keys);
    expect(condition).toBeDefined();
    const { sql: text, params } = new PgDialect().sqlToQuery(condition!);
    expect(params).toContain(keys.nextKeyId);
    expect(params).toContain(keys.currentKeyId);
    expect(text).toMatch(/<>.*\bnot\b.*<>.*<>.*~/s);
  });
});
