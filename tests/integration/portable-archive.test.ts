import { createHash, randomBytes, randomUUID } from "node:crypto";
import { open as openFile, readdir, readFile, readlink, stat, writeFile } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { auditLog, documents, dueEvents, items, portableArchiveImports, portableArchives, sections } from "@/db/schema";
import { decryptPortableArchive, encryptPortableArchive } from "@/server/portable-archive";
import { readDocumentDownload } from "@/server/document-repository";
import { MAX_ARCHIVE_BYTES, MAX_ARCHIVE_CIPHERTEXT_CHARACTERS } from "@/server/portable-archive-limits";
import { createPortableArchive, importPortableArchive, openPortableArchiveDownload, previewPortableArchive, previewPortableImport, readPortableArchive, rollBackUnfinishedPortableImports } from "@/server/portable-archive-repository";
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
      userId: fixture.users.owner.id,
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
      userId: fixture.users.owner.id,
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
    const [stored] = await getDb().select({ id: items.id, notesEnc: items.notesEnc }).from(items)
      .where(and(eq(items.householdId, fixture.household.id), isNotNull(items.notesEnc)));
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
      userId: fixture.users.owner.id,
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
      userId: fixture.users.owner.id,
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

  it("refuses a non-owner member's import with owner_required, writing nothing and opening no import row (#1316, owner 2026-10-14)", async () => {
    const fixture = await createIntegrationFixture("portable-archive-import-owner-only");
    const encrypted = encryptPortableArchive(
      Buffer.from(JSON.stringify(archivePayload({ sectionId: randomUUID(), itemId: randomUUID() }))),
      passphrase,
    );

    await expect(importPortableArchive({
      userId: fixture.users.member.id,
      householdId: fixture.household.id,
      archive: encrypted,
      passphrase,
      conflictItemIds: [],
    })).rejects.toMatchObject({ code: "owner_required", status: 403 });

    expect(await getDb().select({ id: portableArchiveImports.id }).from(portableArchiveImports)
      .where(eq(portableArchiveImports.householdId, fixture.household.id))).toEqual([]);
    expect(await getDb().select({ id: items.id }).from(items)
      .where(eq(items.householdId, fixture.household.id)))
      .toEqual([{ id: fixture.item.id }]);
  });

  it("refuses a non-owner member's import preview with owner_required (#1316, owner 2026-10-14)", async () => {
    const fixture = await createIntegrationFixture("portable-archive-preview-owner-only");
    const encrypted = encryptPortableArchive(
      Buffer.from(JSON.stringify(archivePayload({ sectionId: randomUUID(), itemId: randomUUID() }))),
      passphrase,
    );

    await expect(previewPortableImport(fixture.users.member.id, fixture.household.id, encrypted, passphrase))
      .rejects.toMatchObject({ code: "owner_required", status: 403 });
    await expect(previewPortableImport(fixture.users.owner.id, fixture.household.id, encrypted, passphrase))
      .resolves.toMatchObject({ items: 1 });
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

  describe("an item field whose ciphertext fails its integrity check", () => {
    // Every file the export has written under the archive store. Compared
    // before and after a refused export: a refusal must leave no file behind.
    async function archiveFiles(): Promise<string[]> {
      try {
        return (await readdir(join(process.env.DOCUMENTS_ROOT!, "portable-archives"), { recursive: true })).sort();
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw error;
      }
    }

    async function archiveRows(householdId: string) {
      return getDb().select({ id: portableArchives.id }).from(portableArchives)
        .where(eq(portableArchives.householdId, householdId));
    }

    async function expectDamagedRefusal(label: string, column: "titleEnc" | "providerEnc") {
      const fixture = await createIntegrationFixture(label);
      // Random bytes in place of the envelope: the same corruption
      // mail-relay-sender-read.test.ts writes over address_enc.
      await getDb().update(items)
        .set({ [column]: randomBytes(48).toString("base64") })
        .where(eq(items.id, fixture.item.id));
      const rowsBefore = await archiveRows(fixture.household.id);
      const filesBefore = await archiveFiles();

      const refusal = await createPortableArchive({
        userId: fixture.users.owner.id,
        householdId: fixture.household.id,
        passphrase,
        includeDocuments: false,
      }).then(() => null, (error: unknown) => error);

      expect(refusal).toMatchObject({ code: "archive_metadata_damaged", status: 409 });
      expect(await archiveRows(fixture.household.id)).toEqual(rowsBefore);
      expect(await archiveFiles()).toEqual(filesBefore);
    }

    it("refuses the export with archive_metadata_damaged (409) when an item's title is unreadable, writing no archive row or file", async () => {
      await expectDamagedRefusal("portable-archive-export-damaged-title", "titleEnc");
    });

    it("refuses the export with archive_metadata_damaged (409) when an item's provider is unreadable, writing no archive row or file", async () => {
      await expectDamagedRefusal("portable-archive-export-damaged-provider", "providerEnc");
    });

    it("still exports an untouched household, and that archive imports into a fresh household", async () => {
      const source = await createIntegrationFixture("portable-archive-export-undamaged");
      const target = await createIntegrationFixture("portable-archive-export-undamaged-target");

      const archive = await createPortableArchive({
        userId: source.users.owner.id,
        householdId: source.household.id,
        passphrase,
        includeDocuments: false,
      });
      const { bytes } = await readPortableArchive(source.users.owner.id, archive.id);
      const encrypted = JSON.parse(bytes.toString("utf8"));

      const result = await importPortableArchive({
        userId: target.users.owner.id,
        householdId: target.household.id,
        archive: encrypted,
        passphrase,
        conflictItemIds: [],
      });
      expect(result.importedItems).toBe(1);
    });
  });
});

describe("portable archive import whose closing write fails, and rollback of touched items (#1316, owner decision 2026-10-14)", () => {
  // importPortableArchive commits the items, restores documents, then writes
  // finished_at / outcome 'completed' last. If that write fails the import must
  // fail whole while the administrator is present: roll back and refuse. A row
  // left open must never later delete items members have since edited or
  // completed, at boot or before the household's next import.
  type Fixture = Awaited<ReturnType<typeof createIntegrationFixture>>;

  async function exportedArchive(source: Fixture) {
    const archive = await createPortableArchive({
      userId: source.users.owner.id,
      householdId: source.household.id,
      passphrase,
      includeDocuments: false,
    });
    const { bytes } = await readPortableArchive(source.users.owner.id, archive.id);
    return JSON.parse(bytes.toString("utf8"));
  }

  async function insertOpenImport(fixture: Fixture, startedAt: Date) {
    const importId = randomUUID();
    await getDb().insert(portableArchiveImports).values({
      id: importId,
      householdId: fixture.household.id,
      actorUserId: fixture.users.owner.id,
      startedAt,
      finishedAt: null,
      createdSectionIds: [],
      createdItemIds: [fixture.item.id],
    });
    return importId;
  }

  async function importRow(importId: string) {
    const [row] = await getDb().select().from(portableArchiveImports).where(eq(portableArchiveImports.id, importId));
    return row;
  }

  async function itemExists(itemId: string) {
    return (await getDb().select({ id: items.id }).from(items).where(eq(items.id, itemId))).length === 1;
  }

  // A member edited the item since the import: its version moved past 1.
  async function editItem(itemId: string) {
    await getDb().update(items).set({ version: 2 }).where(eq(items.id, itemId));
  }

  // A member completed the item's open due event since the import.
  async function completeDueEvent(fixture: Fixture) {
    await getDb().insert(dueEvents).values({
      householdId: fixture.household.id,
      itemId: fixture.item.id,
      kind: "renewal",
      dueDate: "2027-01-01",
      completedAt: new Date(),
      completedByUserId: fixture.users.member.id,
    });
  }

  const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000);

  it("fails the whole import with archive_import_failed (422) when the closing write fails, rolling the items back and closing the row as rolled_back", async () => {
    const source = await createIntegrationFixture("portable-archive-closing-write-source");
    const target = await createIntegrationFixture("portable-archive-closing-write-target");
    const encrypted = await exportedArchive(source);
    const suffix = randomUUID().replaceAll("-", "");
    const fn = `fail_closing_write_${suffix}`;
    const trigger = `fail_closing_write_trg_${suffix}`;
    const db = getDb();

    await db.execute(sql.raw(`create function ${fn}() returns trigger language plpgsql as $$ begin raise exception 'simulated closing write failure'; end $$`));
    await db.execute(sql.raw(`create trigger ${trigger} before update on portable_archive_imports for each row when (new.outcome = 'completed' and new.household_id = '${target.household.id}') execute function ${fn}()`));
    let refusal: unknown = null;
    try {
      refusal = await importPortableArchive({
        userId: target.users.owner.id,
        householdId: target.household.id,
        archive: encrypted,
        passphrase,
        conflictItemIds: [],
      }).then(() => null, (error: unknown) => error);
    } finally {
      await db.execute(sql.raw(`drop trigger if exists ${trigger} on portable_archive_imports`));
      await db.execute(sql.raw(`drop function if exists ${fn}()`));
    }

    expect(refusal).toMatchObject({ code: "archive_import_failed", status: 422 });
    const rows = await db.select().from(portableArchiveImports).where(eq(portableArchiveImports.householdId, target.household.id));
    expect(rows).toHaveLength(1);
    expect(rows[0].finishedAt).not.toBeNull();
    expect(rows[0].outcome).toBe("rolled_back");
    expect(rows[0].createdItemIds).toHaveLength(1);
    expect(await db.select({ id: items.id }).from(items).where(inArray(items.id, rows[0].createdItemIds))).toEqual([]);
    const audit = await db.select({ id: auditLog.id }).from(auditLog).where(and(
      eq(auditLog.householdId, target.household.id),
      eq(auditLog.action, "portable_archive_import_rolled_back"),
      eq(auditLog.entityId, rows[0].id),
    ));
    expect(audit).toHaveLength(1);
  });

  it("keeps an item edited since the import (version 2) when the boot-time sweep finds its import row open, leaving the row open", async () => {
    const fixture = await createIntegrationFixture("portable-archive-sweep-edited");
    const importId = await insertOpenImport(fixture, minutesAgo(5));
    await editItem(fixture.item.id);
    try {
      await rollBackUnfinishedPortableImports();

      expect(await itemExists(fixture.item.id)).toBe(true);
      expect((await importRow(importId)).finishedAt).toBeNull();
    } finally {
      await getDb().delete(portableArchiveImports).where(eq(portableArchiveImports.id, importId));
    }
  });

  it("keeps an item whose due event was completed since the import (version 1) when the boot-time sweep finds its import row open", async () => {
    const fixture = await createIntegrationFixture("portable-archive-sweep-completed");
    const importId = await insertOpenImport(fixture, minutesAgo(5));
    await completeDueEvent(fixture);
    try {
      await rollBackUnfinishedPortableImports();

      expect(await itemExists(fixture.item.id)).toBe(true);
      expect((await importRow(importId)).finishedAt).toBeNull();
    } finally {
      await getDb().delete(portableArchiveImports).where(eq(portableArchiveImports.id, importId));
    }
  });

  it("keeps an edited item when the pre-import sweep meets a two-hour-old open row, and the new import succeeds", async () => {
    const fixture = await createIntegrationFixture("portable-archive-pre-import-sweep");
    const importId = await insertOpenImport(fixture, minutesAgo(120));
    await editItem(fixture.item.id);
    const archive = encryptPortableArchive(
      Buffer.from(JSON.stringify(archivePayload({ sectionId: randomUUID(), itemId: randomUUID() }))),
      passphrase,
    );
    try {
      const result = await importPortableArchive({
        userId: fixture.users.owner.id,
        householdId: fixture.household.id,
        archive,
        passphrase,
        conflictItemIds: [],
      });

      expect(result.importedItems).toBe(1);
      expect(await itemExists(fixture.item.id)).toBe(true);
    } finally {
      await getDb().delete(portableArchiveImports).where(eq(portableArchiveImports.id, importId));
    }
  });

  it("guard: still rolls back an untouched item (version 1, no completed event) from an open row, closing it as rolled_back", async () => {
    const fixture = await createIntegrationFixture("portable-archive-sweep-untouched");
    const importId = await insertOpenImport(fixture, minutesAgo(5));

    await rollBackUnfinishedPortableImports();

    expect(await itemExists(fixture.item.id)).toBe(false);
    const row = await importRow(importId);
    expect(row.finishedAt).not.toBeNull();
    expect(row.outcome).toBe("rolled_back");
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
      userId: fixture.users.owner.id,
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
      userId: fixture.users.owner.id,
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
      userId: fixture.users.owner.id,
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
      userId: fixture.users.owner.id,
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

describe("portable archive download is streamed from disk and still refuses a tampered file (#1428, part of #1316)", () => {
  const MIB = 1_048_576;
  const realReadDocumentDownload = vi.mocked(readDocumentDownload).getMockImplementation()!;

  afterEach(() => {
    vi.mocked(readDocumentDownload).mockReset();
    vi.mocked(readDocumentDownload).mockImplementation(realReadDocumentDownload);
  });

  type Fixture = Awaited<ReturnType<typeof createIntegrationFixture>>;

  /** Extra available documents on the fixture's item, each read back as `sizeBytes` of zeros. */
  async function addAvailableDocuments(fixture: Fixture, count: number, sizeBytes: number) {
    const sizes = new Map<string, number>();
    for (let index = 0; index < count; index += 1) {
      const [row] = await getDb().insert(documents).values({
        householdId: fixture.household.id,
        itemId: fixture.item.id,
        uploadedByUserId: fixture.users.owner.id,
        displayName: `stream-test-${index}.pdf`,
        mediaType: "application/pdf",
        sizeBytes,
        contentSha256: createHash("sha256").update(randomUUID()).digest("hex"),
        lifecycle: "available",
        scanStatus: "skipped",
        availableAt: new Date(),
      }).returning({ id: documents.id });
      sizes.set(row.id, sizeBytes);
    }
    vi.mocked(readDocumentDownload).mockImplementation(async (_userId, documentId) => ({
      bytes: Buffer.alloc(sizes.get(documentId) ?? 128),
      displayName: "stream-test.pdf",
      mediaType: "application/pdf",
    }));
  }

  /** The one stored file for an archive: the file under the document root whose path carries its storage key. */
  async function storedFilePath(archiveId: string): Promise<string> {
    const [row] = await getDb().select({ storageKey: portableArchives.storageKey }).from(portableArchives)
      .where(eq(portableArchives.id, archiveId));
    const root = process.env.DOCUMENTS_ROOT!;
    for (const entry of await readdir(root, { recursive: true })) {
      if (!entry.includes(row.storageKey)) continue;
      const path = join(root, entry);
      if ((await stat(path)).isFile()) return path;
    }
    throw new Error(`no stored file found for archive ${archiveId}`);
  }

  async function smallArchive(fixture: Fixture) {
    return createPortableArchive({
      userId: fixture.users.owner.id,
      householdId: fixture.household.id,
      passphrase,
      includeDocuments: false,
    });
  }

  it("returns exactly the stored file's bytes, in more than one chunk and none over 1 MiB, with sizeBytes equal to their length", async () => {
    const fixture = await createIntegrationFixture("portable-archive-download-stream");
    await addAvailableDocuments(fixture, 3, 2 * MIB);
    const archive = await createPortableArchive({
      userId: fixture.users.owner.id,
      householdId: fixture.household.id,
      passphrase,
      includeDocuments: true,
    });
    const whole = (await readPortableArchive(fixture.users.owner.id, archive.id)).bytes;
    expect(whole.length).toBeGreaterThan(MIB);

    const { stream, sizeBytes } = await openPortableArchiveDownload(fixture.users.owner.id, archive.id);
    const chunks: Uint8Array[] = [];
    const reader = stream.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }

    expect(sizeBytes).toBe(whole.length);
    expect(Buffer.concat(chunks).equals(whole)).toBe(true);
    expect(chunks.length).toBeGreaterThan(1);
    expect(Math.max(...chunks.map((chunk) => chunk.byteLength))).toBeLessThanOrEqual(MIB);
  }, 120_000);

  it("refuses with archive_integrity_failed (503) when one byte of the stored file was changed", async () => {
    const fixture = await createIntegrationFixture("portable-archive-download-tampered");
    const archive = await smallArchive(fixture);
    const path = await storedFilePath(archive.id);
    const stored = await readFile(path);
    stored[Math.floor(stored.length / 2)] ^= 0xff;
    await writeFile(path, stored);

    await expect(openPortableArchiveDownload(fixture.users.owner.id, archive.id))
      .rejects.toMatchObject({ code: "archive_integrity_failed", status: 503 });
  });

  it("refuses another household's member with archive_not_found (404)", async () => {
    const fixture = await createIntegrationFixture("portable-archive-download-other-household");
    const archive = await smallArchive(fixture);

    await expect(openPortableArchiveDownload(fixture.users.secondOwner.id, archive.id))
      .rejects.toMatchObject({ code: "archive_not_found", status: 404 });
  });

  it("records downloadedAt and one portable_archive_downloaded audit row after a successful open", async () => {
    const fixture = await createIntegrationFixture("portable-archive-download-recorded");
    const archive = await smallArchive(fixture);
    const [before] = await getDb().select({ downloadedAt: portableArchives.downloadedAt }).from(portableArchives)
      .where(eq(portableArchives.id, archive.id));
    expect(before.downloadedAt).toBeNull();

    const { stream } = await openPortableArchiveDownload(fixture.users.owner.id, archive.id);
    await stream.cancel();

    const [after] = await getDb().select({ downloadedAt: portableArchives.downloadedAt }).from(portableArchives)
      .where(eq(portableArchives.id, archive.id));
    expect(after.downloadedAt).not.toBeNull();
    const audit = await getDb().select({ id: auditLog.id }).from(auditLog).where(and(
      eq(auditLog.householdId, fixture.household.id),
      eq(auditLog.action, "portable_archive_downloaded"),
    ));
    expect(audit).toHaveLength(1);
  });
  /** The descriptors this process holds open on `path`; entries that close while the directory is listed are skipped. */
  async function handlesOpenTo(path: string): Promise<string[]> {
    const open: string[] = [];
    for (const fd of await readdir("/proc/self/fd")) {
      try {
        if ((await readlink(`/proc/self/fd/${fd}`)) === path) open.push(fd);
      } catch {
        // closed between the listing and the read
      }
    }
    return open.sort();
  }

  const closedWithin = { timeout: 2_000, interval: 25 };

  /**
   * Notes every FileHandle a read stream is made from, and the descriptors that then get an explicit close
   * (the handle's 'close' event). A handle the garbage collector closes emits no such event, so it never
   * counts: the polling window alone cannot tell the two apart, because the collector closes a leaked handle
   * inside it. (`close` is an own property of each handle, not on the prototype, so the prototype's
   * createReadStream is the place to reach them.)
   */
  async function recordExplicitHandleCloses() {
    const probe = await openFile(process.execPath, "r");
    const prototype = Object.getPrototypeOf(probe) as FileHandle;
    await probe.close();
    const original = prototype.createReadStream;
    const seen = new Set<FileHandle>();
    const closedDescriptors: string[] = [];
    const spy = vi.spyOn(prototype, "createReadStream").mockImplementation(function (this: FileHandle, ...args: Parameters<FileHandle["createReadStream"]>) {
      if (!seen.has(this)) {
        seen.add(this);
        const descriptor = String(this.fd);
        (this as unknown as NodeJS.EventEmitter).once("close", () => closedDescriptors.push(descriptor));
      }
      return original.apply(this, args);
    });
    return { closedDescriptors, stop: () => spy.mockRestore() };
  }

  async function documentArchive(fixture: Fixture) {
    await addAvailableDocuments(fixture, 3, 2 * MIB);
    return createPortableArchive({
      userId: fixture.users.owner.id,
      householdId: fixture.household.id,
      passphrase,
      includeDocuments: true,
    });
  }

  async function tamper(archiveId: string) {
    const path = await storedFilePath(archiveId);
    const stored = await readFile(path);
    stored[Math.floor(stored.length / 2)] ^= 0xff;
    await writeFile(path, stored);
  }

  it("holds one handle on the stored file while streaming and none once the stream is read to its end, closed explicitly rather than by the garbage collector", async () => {
    const fixture = await createIntegrationFixture("portable-archive-download-fd-end");
    const archive = await documentArchive(fixture);
    const path = await storedFilePath(archive.id);
    expect(await handlesOpenTo(path)).toEqual([]);

    const closes = await recordExplicitHandleCloses();
    try {
      const { stream } = await openPortableArchiveDownload(fixture.users.owner.id, archive.id);
      const reader = stream.getReader();
      let chunks = 0;
      let held: string[] = [];
      for (;;) {
        const { done } = await reader.read();
        if (done) break;
        chunks += 1;
        if (chunks === 1) {
          held = await handlesOpenTo(path);
          expect(held).toHaveLength(1);
        }
      }

      expect(chunks).toBeGreaterThan(1);
      await vi.waitFor(() => expect(handlesOpenTo(path)).resolves.toEqual([]), closedWithin);
      expect(closes.closedDescriptors).toContain(held[0]);
    } finally {
      closes.stop();
    }
  }, 120_000);

  it("holds one handle on the stored file after the first chunk and none once the stream is cancelled, closed explicitly rather than by the garbage collector", async () => {
    const fixture = await createIntegrationFixture("portable-archive-download-fd-cancel");
    const archive = await documentArchive(fixture);
    const path = await storedFilePath(archive.id);
    expect(await handlesOpenTo(path)).toEqual([]);

    const closes = await recordExplicitHandleCloses();
    try {
      const { stream } = await openPortableArchiveDownload(fixture.users.owner.id, archive.id);
      const reader = stream.getReader();
      const first = await reader.read();
      expect(first.done).toBe(false);
      const held = await handlesOpenTo(path);
      expect(held).toHaveLength(1);
      await reader.cancel();

      await vi.waitFor(() => expect(handlesOpenTo(path)).resolves.toEqual([]), closedWithin);
      expect(closes.closedDescriptors).toContain(held[0]);
    } finally {
      closes.stop();
    }
  }, 120_000);

  it("holds no handle on the stored file once a tampered file is refused", async () => {
    const fixture = await createIntegrationFixture("portable-archive-download-fd-refused");
    const archive = await smallArchive(fixture);
    await tamper(archive.id);
    const path = await storedFilePath(archive.id);
    expect(await handlesOpenTo(path)).toEqual([]);

    await expect(openPortableArchiveDownload(fixture.users.owner.id, archive.id))
      .rejects.toMatchObject({ code: "archive_integrity_failed", status: 503 });

    // The refusal awaits the close before it rejects, so no waiting is allowed here: a handle left to the
    // garbage collector would also vanish within a polling window and hide the fault.
    expect(await handlesOpenTo(path)).toEqual([]);
  });

  it("records no download time and no audit row when a tampered file is refused", async () => {
    const fixture = await createIntegrationFixture("portable-archive-download-tampered-unrecorded");
    const archive = await smallArchive(fixture);
    await tamper(archive.id);

    await expect(openPortableArchiveDownload(fixture.users.owner.id, archive.id))
      .rejects.toMatchObject({ code: "archive_integrity_failed", status: 503 });

    const [row] = await getDb().select({ downloadedAt: portableArchives.downloadedAt }).from(portableArchives)
      .where(eq(portableArchives.id, archive.id));
    expect(row.downloadedAt).toBeNull();
    const audit = await getDb().select({ id: auditLog.id }).from(auditLog).where(and(
      eq(auditLog.householdId, fixture.household.id),
      eq(auditLog.action, "portable_archive_downloaded"),
    ));
    expect(audit).toHaveLength(0);
  });

  it("reports sizeBytes equal to the stored file's length and streams bytes that hash to the stored contentSha256", async () => {
    const fixture = await createIntegrationFixture("portable-archive-download-size-hash");
    const archive = await documentArchive(fixture);
    const path = await storedFilePath(archive.id);
    const [row] = await getDb().select({ contentSha256: portableArchives.contentSha256 }).from(portableArchives)
      .where(eq(portableArchives.id, archive.id));

    const { stream, sizeBytes } = await openPortableArchiveDownload(fixture.users.owner.id, archive.id);
    const hash = createHash("sha256");
    let streamed = 0;
    const reader = stream.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      hash.update(value);
      streamed += value.byteLength;
    }

    expect(sizeBytes).toBe((await stat(path)).size);
    expect(streamed).toBe(sizeBytes);
    expect(hash.digest("hex")).toBe(row.contentSha256);
  }, 120_000);
});
