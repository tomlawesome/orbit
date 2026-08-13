import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { items } from "@/db/schema";
import { encryptPortableArchive } from "@/server/portable-archive";
import { importPortableArchive } from "@/server/portable-archive-repository";
import { cleanupIntegrationEnvironment, createIntegrationFixture } from "./support/fixtures";

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
    // archive's item id, so title is the only stable handle here.)
    expect(await getDb().select({ id: items.id }).from(items)
      .where(and(eq(items.householdId, fixture.household.id), eq(items.title, "Imported item"))))
      .toHaveLength(0);

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
    const [stored] = await getDb().select({ notes: items.notes }).from(items)
      .where(and(eq(items.householdId, fixture.household.id), eq(items.title, "Imported item")));
    expect(stored?.notes).toHaveLength(2_000);
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
