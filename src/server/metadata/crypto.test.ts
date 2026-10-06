import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  blindIndexEquals,
  computeBlindIndex,
  createWrappedMetadataKey,
  decryptMetadataValue,
  deriveBlindIndexKey,
  encryptMetadataValue,
  isMetadataEnvelope,
  METADATA_ENVELOPE_PREFIX,
  MetadataIntegrityError,
  normalizeComparableMetadata,
  rewrapMetadataKey,
  unwrapMetadataKey,
  type MetadataKeyContext,
} from "@/server/metadata/crypto";

const kek = Buffer.alloc(32, 7);
const householdKeyContext: MetadataKeyContext = {
  scope: "household",
  householdId: "11111111-1111-4111-8111-111111111111",
  keyId: "key-one",
};

describe("Tier 1 metadata key wrapping (ADR-0024 decision 1)", () => {
  it("round-trips a household DEK under the instance KEK", () => {
    const minted = createWrappedMetadataKey(kek, householdKeyContext);
    expect(minted.dataKey).toHaveLength(32);
    expect(unwrapMetadataKey(minted.wrapped, kek, householdKeyContext)).toEqual(minted.dataKey);
  });

  it.each([
    ["another household", { ...householdKeyContext, householdId: "22222222-2222-4222-8222-222222222222" }],
    ["the instance scope", { ...householdKeyContext, scope: "instance" as const, householdId: null }],
    ["another key id", { ...householdKeyContext, keyId: "key-two" }],
  ])("refuses a DEK re-pointed at %s", (_label, context) => {
    const minted = createWrappedMetadataKey(kek, householdKeyContext);
    expect(() => unwrapMetadataKey(minted.wrapped, kek, context)).toThrow();
  });

  it("refuses a DEK under a different KEK", () => {
    const minted = createWrappedMetadataKey(kek, householdKeyContext);
    expect(() => unwrapMetadataKey(minted.wrapped, Buffer.alloc(32, 9), householdKeyContext)).toThrow();
  });

  it("rewraps under a new KEK without changing the DEK, so every value and index stays valid", () => {
    const minted = createWrappedMetadataKey(kek, householdKeyContext);
    const nextKek = Buffer.alloc(32, 3);
    const rewrapped = rewrapMetadataKey(minted.wrapped, kek, nextKek, householdKeyContext, "key-two");
    const recovered = unwrapMetadataKey(rewrapped, nextKek, { ...householdKeyContext, keyId: "key-two" });
    expect(recovered).toEqual(minted.dataKey);
  });
});

describe("Tier 1 metadata value envelopes (ADR-0024 decision 3)", () => {
  const dataKey = randomBytes(32);
  const rowId = "33333333-3333-4333-8333-333333333333";

  it("produces a compact mdv1 envelope and round-trips it", () => {
    const stored = encryptMetadataValue("Policy AB-123", dataKey, { column: "items.reference", rowId });
    expect(stored.split(".")).toHaveLength(4);
    expect(stored.startsWith(`${METADATA_ENVELOPE_PREFIX}.`)).toBe(true);
    expect(isMetadataEnvelope(stored)).toBe(true);
    expect(stored).not.toContain("Policy AB-123");
    expect(decryptMetadataValue(stored, dataKey, { column: "items.reference", rowId })).toBe("Policy AB-123");
  });

  it("refuses a value replayed into another row", () => {
    const stored = encryptMetadataValue("Policy AB-123", dataKey, { column: "items.reference", rowId });
    const otherRow = "44444444-4444-4444-8444-444444444444";
    expect(() => decryptMetadataValue(stored, dataKey, { column: "items.reference", rowId: otherRow }))
      .toThrow(MetadataIntegrityError);
  });

  it("refuses a value replayed into another column of the same row", () => {
    const stored = encryptMetadataValue("Policy AB-123", dataKey, { column: "items.reference", rowId });
    expect(() => decryptMetadataValue(stored, dataKey, { column: "items.notes", rowId }))
      .toThrow(MetadataIntegrityError);
  });

  it("refuses a tampered ciphertext, a tampered tag and a malformed envelope", () => {
    const stored = encryptMetadataValue("Policy AB-123", dataKey, { column: "items.reference", rowId });
    const segments = stored.split(".");
    const flip = (value: string) => (value[0] === "A" ? `B${value.slice(1)}` : `A${value.slice(1)}`);
    const context = { column: "items.reference" as const, rowId };
    expect(() => decryptMetadataValue([segments[0], segments[1], segments[2], flip(segments[3])].join("."), dataKey, context))
      .toThrow(MetadataIntegrityError);
    expect(() => decryptMetadataValue([segments[0], segments[1], flip(segments[2]), segments[3]].join("."), dataKey, context))
      .toThrow(MetadataIntegrityError);
    expect(() => decryptMetadataValue("not-an-envelope", dataKey, context)).toThrow(MetadataIntegrityError);
    expect(() => decryptMetadataValue("mdv2.a.b.c", dataKey, context)).toThrow(MetadataIntegrityError);
  });

  it("names the column and row on the integrity error, and never the value", () => {
    const stored = encryptMetadataValue("Policy AB-123", dataKey, { column: "items.reference", rowId });
    try {
      decryptMetadataValue(stored, randomBytes(32), { column: "items.reference", rowId });
      expect.unreachable("a wrong key must not decrypt");
    } catch (error) {
      expect(error).toBeInstanceOf(MetadataIntegrityError);
      expect((error as MetadataIntegrityError).column).toBe("items.reference");
      expect((error as MetadataIntegrityError).rowId).toBe(rowId);
      expect((error as MetadataIntegrityError).message).not.toContain("AB-123");
    }
  });

  it("gives independent envelopes to notes and reference, so updating one never rewrites the other", () => {
    const reference = encryptMetadataValue("same", dataKey, { column: "items.reference", rowId });
    const notes = encryptMetadataValue("same", dataKey, { column: "items.notes", rowId });
    expect(reference).not.toEqual(notes);
  });
});

describe("the one canonical comparison form (ADR-0024 decision 2)", () => {
  it("applies NFKC, whitespace collapse, trim and lowercasing", () => {
    expect(normalizeComparableMetadata("  AB-123  ")).toBe("ab-123");
    expect(normalizeComparableMetadata("AB   123")).toBe("ab 123");
    expect(normalizeComparableMetadata("ｒｅｆ-1")).toBe("ref-1");
  });

  it("replaces control characters with spaces without touching ordinary ones", () => {
    expect(normalizeComparableMetadata("AB\u0000\u001f\u007f123")).toBe("ab 123");
    expect(normalizeComparableMetadata("AB\u2028\u2029123")).toBe("ab 123");
    // The trap a hand-written range falls into: everything from space to
    // backslash is ordinary text and must survive intact.
    expect(normalizeComparableMetadata("a b!\"#$%&'()*+,-./0:;<=>?@Z[\\]")).toBe("a b!\"#$%&'()*+,-./0:;<=>?@z[\\]");
  });

  it("keeps punctuation, so references that differ today keep differing", () => {
    expect(normalizeComparableMetadata("AB-123")).not.toBe(normalizeComparableMetadata("AB123"));
  });

  it("treats nothing-at-all as absent rather than as an empty match", () => {
    expect(normalizeComparableMetadata("")).toBeUndefined();
    expect(normalizeComparableMetadata("   ")).toBeUndefined();
    expect(normalizeComparableMetadata(null)).toBeUndefined();
    expect(normalizeComparableMetadata(42)).toBeUndefined();
  });
});

describe("the blind index (ADR-0024 decision 2)", () => {
  const dataKey = randomBytes(32);

  it("matches equal normalised references and nothing else", () => {
    const digest = computeBlindIndex(" AB-123 ", dataKey, "items.reference");
    expect(computeBlindIndex("ab-123", dataKey, "items.reference")).toBe(digest);
    expect(computeBlindIndex("AB-124", dataKey, "items.reference")).not.toBe(digest);
  });

  it("produces unrelated digests in different households, so nothing correlates across them", () => {
    const otherHouseholdKey = randomBytes(32);
    expect(computeBlindIndex("AB-123", otherHouseholdKey, "items.reference"))
      .not.toBe(computeBlindIndex("AB-123", dataKey, "items.reference"));
  });

  it("derives the index key from the DEK rather than storing it, and never returns the DEK", () => {
    const indexKey = deriveBlindIndexKey(dataKey, "items.reference");
    expect(indexKey).toHaveLength(32);
    expect(indexKey).not.toEqual(dataKey);
    expect(deriveBlindIndexKey(dataKey, "items.reference")).toEqual(indexKey);
    expect(deriveBlindIndexKey(dataKey, "items.notes")).not.toEqual(indexKey);
  });

  it("has no digest for an absent reference, so empty references never collide", () => {
    expect(computeBlindIndex(null, dataKey, "items.reference")).toBeUndefined();
    expect(computeBlindIndex("   ", dataKey, "items.reference")).toBeUndefined();
  });

  it("compares digests without leaking a mismatch through absence", () => {
    const digest = computeBlindIndex("AB-123", dataKey, "items.reference")!;
    expect(blindIndexEquals(digest, digest)).toBe(true);
    expect(blindIndexEquals(digest, computeBlindIndex("AB-124", dataKey, "items.reference"))).toBe(false);
    expect(blindIndexEquals(digest, null)).toBe(false);
    expect(blindIndexEquals(null, null)).toBe(false);
  });
});
