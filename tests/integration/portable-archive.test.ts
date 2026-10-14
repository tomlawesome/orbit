import { createHash, randomUUID } from "node:crypto";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { and, eq, isNotNull } from "drizzle-orm";
import { getDb } from "@/db";
import { documents, items, sections } from "@/db/schema";
import { decryptPortableArchive, encryptPortableArchive } from "@/server/portable-archive";
import { readDocumentDownload } from "@/server/document-repository";
import { MAX_ARCHIVE_BYTES, MAX_ARCHIVE_CIPHERTEXT_CHARACTERS } from "@/server/portable-archive-limits";
import { createPortableArchive, importPortableArchive, previewPortableArchive, readPortableArchive } from "@/server/portable-archive-repository";
import { openMetadataReader } from "@/server/metadata/fields";
import { readWorkspace } from "@/server/workspace-repository";
import { cleanupIntegrationEnvironment, createIntegrationFixture } from "./support/fixtures";

// The export reads each document through readDocumentDownload. The real one
// needs the stored, encrypted file; the size tests below only need bytes of
// the size the row claims, so they swap in a stand-in and count the calls.
vi.mock("@/server/document-repository", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/document-repository")>();
  return { ...actual, readDocumentDownload: vi.fn(actual.readDocumentDownload) };
});

const passphrase = "correct-horse-battery-staple";

function archivePayload(overrides: { sectionId: string; itemId: string; notes?: string }) {
  return {
    format: "orbit-portable-archive" as const,
    version: 1 as const,
    exportedAt: new Date().toISOString(),
    household: { name: "Imported household" },
    sections: [{
      id: overrides.sectionId,
      slug: `imported-${overrides.sectionId.slice(0, 8)}`,
      name: "Imported section",
      icon: "home",
      accent: "blue",
      position: 0,
      visible: true,
    }],
    items: [{
      id: overrides.itemId,
      sectionId: overrides.sectionId,
      title: "Imported item",
      currency: "GBP",
      status: "active" as const,
      notes: overrides.notes,
    }],
    dueEvents: [],
    reminderRules: [],
    documents: [],
  };
}

afterAll(async () => {
  await cleanupIntegrationEnvironment();
});

describe("portable archive import field bounds (#383 finding 2)", () => {
  it("rejects an archive whose item field exceeds the workspace reader's caps, instead of writing a row the reader will 422 on forever", async () => {
    const fixture = await createIntegrationFixture("portable-archive-import-poisoned");
    const sectionId = randomUUID();
    const itemId = randomUUID();
    // workspaceItemSchema (src/lib/workspace.ts) caps notes at 2,000
    // characters; a length just over that is exactly the shape of archive
    // this schema must now reject before ever writing the row.
    const poisoned = archivePayload({ sectionId, itemId, notes: "x".repeat(2_001) });
    const encrypted = encryptPortableArchive(Buffer.from(JSON.stringify(poisoned)), passphrase);

    await expect(importPortableArchive({
      userId: fixture.users.member.id,
      householdId: fixture.household.id,
      archive: encrypted,
      passphrase,
      conflictItemIds: [],
    })).rejects.toMatchObject({ code: "archive_invalid", status: 422 });

    // The household must not be left bricked: no row was written at all.
    // (Import always assigns its own row id rather than reusing the
    // archive's item id, so the household's whole item list is the handle.)
    // (The household holds only the fixture's own item.)
    expect(await getDb().select({ id: items.id }).from(items)
      .where(eq(items.householdId, fixture.household.id)))
      .toEqual([{ id: fixture.item.id }]);

    // The same shape, within the reader's bound, must still import cleanly:
    // the fix tightens the cap, it does not regress ordinary imports.
    const valid = archivePayload({ sectionId, itemId, notes: "x".repeat(2_000) });
    const validEncrypted = encryptPortableArchive(Buffer.from(JSON.stringify(valid)), passphrase);
    const result = await importPortableArchive({
      userId: fixture.users.member.id,
      householdId: fixture.household.id,
      archive: validEncrypted,
      passphrase,
      conflictItemIds: [],
    });
    expect(result.importedItems).toBe(1);
    // Notes are Tier 1 now (ADR-0024): the import writes the envelope and
    // clears the plaintext, so the cap is asserted on the decrypted value.
    // Found by its own encrypted notes rather than by title: `items.title` is
    // Tier 2 ciphertext since #963, so a SQL equality on it matches nothing.
    const [stored] = await getDb().select({ id: items.id, notes: items.notes, notesEnc: items.notesEnc }).from(items)
      .where(and(eq(items.householdId, fixture.household.id), isNotNull(items.notesEnc)));
    expect(stored?.notes).toBeNull();
    const metadata = await openMetadataReader(fixture.household.id);
    expect(metadata.text("items.notes", stored.id, { encrypted: stored.notesEnc }).value)
      .toHaveLength(2_000);
  });

  it("rejects out-of-range costMinor and recurrenceMonths the same way", async () => {
    const fixture = await createIntegrationFixture("portable-archive-import-poisoned-numeric");
    const negativeCost = archivePayload({ sectionId: randomUUID(), itemId: randomUUID() });
    (negativeCost.items[0] as Record<string, unknown>).costMinor = -1;
    delete (negativeCost.items[0] as Record<string, unknown>).notes;
    const encryptedNegativeCost = encryptPortableArchive(Buffer.from(JSON.stringify(negativeCost)), passphrase);
    await expect(importPortableArchive({
      userId: fixture.users.member.id,
      householdId: fixture.household.id,
      archive: encryptedNegativeCost,
      passphrase,
      conflictItemIds: [],
    })).rejects.toMatchObject({ code: "archive_invalid", status: 422 });

    const excessiveRecurrence = archivePayload({ sectionId: randomUUID(), itemId: randomUUID() });
    (excessiveRecurrence.items[0] as Record<string, unknown>).recurrenceMonths = 999;
    delete (excessiveRecurrence.items[0] as Record<string, unknown>).notes;
    const encryptedRecurrence = encryptPortableArchive(Buffer.from(JSON.stringify(excessiveRecurrence)), passphrase);
    await expect(importPortableArchive({
      userId: fixture.users.member.id,
      householdId: fixture.household.id,
      archive: encryptedRecurrence,
      passphrase,
      conflictItemIds: [],
    })).rejects.toMatchObject({ code: "archive_invalid", status: 422 });
  });
});

describe("portable archive export access and document selection (#1049)", () => {
  it("refuses a non-owner member with owner_required, but still lets the owner export", async () => {
    const fixture = await createIntegrationFixture("portable-archive-export-owner-only");

    await expect(createPortableArchive({
      userId: fixture.users.member.id,
      householdId: fixture.household.id,
      passphrase,
      includeDocuments: false,
    })).rejects.toMatchObject({ code: "owner_required", status: 403 });

    const archive = await createPortableArchive({
      userId: fixture.users.owner.id,
      householdId: fixture.household.id,
      passphrase,
      includeDocuments: false,
    });
    expect(archive.id).toBeTruthy();
  });

  it("excludes a pending_deletion document from the export, keeping an available one", async () => {
    const fixture = await createIntegrationFixture("portable-archive-export-lifecycle");
    const [pendingDeletion] = await getDb().insert(documents).values({
      householdId: fixture.household.id,
      itemId: fixture.item.id,
      uploadedByUserId: fixture.users.owner.id,
      displayName: "pending-deletion-document.pdf",
      mediaType: "application/pdf",
      sizeBytes: 128,
      contentSha256: createHash("sha256").update(`${fixture.household.id}-pending-deletion`).digest("hex"),
      lifecycle: "pending_deletion",
      scanStatus: "skipped",
      availableAt: new Date(),
      deleteAfter: new Date(Date.now() + 86_400_000),
    }).returning({ id: documents.id, displayName: documents.displayName });

    const archive = await createPortableArchive({
      userId: fixture.users.owner.id,
      householdId: fixture.household.id,
      passphrase,
      includeDocuments: false,
    });
    const { bytes } = await readPortableArchive(fixture.users.owner.id, archive.id);
    const encrypted = JSON.parse(bytes.toString("utf8"));
    const payload = JSON.parse(decryptPortableArchive(encrypted, passphrase).toString("utf8"));
    const exportedIds = (payload.documents as Array<{ id: string }>).map((document) => document.id);
    expect(exportedIds).toContain(fixture.document.id);
    expect(exportedIds).not.toContain(pendingDeletion.id);
  });
});

describe("portable archive import section bounds (#1316)", () => {
  // The workspace reader (householdWorkspaceSchema, src/lib/workspace.ts)
  // allows 1 to 12 sections per household and re-validates every stored
  // section, so an import that pushes the total past that, or that stores a
  // section name or icon the reader rejects, leaves a household that
  // readWorkspace refuses to read forever. Owner decision (2026-10-12): refuse
  // up front with a 422 naming the limit; never merge by name.
  const SECTION_LIMIT = 12;

  function archiveWithSections(sectionOverrides: Array<Record<string, unknown>>) {
    const base = archivePayload({ sectionId: randomUUID(), itemId: randomUUID() });
    const archiveSections = sectionOverrides.map((overrides, index) => {
      const id = randomUUID();
      return {
        id,
        slug: `imported-bound-${index}-${id.slice(0, 8)}`,
        name: `Imported section ${index}`,
        icon: "home",
        accent: "blue",
        position: index + 1,
        visible: true,
        ...overrides,
      };
    });
    return {
      ...base,
      sections: archiveSections,
      items: [{ ...base.items[0], sectionId: archiveSections[0].id }],
    };
  }

  async function sectionCount(householdId: string) {
    return (await getDb().select({ id: sections.id }).from(sections).where(eq(sections.householdId, householdId))).length;
  }

  async function importedItemCount(householdId: string) {
    return (await getDb().select({ id: items.id }).from(items)
      .where(and(eq(items.householdId, householdId), isNotNull(items.titleEnc), eq(items.status, "active")))).length;
  }

  it("refuses with a 422 naming the section limit when the import would take the household past it, writing nothing", async () => {
    const fixture = await createIntegrationFixture("portable-archive-import-section-limit");
    // The fixture household already has one section; bring it to nine.
    await getDb().insert(sections).values(Array.from({ length: 8 }, (_, index) => ({
      householdId: fixture.household.id,
      slug: `existing-${index}-${randomUUID().slice(0, 8)}`,
      name: `Existing ${index}`,
      position: index + 1,
    })));
    expect(await sectionCount(fixture.household.id)).toBe(9);
    const itemsBefore = await importedItemCount(fixture.household.id);

    // 9 existing + 4 new = 13, one over the limit of 12.
    const archive = archiveWithSections([{}, {}, {}, {}]);
    const encrypted = encryptPortableArchive(Buffer.from(JSON.stringify(archive)), passphrase);

    const failure = await importPortableArchive({
      userId: fixture.users.member.id,
      householdId: fixture.household.id,
      archive: encrypted,
      passphrase,
      conflictItemIds: [],
    }).then(() => null, (error: unknown) => error);

    expect(failure).toMatchObject({ status: 422 });
    const message = (failure as Error).message;
    expect(message).toMatch(/section/i);
    expect(message).toContain(String(SECTION_LIMIT));

    // Refused before writing anything: no section, no item.
    expect(await sectionCount(fixture.household.id)).toBe(9);
    expect(await importedItemCount(fixture.household.id)).toBe(itemsBefore);

    // And the household is not bricked.
    const session = await fixture.session("member");
    const workspace = await readWorkspace(fixture.users.member.id, session.sessionId);
    expect(workspace).toBeTruthy();
  });

  it("refuses an archive section whose name is 31 characters or more, at parse, as an unsupported archive", async () => {
    const fixture = await createIntegrationFixture("portable-archive-import-section-name");
    const before = await sectionCount(fixture.household.id);
    const archive = archiveWithSections([{ name: "n".repeat(31) }]);
    const encrypted = encryptPortableArchive(Buffer.from(JSON.stringify(archive)), passphrase);

    await expect(importPortableArchive({
      userId: fixture.users.member.id,
      householdId: fixture.household.id,
      archive: encrypted,
      passphrase,
      conflictItemIds: [],
    })).rejects.toMatchObject({ code: "archive_invalid", status: 422 });
    expect(await sectionCount(fixture.household.id)).toBe(before);
  });

  it("refuses an archive section whose icon is not one of the workspace's icons, at parse, as an unsupported archive", async () => {
    const fixture = await createIntegrationFixture("portable-archive-import-section-icon");
    const before = await sectionCount(fixture.household.id);
    const archive = archiveWithSections([{ icon: "not-a-workspace-icon" }]);
    const encrypted = encryptPortableArchive(Buffer.from(JSON.stringify(archive)), passphrase);

    await expect(importPortableArchive({
      userId: fixture.users.member.id,
      householdId: fixture.household.id,
      archive: encrypted,
      passphrase,
      conflictItemIds: [],
    })).rejects.toMatchObject({ code: "archive_invalid", status: 422 });
    expect(await sectionCount(fixture.household.id)).toBe(before);
  });

  it("still imports a section with a 30-character name and a workspace icon, within the limit", async () => {
    const fixture = await createIntegrationFixture("portable-archive-import-section-ok");
    const before = await sectionCount(fixture.household.id);
    const archive = archiveWithSections([{ name: "n".repeat(30), icon: "kite" }]);
    const encrypted = encryptPortableArchive(Buffer.from(JSON.stringify(archive)), passphrase);

    const result = await importPortableArchive({
      userId: fixture.users.member.id,
      householdId: fixture.household.id,
      archive: encrypted,
      passphrase,
      conflictItemIds: [],
    });
    expect(result.importedItems).toBe(1);
    expect(await sectionCount(fixture.household.id)).toBe(before + 1);
    const session = await fixture.session("member");
    await expect(readWorkspace(fixture.users.member.id, session.sessionId)).resolves.toBeTruthy();
  });
});

describe("portable archive document-inclusive export size (#1316, owner decision 2026-10-12)", () => {
  const MIB = 1_048_576;
  const realReadDocumentDownload = vi.mocked(readDocumentDownload).getMockImplementation()!;

  afterEach(() => {
    vi.mocked(readDocumentDownload).mockReset();
    vi.mocked(readDocumentDownload).mockImplementation(realReadDocumentDownload);
  });

  /** Available documents on the fixture's item, each row claiming `sizeBytes`. */
  async function addAvailableDocuments(fixture: Awaited<ReturnType<typeof createIntegrationFixture>>, count: number, sizeBytes: number) {
    const sizes = new Map<string, number>();
    for (let index = 0; index < count; index += 1) {
      const [row] = await getDb().insert(documents).values({
        householdId: fixture.household.id,
        itemId: fixture.item.id,
        uploadedByUserId: fixture.users.owner.id,
        displayName: `size-test-${index}.pdf`,
        mediaType: "application/pdf",
        sizeBytes,
        contentSha256: createHash("sha256").update(randomUUID()).digest("hex"),
        lifecycle: "available",
        scanStatus: "skipped",
        availableAt: new Date(),
      }).returning({ id: documents.id });
      sizes.set(row.id, sizeBytes);
    }
    // A fresh buffer per call: the export zeroes each one after use.
    vi.mocked(readDocumentDownload).mockImplementation(async (_userId, documentId) => ({
      bytes: Buffer.alloc(sizes.get(documentId) ?? 128),
      displayName: "size-test.pdf",
      mediaType: "application/pdf",
    }));
  }

  it("raises the archive limit to 256 MiB, which the cipher-text and file limits follow", () => {
    expect(MAX_ARCHIVE_BYTES).toBe(256 * MIB);
    expect(MAX_ARCHIVE_CIPHERTEXT_CHARACTERS).toBe(Math.ceil((256 * MIB) / 3) * 4);
  });

  it("exports a household whose available documents total about 80 MiB, and the import pre-check accepts the written file", async () => {
    const fixture = await createIntegrationFixture("portable-archive-export-80-mib");
    await addAvailableDocuments(fixture, 10, 8 * MIB);

    // Today this is refused after encryption with "That export exceeds Orbit's
    // portable archive limit": 80 MiB of documents is about 107 MiB as base64,
    // and the finished file is about 143 MiB, over the 128 MiB cap.
    const archive = await createPortableArchive({
      userId: fixture.users.owner.id,
      householdId: fixture.household.id,
      passphrase,
      includeDocuments: true,
    });
    expect(archive.includesDocuments).toBe(true);

    const { bytes } = await readPortableArchive(fixture.users.owner.id, archive.id);
    const encrypted = JSON.parse(bytes.toString("utf8"));
    // The import's size pre-check (rejectOversizedCiphertext) runs first in
    // the preview, before any decryption; the preview then decrypts the
    // archive and counts what it holds, so a file the pre-check or the
    // plaintext cap refused would throw archive_too_large here.
    expect(encrypted.ciphertext.length).toBeLessThanOrEqual(MAX_ARCHIVE_CIPHERTEXT_CHARACTERS);
    const preview = previewPortableArchive(encrypted, passphrase);
    // Ten rows added here, plus the fixture's own document.
    expect(preview.documents).toBe(11);
  }, 180_000);

  it("refuses a household whose documents total about 200 MiB before reading any document, naming about 192 MiB", async () => {
    const fixture = await createIntegrationFixture("portable-archive-export-200-mib");
    // 200 MiB of documents is over the new 192 MiB document figure only when
    // the pre-check counts them at their base64 size (about 267 MiB against
    // the 256 MiB archive limit). Counted raw, 200 MiB would sit under the
    // 256 MiB limit and every document would be read before the refusal.
    await addAvailableDocuments(fixture, 4, 50 * MIB);

    const refusal = await createPortableArchive({
      userId: fixture.users.owner.id,
      householdId: fixture.household.id,
      passphrase,
      includeDocuments: true,
    }).then(() => null, (error: unknown) => error);

    expect(refusal).toMatchObject({ code: "archive_too_large", status: 413 });
    const message = (refusal as { message: string }).message;
    expect(message).toMatch(/about 192 MiB/);
    expect(message).not.toMatch(/128 MiB/);
    expect(readDocumentDownload).not.toHaveBeenCalled();
  }, 60_000);
});
