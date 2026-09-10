import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { and, eq, isNotNull, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { imapIngestionMessages, items, metadataDamageSightings, metadataKeys } from "@/db/schema";
import { readWorkspace, applyWorkspaceCommand } from "@/server/workspace-repository";
import { assignImapReceiptHousehold } from "@/server/mail-in/imap-inbox";
import { encryptPortableArchive } from "@/server/portable-archive";
import { importPortableArchive, previewPortableImport } from "@/server/portable-archive-repository";
import { runMetadataBackfillBatch } from "@/server/metadata/backfill";
import { openMetadataReader } from "@/server/metadata/tier1";
import { resetMetadataKeyCacheForTests } from "@/server/metadata/keys";
import { resetDocumentConfigForTests } from "@/server/documents/config";
import { getDocumentHealth } from "@/server/document-health";
import {
  flushMetadataDamageSightings,
  resetMetadataDamageSightingsForTests,
} from "@/server/metadata/damage-sightings";
import { cleanupIntegrationEnvironment, createIntegrationFixture } from "./support/fixtures";

const passphrase = "correct-horse-battery-staple";

/**
 * The instance with no usable key-encryption key: `getDocumentConfig()` throws
 * for want of `DOCUMENT_KEK`, which is exactly the state a restart with the
 * secret unmounted produces. Both caches have to go with it, or the process
 * would keep answering from key material the instance no longer holds.
 */
function lockTheInstance(): () => void {
  const kek = process.env.DOCUMENT_KEK;
  delete process.env.DOCUMENT_KEK;
  resetDocumentConfigForTests();
  resetMetadataKeyCacheForTests();
  return () => {
    process.env.DOCUMENT_KEK = kek;
    resetDocumentConfigForTests();
    resetMetadataKeyCacheForTests();
  };
}

afterAll(async () => {
  await cleanupIntegrationEnvironment();
});

async function writeItem(input: {
  userId: string;
  householdId: string;
  sectionId: string;
  title: string;
  reference?: string;
  notes?: string;
  /** Omitted for a new item; given to write over one that already exists. */
  id?: string;
}): Promise<string> {
  const itemId = input.id ?? randomUUID();
  await applyWorkspaceCommand(input.userId, "metadata-tier1-test", {
    type: "item.upsert",
    householdId: input.householdId,
    item: {
      id: itemId,
      sectionId: input.sectionId,
      title: input.title,
      currency: "GBP",
      status: "active",
      reference: input.reference,
      notes: input.notes,
    },
  });
  return itemId;
}

/**
 * The violated constraint, read off the driver error rather than the message.
 * Drizzle wraps a failed statement in an error whose own message is only
 * "Failed query: ...", so matching on that text would assert nothing about
 * which rule fired; postgres.js records the name on the error it wrapped.
 */
function violatedConstraint(error: unknown): string | undefined {
  for (let current = error; current; current = (current as { cause?: unknown }).cause) {
    const name = (current as { constraint_name?: string }).constraint_name;
    if (name) return name;
  }
  return undefined;
}

/** `readWorkspace` needs the caller's session; the fixture mints one on demand. */
async function workspaceFor(fixture: Awaited<ReturnType<typeof createIntegrationFixture>>) {
  const session = await fixture.session("member");
  return readWorkspace(fixture.users.member.id, session.sessionId);
}

function archiveWith(items: Array<{ sectionId: string; title: string; reference?: string; notes?: string }>) {
  return encryptPortableArchive(Buffer.from(JSON.stringify({
    format: "orbit-portable-archive",
    version: 1,
    exportedAt: new Date().toISOString(),
    household: { name: "Imported household" },
    sections: items.map((item, index) => ({
      id: item.sectionId,
      slug: `imported-${item.sectionId.slice(0, 8)}-${index}`,
      name: "Imported section",
      icon: "home",
      accent: "blue",
      position: index,
      visible: true,
    })),
    items: items.map((item) => ({
      id: randomUUID(),
      sectionId: item.sectionId,
      title: item.title,
      currency: "GBP",
      status: "active",
      reference: item.reference,
      notes: item.notes,
    })),
    dueEvents: [],
    reminderRules: [],
    documents: [],
  })), passphrase);
}

describe("Tier 1 metadata is written and read encrypted (ADR-0024)", () => {
  it("stores notes and reference as mdv1 envelopes with no plaintext left in the row, and reads them back", async () => {
    const fixture = await createIntegrationFixture("tier1-round-trip");
    const [section] = await getDb().select({ id: items.sectionId }).from(items).where(eq(items.id, fixture.item.id));
    const itemId = await writeItem({
      userId: fixture.users.member.id,
      householdId: fixture.household.id,
      sectionId: section.id,
      title: "Encrypted item",
      reference: "AB-123",
      notes: "Renewal quoted at 42 pounds",
    });

    const [stored] = await getDb().select().from(items).where(eq(items.id, itemId));
    // The whole point of the tier: a database file leaked from this instance
    // carries neither value in readable form.
    expect(stored.reference).toBeNull();
    expect(stored.notes).toBeNull();
    expect(stored.referenceEnc?.startsWith("mdv1.")).toBe(true);
    expect(stored.notesEnc?.startsWith("mdv1.")).toBe(true);
    expect(stored.referenceEnc).not.toContain("AB-123");
    expect(stored.notesEnc).not.toContain("Renewal");
    expect(stored.referenceIndex).toBeTruthy();
    // The index is a digest, not the value.
    expect(stored.referenceIndex).not.toContain("AB-123");

    // Exactly one household DEK, minted on first use and wrapped under the KEK.
    const keys = await getDb().select().from(metadataKeys).where(eq(metadataKeys.householdId, fixture.household.id));
    expect(keys).toHaveLength(1);
    expect(keys[0].scope).toBe("household");
    expect(keys[0].wrappedDek).toBeTruthy();

    const workspace = await workspaceFor(fixture);
    const household = workspace.households.find((candidate) => candidate.id === fixture.household.id)!;
    const read = household.items.find((candidate) => candidate.id === itemId)!;
    expect(read.reference).toBe("AB-123");
    expect(read.notes).toBe("Renewal quoted at 42 pounds");
    expect(read.metadataStatus).toBeUndefined();
  });

  it("keeps one household's values unreadable with another household's key", async () => {
    const fixture = await createIntegrationFixture("tier1-household-isolation");
    const [section] = await getDb().select({ id: items.sectionId }).from(items).where(eq(items.id, fixture.item.id));
    const itemId = await writeItem({
      userId: fixture.users.member.id,
      householdId: fixture.household.id,
      sectionId: section.id,
      title: "Isolated item",
      reference: "ISO-1",
    });
    const [stored] = await getDb().select({ referenceEnc: items.referenceEnc }).from(items).where(eq(items.id, itemId));

    const otherHousehold = await openMetadataReader(fixture.secondHousehold.id);
    // A key had to be minted for the other household for this to mean
    // anything; writing an item there is what mints it.
    const [otherSection] = await getDb().select({ id: items.sectionId }).from(items).where(eq(items.id, fixture.secondItem.id));
    await writeItem({
      userId: fixture.users.secondOwner.id,
      householdId: fixture.secondHousehold.id,
      sectionId: otherSection.id,
      title: "Other household item",
      reference: "ISO-1",
    });
    const otherReader = await openMetadataReader(fixture.secondHousehold.id);
    expect(otherHousehold).toBeDefined();
    expect(otherReader.text("items.reference", itemId, { encrypted: stored.referenceEnc, plaintext: null }).state)
      .toBe("metadata_integrity_failed");

    // The same reference in two households produces unrelated digests, so
    // nothing correlates across the boundary.
    const [first] = await getDb().select({ referenceIndex: items.referenceIndex }).from(items).where(eq(items.id, itemId));
    const second = await getDb().select({ referenceIndex: items.referenceIndex }).from(items)
      .where(and(eq(items.householdId, fixture.secondHousehold.id), eq(items.title, "Other household item")));
    expect(second[0].referenceIndex).not.toBe(first.referenceIndex);
  });
});

describe("duplicate detection uses the blind index (ADR-0024 decision 2)", () => {
  it("still finds a duplicate reference after encryption, and cannot find it without the index", async () => {
    const fixture = await createIntegrationFixture("tier1-duplicate-detection");
    const [section] = await getDb().select({ id: items.sectionId }).from(items).where(eq(items.id, fixture.item.id));
    await writeItem({
      userId: fixture.users.member.id,
      householdId: fixture.household.id,
      sectionId: section.id,
      title: "Home insurance",
      reference: "HI-9284712",
    });

    // No plaintext reference survives anywhere in this household, so the
    // lookup below has nothing but the index to match on.
    expect(await getDb().select({ id: items.id }).from(items)
      .where(and(eq(items.householdId, fixture.household.id), isNotNull(items.reference))))
      .toHaveLength(0);

    // A differently-titled item carrying the same reference: only the
    // reference can flag it, so this is the index and nothing else.
    const archive = archiveWith([{ sectionId: randomUUID(), title: "Buildings cover", reference: "hi-9284712" }]);
    const preview = await previewPortableImport(fixture.users.member.id, fixture.household.id, archive, passphrase);
    expect(preview.conflicts).toHaveLength(1);
    expect(preview.conflicts[0].title).toBe("Buildings cover");

    // Importing it without resolving that conflict is refused, exactly as it
    // was when the comparison ran on plaintext.
    await expect(importPortableArchive({
      userId: fixture.users.member.id,
      householdId: fixture.household.id,
      archive,
      passphrase,
      conflictItemIds: [],
    })).rejects.toMatchObject({ code: "archive_conflict_unresolved", status: 409 });

    // Removing the index is what this test is guarding: with the digests
    // cleared there is no plaintext to fall back on, and the duplicate goes
    // unseen. This is the failure the index prevents.
    await getDb().update(items).set({ referenceIndex: null }).where(eq(items.householdId, fixture.household.id));
    const blind = await previewPortableImport(fixture.users.member.id, fixture.household.id, archive, passphrase);
    expect(blind.conflicts).toHaveLength(0);
  });

  it("does not flag a reference that only looks similar", async () => {
    const fixture = await createIntegrationFixture("tier1-duplicate-negative");
    const [section] = await getDb().select({ id: items.sectionId }).from(items).where(eq(items.id, fixture.item.id));
    await writeItem({
      userId: fixture.users.member.id,
      householdId: fixture.household.id,
      sectionId: section.id,
      title: "Home insurance",
      reference: "AB-123",
    });
    const archive = archiveWith([{ sectionId: randomUUID(), title: "Something else", reference: "AB123" }]);
    const preview = await previewPortableImport(fixture.users.member.id, fixture.household.id, archive, passphrase);
    expect(preview.conflicts).toHaveLength(0);
  });
});

describe("attribution moves a receipt's draft between keys (ADR-0024 decision 1)", () => {
  it("re-encrypts an unattributed draft under the household DEK in the same statement", async () => {
    const fixture = await createIntegrationFixture("tier1-attribution-rekey");
    const receiptId = randomUUID();
    await getDb().insert(imapIngestionMessages).values({
      id: receiptId,
      mailbox: "INBOX",
      mailboxUidValidity: "1",
      mailboxUid: 5_150,
      contentSha256: "1".repeat(64),
      recipientAliasSha256: "2".repeat(64),
      userId: fixture.users.member.id,
      householdId: null,
      status: "pending_review",
      expiresAt: new Date(Date.now() + 86_400_000),
      proposal: { title: "Unattributed draft", reference: "UA-1" },
      fieldEvidence: { title: { source: "subject", confidence: "high" } },
    });

    // The backfill encrypts it under the instance key, which is the only key
    // a receipt with no household can use.
    await runMetadataBackfillBatch(100);
    const [encrypted] = await getDb().select({ proposalEnc: imapIngestionMessages.proposalEnc })
      .from(imapIngestionMessages).where(eq(imapIngestionMessages.id, receiptId));
    expect(encrypted.proposalEnc?.startsWith("mdv1.")).toBe(true);

    await assignImapReceiptHousehold(fixture.users.member.id, receiptId, fixture.household.id);

    const [moved] = await getDb().select().from(imapIngestionMessages).where(eq(imapIngestionMessages.id, receiptId));
    expect(moved.householdId).toBe(fixture.household.id);
    // A fresh envelope under a different key: the ciphertext must have
    // changed, or the value would be unreadable now the household has.
    expect(moved.proposalEnc).not.toBe(encrypted.proposalEnc);

    const householdReader = await openMetadataReader(fixture.household.id);
    expect(householdReader.json("imap_ingestion_messages.proposal", receiptId, { encrypted: moved.proposalEnc, plaintext: {} }))
      .toEqual({ value: { title: "Unattributed draft", reference: "UA-1" } });

    // And the instance key can no longer read it, which is the isolation the
    // move exists to establish.
    const instanceReader = await openMetadataReader(null);
    expect(instanceReader.json("imap_ingestion_messages.proposal", receiptId, { encrypted: moved.proposalEnc, plaintext: {} }).state)
      .toBe("metadata_integrity_failed");

    await getDb().delete(metadataKeys).where(eq(metadataKeys.scope, "instance"));
  });
});

describe("a corrupt ciphertext (ADR-0024 decision 5)", () => {
  it("yields metadata_integrity_failed and leaves the rest of the row usable", async () => {
    const fixture = await createIntegrationFixture("tier1-corrupt-ciphertext");
    const [section] = await getDb().select({ id: items.sectionId }).from(items).where(eq(items.id, fixture.item.id));
    const itemId = await writeItem({
      userId: fixture.users.member.id,
      householdId: fixture.household.id,
      sectionId: section.id,
      title: "Damaged item",
      reference: "AB-123",
      notes: "This note survives",
    });

    const [stored] = await getDb().select({ referenceEnc: items.referenceEnc }).from(items).where(eq(items.id, itemId));
    await getDb().update(items)
      .set({ referenceEnc: `${stored.referenceEnc!.slice(0, -4)}AAAA` })
      .where(eq(items.id, itemId));

    const workspace = await workspaceFor(fixture);
    const household = workspace.households.find((candidate) => candidate.id === fixture.household.id)!;
    const damaged = household.items.find((candidate) => candidate.id === itemId)!;

    expect(damaged.metadataStatus?.reference).toBe("metadata_integrity_failed");
    // Never an empty string, never a fabricated value.
    expect(damaged.reference).toBeUndefined();
    // The rest of the row renders normally: the structural fields and the
    // undamaged Tier 1 field beside it.
    expect(damaged.title).toBe("Damaged item");
    expect(damaged.status).toBe("active");
    expect(damaged.notes).toBe("This note survives");
    expect(damaged.metadataStatus?.notes).toBeUndefined();
    // Every other item in the household is unaffected.
    expect(household.items.filter((candidate) => candidate.metadataStatus)).toHaveLength(1);

    // Writing over the damaged field is the repair.
    await writeItem({
      userId: fixture.users.member.id,
      householdId: fixture.household.id,
      sectionId: section.id,
      title: "Damaged item",
      reference: "AB-456",
      notes: "This note survives",
    });
    const repaired = await workspaceFor(fixture);
    const repairedHousehold = repaired.households.find((candidate) => candidate.id === fixture.household.id)!;
    expect(repairedHousehold.items.filter((candidate) => candidate.metadataStatus)).toHaveLength(1);
  });
});

describe("the backfill converts rows that predate encryption (ADR-0024 decision 3)", () => {
  it("encrypts the plaintext left by the expand migration, clears it, and indexes the reference", async () => {
    const fixture = await createIntegrationFixture("tier1-backfill");
    const [section] = await getDb().select({ id: items.sectionId }).from(items).where(eq(items.id, fixture.item.id));

    // Exactly the state migration 0040 leaves an existing row in: plaintext
    // present, ciphertext columns null.
    const legacyId = randomUUID();
    await getDb().insert(items).values({
      id: legacyId,
      householdId: fixture.household.id,
      sectionId: section.id,
      title: "Legacy item",
      currency: "GBP",
      reference: "LEGACY-1",
      notes: "Written before encryption",
    });
    const receiptId = randomUUID();
    await getDb().insert(imapIngestionMessages).values({
      id: receiptId,
      mailbox: "INBOX",
      mailboxUidValidity: "1",
      mailboxUid: 4_242,
      contentSha256: "a".repeat(64),
      recipientAliasSha256: "b".repeat(64),
      householdId: fixture.household.id,
      status: "pending_review",
      expiresAt: new Date(Date.now() + 86_400_000),
      proposal: { title: "Legacy proposal", reference: "LEGACY-1" },
      fieldEvidence: { title: { source: "subject", confidence: "high" } },
    });

    // Readable before the backfill runs: that is what makes the migration safe.
    const before = await workspaceFor(fixture);
    const beforeItem = before.households.find((candidate) => candidate.id === fixture.household.id)!
      .items.find((candidate) => candidate.id === legacyId)!;
    expect(beforeItem.reference).toBe("LEGACY-1");
    expect(beforeItem.notes).toBe("Written before encryption");

    const batch = await runMetadataBackfillBatch(100);
    expect(batch.items).toBeGreaterThanOrEqual(1);
    expect(batch.receipts).toBeGreaterThanOrEqual(1);

    const [converted] = await getDb().select().from(items).where(eq(items.id, legacyId));
    expect(converted.reference).toBeNull();
    expect(converted.notes).toBeNull();
    expect(converted.referenceEnc?.startsWith("mdv1.")).toBe(true);
    expect(converted.notesEnc?.startsWith("mdv1.")).toBe(true);
    expect(converted.referenceIndex).toBeTruthy();

    const [receipt] = await getDb().select().from(imapIngestionMessages).where(eq(imapIngestionMessages.id, receiptId));
    expect(receipt.proposal).toEqual({});
    expect(receipt.fieldEvidence).toEqual({});
    expect(receipt.proposalEnc?.startsWith("mdv1.")).toBe(true);
    expect(receipt.fieldEvidenceEnc?.startsWith("mdv1.")).toBe(true);

    // Same values afterwards, now read through the key.
    const after = await workspaceFor(fixture);
    const afterItem = after.households.find((candidate) => candidate.id === fixture.household.id)!
      .items.find((candidate) => candidate.id === legacyId)!;
    expect(afterItem.reference).toBe("LEGACY-1");
    expect(afterItem.notes).toBe("Written before encryption");

    const reader = await openMetadataReader(fixture.household.id);
    expect(reader.json("imap_ingestion_messages.proposal", receiptId, { encrypted: receipt.proposalEnc, plaintext: {} }))
      .toEqual({ value: { title: "Legacy proposal", reference: "LEGACY-1" } });

    // Resumable and idempotent: a second run finds nothing left to do.
    const second = await runMetadataBackfillBatch(100);
    expect(second).toEqual({ items: 0, receipts: 0 });
  });

  it("leaves an empty receipt draft alone rather than encrypting an empty object", async () => {
    const fixture = await createIntegrationFixture("tier1-backfill-empty");
    const receiptId = randomUUID();
    await getDb().insert(imapIngestionMessages).values({
      id: receiptId,
      mailbox: "INBOX",
      mailboxUidValidity: "1",
      mailboxUid: 4_243,
      contentSha256: "c".repeat(64),
      recipientAliasSha256: "d".repeat(64),
      householdId: fixture.household.id,
      status: "processing",
      expiresAt: new Date(Date.now() + 86_400_000),
    });
    await runMetadataBackfillBatch(100);
    const [receipt] = await getDb().select({ proposalEnc: imapIngestionMessages.proposalEnc })
      .from(imapIngestionMessages).where(eq(imapIngestionMessages.id, receiptId));
    expect(receipt.proposalEnc).toBeNull();
  });

  it("mints the instance-scope key for a receipt with no household yet", async () => {
    await createIntegrationFixture("tier1-backfill-unattributed");
    const receiptId = randomUUID();
    await getDb().insert(imapIngestionMessages).values({
      id: receiptId,
      mailbox: "INBOX",
      mailboxUidValidity: "1",
      mailboxUid: 4_244,
      contentSha256: "e".repeat(64),
      recipientAliasSha256: "f".repeat(64),
      householdId: null,
      status: "unattributed",
      expiresAt: new Date(Date.now() + 86_400_000),
      proposal: { title: "Unattributed receipt" },
    });

    await runMetadataBackfillBatch(100);

    const instanceKeys = await getDb().select().from(metadataKeys).where(eq(metadataKeys.scope, "instance"));
    expect(instanceKeys).toHaveLength(1);
    expect(instanceKeys[0].householdId).toBeNull();

    const [receipt] = await getDb().select().from(imapIngestionMessages).where(eq(imapIngestionMessages.id, receiptId));
    expect(receipt.proposal).toEqual({});
    const reader = await openMetadataReader(null);
    expect(reader.json("imap_ingestion_messages.proposal", receiptId, { encrypted: receipt.proposalEnc, plaintext: {} }))
      .toEqual({ value: { title: "Unattributed receipt" } });

    // Only ever one instance row, whatever races to create it. The assertion
    // names the index, so it fails if the partial unique index is dropped or
    // renamed rather than merely if something threw.
    const duplicate = await getDb().insert(metadataKeys).values({
      scope: "instance",
      householdId: null,
      envelopeVersion: 1,
      wrappedDek: "x",
      wrapIv: "y",
      wrapAuthTag: "z",
      keyId: "duplicate",
    }).then(() => undefined, (error: unknown) => error);
    expect(duplicate).toBeDefined();
    expect(violatedConstraint(duplicate)).toBe("metadata_keys_instance_unique");
    await getDb().delete(metadataKeys).where(eq(metadataKeys.scope, "instance"));
    await getDb().delete(imapIngestionMessages).where(eq(imapIngestionMessages.id, receiptId));
    expect(await getDb().select({ count: sql<number>`count(*)::int` }).from(metadataKeys)
      .where(eq(metadataKeys.scope, "instance"))).toEqual([{ count: 0 }]);
  });
});

describe("a locked instance refuses the write instead of taking it (#941, ADR-0024 decision 5)", () => {
  it("cannot silently overwrite a locked field, and gives the values back untouched when the key returns", async () => {
    const fixture = await createIntegrationFixture("tier1-locked-no-overwrite");
    const [section] = await getDb().select({ id: items.sectionId }).from(items).where(eq(items.id, fixture.item.id));
    const itemId = await writeItem({
      userId: fixture.users.member.id,
      householdId: fixture.household.id,
      sectionId: section.id,
      title: "Locked item",
      reference: "LOCK-1",
      notes: "The note that must survive being locked",
    });
    const [before] = await getDb().select({ referenceEnc: items.referenceEnc, notesEnc: items.notesEnc, referenceIndex: items.referenceIndex, version: items.version })
      .from(items).where(eq(items.id, itemId));

    const unlock = lockTheInstance();
    try {
      // Locked, not damaged: the marker says the value is intact and waiting,
      // and no value and no empty string is handed out in its place.
      const locked = await workspaceFor(fixture);
      const lockedItem = locked.households.find((candidate) => candidate.id === fixture.household.id)!
        .items.find((candidate) => candidate.id === itemId)!;
      expect(lockedItem.metadataStatus).toEqual({ reference: "metadata_locked", notes: "metadata_locked" });
      expect(lockedItem.reference).toBeUndefined();
      expect(lockedItem.notes).toBeUndefined();
      expect(lockedItem.title).toBe("Locked item");

      // THE POINT OF THIS TEST. A panel opened before the key went away, sent
      // after it: the reference and notes it carries are empty, because that
      // is all the locked read could give it. The write must be refused, not
      // accepted as a member deliberately clearing two fields.
      await expect(writeItem({
        userId: fixture.users.member.id,
        householdId: fixture.household.id,
        sectionId: section.id,
        title: "Locked item",
      })).rejects.toMatchObject({ code: "metadata_locked", status: 503 });

      // Nothing moved: not the ciphertext, not the blind index, not even the
      // row's version, so no other device sees a change that did not happen.
      const [during] = await getDb().select({ referenceEnc: items.referenceEnc, notesEnc: items.notesEnc, referenceIndex: items.referenceIndex, version: items.version })
        .from(items).where(eq(items.id, itemId));
      expect(during).toEqual(before);

      // Every edit to the item is refused, not only the two encrypted fields:
      // item.upsert is a full-row write, so a title-only change locks too.
      await expect(writeItem({
        userId: fixture.users.member.id,
        householdId: fixture.household.id,
        sectionId: section.id,
        title: "A different title entirely",
      })).rejects.toMatchObject({ code: "metadata_locked", status: 503 });
      const [title] = await getDb().select({ title: items.title }).from(items).where(eq(items.id, itemId));
      expect(title.title).toBe("Locked item");
    } finally {
      unlock();
    }

    // Reversible, which is the whole difference from damaged.
    const restored = await workspaceFor(fixture);
    const restoredItem = restored.households.find((candidate) => candidate.id === fixture.household.id)!
      .items.find((candidate) => candidate.id === itemId)!;
    expect(restoredItem.metadataStatus).toBeUndefined();
    expect(restoredItem.reference).toBe("LOCK-1");
    expect(restoredItem.notes).toBe("The note that must survive being locked");
  });
});

describe("damaged values are countable for an administrator (#941)", () => {
  it("records a sighting when a value fails to decrypt, counts it, and drops it when the value is written over", async () => {
    const fixture = await createIntegrationFixture("tier1-damage-sightings");
    // The suite shares one database, and earlier tests here deliberately fail
    // integrity checks of their own. Start from a known empty table so the
    // numbers below are this test's and nobody else's.
    await getDb().delete(metadataDamageSightings);
    resetMetadataDamageSightingsForTests();

    const [section] = await getDb().select({ id: items.sectionId }).from(items).where(eq(items.id, fixture.item.id));
    const itemId = await writeItem({
      userId: fixture.users.member.id,
      householdId: fixture.household.id,
      sectionId: section.id,
      title: "Counted item",
      reference: "COUNT-1",
      notes: "A note that is about to be damaged",
    });
    const [stored] = await getDb().select({ notesEnc: items.notesEnc }).from(items).where(eq(items.id, itemId));
    await getDb().update(items)
      .set({ notesEnc: `${stored.notesEnc!.slice(0, -4)}AAAA` })
      .where(eq(items.id, itemId));

    // Nothing has read the row yet, so nothing has been seen: the count is a
    // count of sightings, exactly as the administrator card says.
    await flushMetadataDamageSightings();
    expect(await getDb().select().from(metadataDamageSightings)).toHaveLength(0);

    const damaged = await workspaceFor(fixture);
    expect(damaged.households.find((candidate) => candidate.id === fixture.household.id)!
      .items.find((candidate) => candidate.id === itemId)!.metadataStatus?.notes).toBe("metadata_integrity_failed");

    await flushMetadataDamageSightings();
    const sightings = await getDb().select().from(metadataDamageSightings);
    expect(sightings).toHaveLength(1);
    // Keyed exactly like the value's own content AAD, so it names one value.
    expect(sightings[0]).toMatchObject({ tableName: "items", columnName: "notes", rowId: itemId });
    expect(sightings[0].firstSeenAt).toBeInstanceOf(Date);

    // Reading it again is the same sighting, not a second one.
    await workspaceFor(fixture);
    await flushMetadataDamageSightings();
    expect(await getDb().select().from(metadataDamageSightings)).toHaveLength(1);

    const health = await getDocumentHealth();
    expect(health.metadata).toMatchObject({
      locked: false,
      lockedItems: 0,
      lockedReceipts: 0,
      damagedValues: 1,
      damagedItems: 1,
      damagedReceipts: 0,
    });

    // Overwriting is the repair (ADR-0024), so the count goes with it. The
    // same item id, deliberately: a new row beside the damaged one repairs
    // nothing, and the sighting would rightly still be there.
    await writeItem({
      id: itemId,
      userId: fixture.users.member.id,
      householdId: fixture.household.id,
      sectionId: section.id,
      title: "Counted item",
      reference: "COUNT-1",
      notes: "Retyped over the damage",
    });
    await flushMetadataDamageSightings();
    expect(await getDb().select().from(metadataDamageSightings)).toHaveLength(0);
    expect((await getDocumentHealth()).metadata.damagedValues).toBe(0);

    const repaired = await workspaceFor(fixture);
    const repairedItem = repaired.households.find((candidate) => candidate.id === fixture.household.id)!
      .items.find((candidate) => candidate.id === itemId)!;
    expect(repairedItem.notes).toBe("Retyped over the damage");
    expect(repairedItem.metadataStatus).toBeUndefined();
  });

  it("counts locked rows instead, while the instance holds no key", async () => {
    const fixture = await createIntegrationFixture("tier1-locked-counts");
    await getDb().delete(metadataDamageSightings);
    resetMetadataDamageSightingsForTests();
    const [section] = await getDb().select({ id: items.sectionId }).from(items).where(eq(items.id, fixture.item.id));
    await writeItem({
      userId: fixture.users.member.id,
      householdId: fixture.household.id,
      sectionId: section.id,
      title: "Waiting item",
      notes: "Intact, and unreadable for now",
    });

    const unlock = lockTheInstance();
    try {
      const health = await getDocumentHealth();
      expect(health.metadata.locked).toBe(true);
      // Live SQL over the rows that actually hold ciphertext, not a guess.
      expect(health.metadata.lockedItems).toBeGreaterThanOrEqual(1);
      // Locked is not damage, and must never be counted as any.
      expect(health.metadata.damagedValues).toBe(0);
      expect(await getDb().select().from(metadataDamageSightings)).toHaveLength(0);
    } finally {
      unlock();
    }

    expect((await getDocumentHealth()).metadata.locked).toBe(false);
  });
});
