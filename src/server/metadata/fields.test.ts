import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { MetadataKeyLockedError } from "@/server/metadata/keys";
import { MetadataCipher } from "@/server/metadata/fields";

const rowId = "55555555-5555-4555-8555-555555555555";
const householdId = "66666666-6666-4666-8666-666666666666";

function cipher(): MetadataCipher {
  return new MetadataCipher({ scope: "household", householdId, keyId: "key-one", dataKey: randomBytes(32) });
}

describe("the Tier 1 dual read (ADR-0024 decision 3)", () => {
  it("reads the plaintext column while a row is still waiting for the backfill", () => {
    expect(cipher().text("items.notes", rowId, { encrypted: null, plaintext: "still plain" }))
      .toEqual({ value: "still plain" });
  });

  it("reads the ciphertext once a row has been converted", () => {
    const metadata = cipher();
    const encrypted = metadata.encryptText("items.notes", rowId, "the note");
    expect(encrypted).not.toBeNull();
    expect(encrypted).not.toContain("the note");
    // The write clears the plaintext in the same statement, which is why the
    // fallback below is null rather than a stale copy of the old value.
    expect(metadata.text("items.notes", rowId, { encrypted, plaintext: null })).toEqual({ value: "the note" });
  });

  it("stores nothing for an absent or empty value", () => {
    const metadata = cipher();
    expect(metadata.encryptText("items.notes", rowId, null)).toBeNull();
    expect(metadata.encryptText("items.notes", rowId, "")).toBeNull();
    expect(metadata.referenceIndex(null)).toBeNull();
  });

  it("round-trips a JSONB column as one envelope", () => {
    const metadata = cipher();
    const proposal = { title: "Broadband", reference: "AB-123" };
    const encrypted = metadata.encryptJson("imap_ingestion_messages.proposal", rowId, proposal);
    expect(encrypted).not.toContain("Broadband");
    expect(metadata.json("imap_ingestion_messages.proposal", rowId, { encrypted, plaintext: {} }))
      .toEqual({ value: proposal });
  });
});

describe("a damaged Tier 1 value (ADR-0024 decision 5)", () => {
  it("is refused as metadata_integrity_failed rather than shown empty or fabricated", () => {
    const metadata = cipher();
    const damaged = metadata.encryptText("items.notes", rowId, "the note")!.slice(0, -4) + "AAAA";
    const result = metadata.text("items.notes", rowId, { encrypted: damaged, plaintext: null });
    expect(result.state).toBe("metadata_integrity_failed");
    expect(result.value).toBeNull();
  });

  it("leaves the rest of the row usable: only the damaged field is refused", () => {
    const metadata = cipher();
    const notes = metadata.encryptText("items.notes", rowId, "the note")!;
    const reference = metadata.encryptText("items.reference", rowId, "AB-123")!;
    const damagedReference = reference.slice(0, -4) + "AAAA";

    expect(metadata.text("items.reference", rowId, { encrypted: damagedReference, plaintext: null }))
      .toEqual({ value: null, state: "metadata_integrity_failed" });
    expect(metadata.text("items.notes", rowId, { encrypted: notes, plaintext: null }))
      .toEqual({ value: "the note" });
  });

  it("refuses a value moved to another row, which is what the row binding is for", () => {
    const metadata = cipher();
    const notes = metadata.encryptText("items.notes", rowId, "the note")!;
    const otherRow = "77777777-7777-4777-8777-777777777777";
    expect(metadata.text("items.notes", otherRow, { encrypted: notes, plaintext: null }).state)
      .toBe("metadata_integrity_failed");
  });

  it("refuses a damaged JSONB value as an empty object plus the marker, never a partial draft", () => {
    const metadata = cipher();
    const encrypted = metadata.encryptJson("imap_ingestion_messages.proposal", rowId, { title: "Broadband" });
    const damaged = encrypted.slice(0, -4) + "AAAA";
    expect(metadata.json("imap_ingestion_messages.proposal", rowId, { encrypted: damaged, plaintext: {} }))
      .toEqual({ value: {}, state: "metadata_integrity_failed" });
  });

  it("can be repaired by writing over it", () => {
    const metadata = cipher();
    const repaired = metadata.encryptText("items.notes", rowId, "a fresh note")!;
    expect(metadata.text("items.notes", rowId, { encrypted: repaired, plaintext: null }))
      .toEqual({ value: "a fresh note" });
  });
});

describe("a locked instance (ADR-0024 decision 5)", () => {
  const locked = new MetadataCipher(undefined);

  it("reads encrypted fields as locked, not as damaged", () => {
    expect(locked.text("items.notes", rowId, { encrypted: "mdv1.a.b.c", plaintext: null }))
      .toEqual({ value: null, state: "metadata_locked" });
    expect(locked.json("imap_ingestion_messages.proposal", rowId, { encrypted: "mdv1.a.b.c", plaintext: {} }))
      .toEqual({ value: {}, state: "metadata_locked" });
  });

  it("still reads rows the backfill has not reached, so the application stays usable", () => {
    expect(locked.text("items.notes", rowId, { encrypted: null, plaintext: "still plain" }))
      .toEqual({ value: "still plain" });
  });

  it("refuses every write rather than storing something it cannot protect", () => {
    expect(() => locked.encryptText("items.notes", rowId, "the note")).toThrow(MetadataKeyLockedError);
    expect(() => locked.encryptJson("imap_ingestion_messages.proposal", rowId, {})).toThrow(MetadataKeyLockedError);
    expect(() => locked.referenceIndex("AB-123")).toThrow(MetadataKeyLockedError);
  });
});

describe("the Tier 2 numeric column (#963)", () => {
  it("round-trips a cost through the same envelope every other value uses", () => {
    const metadata = cipher();
    const encrypted = metadata.encryptNumber("items.cost_minor", rowId, 58_200);
    expect(encrypted?.startsWith("mdv1.")).toBe(true);
    // The figure itself must not survive in the stored bytes: a database file
    // carrying "58200" in the clear would defeat the point of the tier.
    expect(encrypted).not.toContain("58200");
    expect(metadata.number("items.cost_minor", rowId, { encrypted, plaintext: null }))
      .toEqual({ value: 58_200 });
  });

  it("keeps zero, which is a real cost, distinct from an absent one", () => {
    const metadata = cipher();
    const zero = metadata.encryptNumber("items.cost_minor", rowId, 0);
    expect(zero).not.toBeNull();
    expect(metadata.number("items.cost_minor", rowId, { encrypted: zero, plaintext: null }))
      .toEqual({ value: 0 });
    expect(metadata.encryptNumber("items.cost_minor", rowId, null)).toBeNull();
    expect(metadata.encryptNumber("items.cost_minor", rowId, undefined)).toBeNull();
  });

  it("reads the plaintext column while a row is still waiting for the backfill", () => {
    expect(cipher().number("items.cost_minor", rowId, { encrypted: null, plaintext: 4_200 }))
      .toEqual({ value: 4_200 });
  });

  it("reports a damaged cost rather than coercing it to zero or NaN", () => {
    const metadata = cipher();
    const damaged = metadata.encryptNumber("items.cost_minor", rowId, 999)!.slice(0, -4) + "AAAA";
    expect(metadata.number("items.cost_minor", rowId, { encrypted: damaged, plaintext: null }))
      .toEqual({ value: null, state: "metadata_integrity_failed" });
  });

  it("reports authenticated bytes that are not a whole non-negative number as damage", () => {
    const metadata = cipher();
    // Authenticated, so it decrypts cleanly; it is simply not a cost. Only a
    // bug in a writer can produce this, and a money field must not guess.
    const notANumber = metadata.encryptText("items.cost_minor", rowId, "-12.5")!;
    expect(metadata.number("items.cost_minor", rowId, { encrypted: notANumber, plaintext: null }))
      .toEqual({ value: null, state: "metadata_integrity_failed" });
  });

  it("refuses to encrypt a value that is not a whole non-negative number", () => {
    const metadata = cipher();
    expect(() => metadata.encryptNumber("items.cost_minor", rowId, -1)).toThrow();
    expect(() => metadata.encryptNumber("items.cost_minor", rowId, 12.5)).toThrow();
  });

  it("locks the numeric column exactly as it locks the text ones", () => {
    const locked = new MetadataCipher(undefined);
    expect(locked.number("items.cost_minor", rowId, { encrypted: "mdv1.a.b.c", plaintext: null }))
      .toEqual({ value: null, state: "metadata_locked" });
    expect(() => locked.encryptNumber("items.cost_minor", rowId, 1)).toThrow(MetadataKeyLockedError);
  });
});

describe("Tier 2 blind indexes (ADR-0024 decision 2, #963)", () => {
  it("indexes the invitation address, because a database rule depends on it", () => {
    const metadata = cipher();
    const digest = metadata.blindIndex("household_invitations.email", "Person@Example.COM ");
    expect(digest).toBeTruthy();
    expect(digest).not.toContain("example");
    // Normalisation is the shared canonical form, so the same address in a
    // different case is the same open invitation.
    expect(metadata.blindIndex("household_invitations.email", "person@example.com")).toBe(digest);
    expect(metadata.blindIndex("household_invitations.email", null)).toBeNull();
  });

  it("gives a column its own index key, so two columns never correlate", () => {
    const metadata = cipher();
    expect(metadata.blindIndex("household_invitations.email", "same-value"))
      .not.toBe(metadata.blindIndex("items.reference", "same-value"));
  });

  it("binds a value to its own row, so ciphertext cannot be replayed into another", () => {
    const metadata = cipher();
    const otherRow = "77777777-7777-4777-8777-777777777777";
    const encrypted = metadata.encryptText("items.title", rowId, "Car insurance");
    expect(metadata.text("items.title", otherRow, { encrypted, plaintext: null }))
      .toEqual({ value: null, state: "metadata_integrity_failed" });
    // Nor into another column of the same row.
    expect(metadata.text("items.provider", rowId, { encrypted, plaintext: null }))
      .toEqual({ value: null, state: "metadata_integrity_failed" });
  });
});
