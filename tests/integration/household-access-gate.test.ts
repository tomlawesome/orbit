import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { getDb } from "@/db";
import { households, items, portableArchiveImports } from "@/db/schema";
import { AppError } from "@/lib/app-error";
import { listItemDocuments, readDocumentDownload } from "@/server/document-repository";
import { encryptPortableArchive } from "@/server/portable-archive";
import { importPortableArchive, requirePortableArchiveAccess, rollBackUnfinishedPortableImports } from "@/server/portable-archive-repository";
import { readWorkspace } from "@/server/workspace-repository";
import { requireHouseholdAccess } from "@/server/workspace-access";
import { cleanupIntegrationEnvironment, createIntegrationFixture } from "./support/fixtures";

/**
 * The shared household access gate (#1334). A disabled account has no
 * sessions, so these refusals are defence in depth: they pin that every gate
 * agrees with the strictest one, and that each keeps the status, code and
 * wording its callers already see.
 */

afterAll(async () => {
  await cleanupIntegrationEnvironment();
});

async function refusal(promise: Promise<unknown>): Promise<{ status: number; code: string; message: string }> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof AppError) return { status: error.status, code: error.code, message: error.message };
    throw error;
  }
  throw new Error("expected a refusal, but the call was allowed");
}

const HOUSEHOLD_UNAVAILABLE = { status: 404, code: "household_not_found", message: "That household is not available" };
const ITEM_UNAVAILABLE = { status: 404, code: "item_not_found", message: "That item is not available" };
const DOCUMENT_UNAVAILABLE = { status: 404, code: "document_not_found", message: "That document is not available" };

describe("the household access gate", () => {
  it("refuses a malformed household id with 422 before reaching the database", async () => {
    const fixture = await createIntegrationFixture("gate-household-malformed");
    expect(await refusal(requireHouseholdAccess(fixture.users.owner.id, "not-a-uuid"))).toEqual({
      status: 422,
      code: "invalid_identifier",
      message: "Household is not a valid identifier",
    });
  });
});

describe("portable archive access", () => {
  // Import and export both belong to household owners (owner, 2026-10-14).
  it("allows an owner and an administrator to export and import", async () => {
    const fixture = await createIntegrationFixture("archive-allowed");
    await requirePortableArchiveAccess(fixture.users.owner.id, fixture.household.id, "export");
    await requirePortableArchiveAccess(fixture.users.owner.id, fixture.household.id, "import");
    await requirePortableArchiveAccess(fixture.users.admin.id, fixture.household.id, "export");
    await requirePortableArchiveAccess(fixture.users.admin.id, fixture.household.id, "import");
  });

  it("keeps its existing refusals for a member exporting, an outsider and an unknown household", async () => {
    const fixture = await createIntegrationFixture("archive-existing-refusals");
    expect(await refusal(requirePortableArchiveAccess(fixture.users.member.id, fixture.household.id, "export"))).toEqual({
      status: 403,
      code: "owner_required",
      message: "Only a household owner can make this change",
    });
    expect(await refusal(requirePortableArchiveAccess(fixture.users.outsider.id, fixture.household.id, "import"))).toEqual(HOUSEHOLD_UNAVAILABLE);
    expect(await refusal(requirePortableArchiveAccess(fixture.users.owner.id, randomUUID(), "import"))).toEqual(HOUSEHOLD_UNAVAILABLE);
    expect(await refusal(requirePortableArchiveAccess(randomUUID(), fixture.household.id, "import"))).toEqual(HOUSEHOLD_UNAVAILABLE);
  });

  it("keeps refusing a household that is waiting to be deleted", async () => {
    const fixture = await createIntegrationFixture("archive-pending-deletion");
    await getDb().update(households).set({ deletionRequestedAt: new Date(), deleteAfter: new Date(Date.now() + 86_400_000) }).where(eq(households.id, fixture.household.id));
    expect(await refusal(requirePortableArchiveAccess(fixture.users.owner.id, fixture.household.id, "import"))).toEqual(HOUSEHOLD_UNAVAILABLE);
    expect(await refusal(requirePortableArchiveAccess(fixture.users.admin.id, fixture.household.id, "import"))).toEqual(HOUSEHOLD_UNAVAILABLE);
  });

  it("refuses a disabled member or owner as it refuses a stranger", async () => {
    const fixture = await createIntegrationFixture("archive-disabled-member");
    await fixture.disableUser("member");
    expect(await refusal(requirePortableArchiveAccess(fixture.users.member.id, fixture.household.id, "import"))).toEqual(HOUSEHOLD_UNAVAILABLE);
    await fixture.disableUser("owner");
    expect(await refusal(requirePortableArchiveAccess(fixture.users.owner.id, fixture.household.id, "export"))).toEqual(HOUSEHOLD_UNAVAILABLE);
  });

  it("refuses a disabled administrator", async () => {
    const fixture = await createIntegrationFixture("archive-disabled-admin");
    await fixture.disableUser("admin");
    expect(await refusal(requirePortableArchiveAccess(fixture.users.admin.id, fixture.household.id, "import"))).toEqual(HOUSEHOLD_UNAVAILABLE);
  });

  it("refuses a malformed household id with 422", async () => {
    const fixture = await createIntegrationFixture("archive-malformed");
    expect(await refusal(requirePortableArchiveAccess(fixture.users.owner.id, "not-a-uuid", "import"))).toEqual({
      status: 422,
      code: "invalid_identifier",
      message: "Household is not a valid identifier",
    });
  });
});

describe("document access", () => {
  it("lets a member and an administrator list an item's documents and read a document", async () => {
    const fixture = await createIntegrationFixture("documents-allowed");
    for (const role of ["member", "owner", "admin"] as const) {
      const documentsListed = await listItemDocuments(fixture.users[role].id, fixture.household.id, fixture.item.id);
      expect(documentsListed.map((document) => document.id)).toContain(fixture.document.id);
    }
  });

  it("keeps its existing refusals for an outsider, a malformed id and an unknown id", async () => {
    const fixture = await createIntegrationFixture("documents-existing-refusals");
    const outsider = fixture.users.outsider.id;
    expect(await refusal(listItemDocuments(outsider, fixture.household.id, fixture.item.id))).toEqual(ITEM_UNAVAILABLE);
    expect(await refusal(listItemDocuments(fixture.users.member.id, fixture.household.id, randomUUID()))).toEqual(ITEM_UNAVAILABLE);
    expect(await refusal(listItemDocuments(fixture.users.member.id, fixture.secondHousehold.id, fixture.item.id))).toEqual(ITEM_UNAVAILABLE);
    expect(await refusal(readDocumentDownload(outsider, fixture.document.id))).toEqual(DOCUMENT_UNAVAILABLE);
    expect(await refusal(readDocumentDownload(fixture.users.member.id, "not-a-uuid"))).toEqual(DOCUMENT_UNAVAILABLE);
    expect(await refusal(readDocumentDownload(fixture.users.member.id, randomUUID()))).toEqual(DOCUMENT_UNAVAILABLE);
  });

  it("keeps refusing documents of a household waiting to be deleted", async () => {
    const fixture = await createIntegrationFixture("documents-pending-deletion");
    await getDb().update(households).set({ deletionRequestedAt: new Date(), deleteAfter: new Date(Date.now() + 86_400_000) }).where(eq(households.id, fixture.household.id));
    expect(await refusal(listItemDocuments(fixture.users.admin.id, fixture.household.id, fixture.item.id))).toEqual(ITEM_UNAVAILABLE);
    expect(await refusal(readDocumentDownload(fixture.users.admin.id, fixture.document.id))).toEqual(DOCUMENT_UNAVAILABLE);
  });

  it("refuses a disabled member from every document path", async () => {
    const fixture = await createIntegrationFixture("documents-disabled-member");
    await fixture.disableUser("member");
    const member = fixture.users.member.id;
    expect(await refusal(listItemDocuments(member, fixture.household.id, fixture.item.id))).toEqual(ITEM_UNAVAILABLE);
    expect(await refusal(readDocumentDownload(member, fixture.document.id))).toEqual(DOCUMENT_UNAVAILABLE);
  });

  it("refuses a disabled administrator from every document path", async () => {
    const fixture = await createIntegrationFixture("documents-disabled-admin");
    await fixture.disableUser("admin");
    const admin = fixture.users.admin.id;
    expect(await refusal(listItemDocuments(admin, fixture.household.id, fixture.item.id))).toEqual(ITEM_UNAVAILABLE);
    expect(await refusal(readDocumentDownload(admin, fixture.document.id))).toEqual(DOCUMENT_UNAVAILABLE);
  });
});

/**
 * #1316 (owner, 2026-10-14, question 13, answer 13a): while a household owner
 * imports into a household, only that household is closed. The start record an
 * import opens (portable_archive_imports) is the flag; it names the household
 * and the importer and lasts for as long as the import is active.
 */
describe("a household with an import in progress is closed to everyone but the importer (#1316, owner 2026-10-14)", () => {
  const CLOSED = {
    status: 409,
    code: "household_import_in_progress",
    message: "This household's owner is bringing in an archive. Come back when it's finished.",
  };
  const archivePassphrase = "correct-horse-battery-staple";
  type Fixture = Awaited<ReturnType<typeof createIntegrationFixture>>;
  type WorkspaceHousehold = Awaited<ReturnType<typeof readWorkspace>>["households"][number] & { importInProgress?: boolean };

  const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000);

  /** Writes the start record an import writes: this household, the importer, not finished. */
  async function openImport(
    fixture: Fixture,
    options: { actor: { id: string }; startedAt: Date; createdItemIds?: string[] },
  ): Promise<string> {
    const [row] = await getDb().insert(portableArchiveImports).values({
      householdId: fixture.household.id,
      actorUserId: options.actor.id,
      startedAt: options.startedAt,
      finishedAt: null,
      createdSectionIds: [],
      createdItemIds: options.createdItemIds ?? [],
    }).returning({ id: portableArchiveImports.id });
    return row.id;
  }

  async function closeAllImports(fixture: Fixture) {
    await getDb().delete(portableArchiveImports).where(eq(portableArchiveImports.householdId, fixture.household.id));
  }

  async function workspaceHousehold(fixture: Fixture, role: "owner" | "member" | "secondOwner", householdId: string): Promise<WorkspaceHousehold | undefined> {
    const session = await fixture.session(role);
    const workspace = await readWorkspace(fixture.users[role].id, session.sessionId);
    return workspace.households.find((household) => household.id === householdId) as WorkspaceHousehold | undefined;
  }

  it("refuses the member and an administrator with 409 household_import_in_progress and lets the importer through", async () => {
    const fixture = await createIntegrationFixture("gate-import-closed");
    await openImport(fixture, { actor: fixture.users.owner, startedAt: new Date() });
    try {
      expect(await refusal(requireHouseholdAccess(fixture.users.member.id, fixture.household.id))).toEqual(CLOSED);
      // An instance administrator is not exempt: the rule is about the household, not the role.
      expect(await refusal(requireHouseholdAccess(fixture.users.admin.id, fixture.household.id))).toEqual(CLOSED);
      await expect(requireHouseholdAccess(fixture.users.owner.id, fixture.household.id)).resolves.toBeUndefined();
    } finally {
      await closeAllImports(fixture);
    }
  });

  it("shows the member the household with importInProgress true and nothing in it, leaves the importer's view and the other household alone", async () => {
    const fixture = await createIntegrationFixture("gate-import-closed-workspace");
    const secondBefore = await workspaceHousehold(fixture, "secondOwner", fixture.secondHousehold.id);
    expect(secondBefore?.items.map((item) => item.id)).toContain(fixture.secondItem.id);
    await openImport(fixture, { actor: fixture.users.owner, startedAt: new Date() });
    try {
      const closed = await workspaceHousehold(fixture, "member", fixture.household.id);
      expect(closed, "the member still lists the household").toBeDefined();
      expect(closed!.importInProgress).toBe(true);
      expect(closed!.sections).toEqual([]);
      expect(closed!.items).toEqual([]);

      const importer = await workspaceHousehold(fixture, "owner", fixture.household.id);
      expect(importer!.items.map((item) => item.id)).toContain(fixture.item.id);

      // The other household is a different household: nothing about it changes.
      const secondAfter = await workspaceHousehold(fixture, "secondOwner", fixture.secondHousehold.id);
      expect(secondAfter).toEqual(secondBefore);
      expect(secondAfter!.importInProgress).not.toBe(true);
      await expect(requireHouseholdAccess(fixture.users.secondOwner.id, fixture.secondHousehold.id)).resolves.toBeUndefined();
    } finally {
      await closeAllImports(fixture);
    }
  });

  it("guard: opens again for the member once the start record is more than an hour old, so a stuck row cannot close a household for ever", async () => {
    const fixture = await createIntegrationFixture("gate-import-closed-lease");
    await openImport(fixture, { actor: fixture.users.owner, startedAt: minutesAgo(61) });
    try {
      await expect(requireHouseholdAccess(fixture.users.member.id, fixture.household.id)).resolves.toBeUndefined();
      const household = await workspaceHousehold(fixture, "member", fixture.household.id);
      expect(household!.importInProgress ?? false).toBe(false);
    } finally {
      await closeAllImports(fixture);
    }
  });

  it("guard: opens again for the member once the owner's import is finished", async () => {
    const fixture = await createIntegrationFixture("gate-import-closed-finished");
    const importId = await openImport(fixture, { actor: fixture.users.owner, startedAt: new Date() });
    await getDb().update(portableArchiveImports)
      .set({ finishedAt: new Date(), outcome: "completed" })
      .where(eq(portableArchiveImports.id, importId));
    try {
      await expect(requireHouseholdAccess(fixture.users.member.id, fixture.household.id)).resolves.toBeUndefined();
      const household = await workspaceHousehold(fixture, "member", fixture.household.id);
      expect(household!.importInProgress ?? false).toBe(false);
    } finally {
      await closeAllImports(fixture);
    }
  });

  it("stays closed while a rollback that must refuse to undo an edited item leaves the row open, and opens once the row is over an hour old", async () => {
    const fixture = await createIntegrationFixture("gate-import-closed-rollback");
    const importId = await openImport(fixture, {
      actor: fixture.users.owner,
      startedAt: minutesAgo(1),
      createdItemIds: [fixture.item.id],
    });
    // A member edited the item the import created: its version moved past 1 (P11's guard).
    await getDb().update(items).set({ version: 2 }).where(eq(items.id, fixture.item.id));
    try {
      await rollBackUnfinishedPortableImports();
      const [row] = await getDb().select().from(portableArchiveImports).where(eq(portableArchiveImports.id, importId));
      expect(row.finishedAt).toBeNull();
      expect(await refusal(requireHouseholdAccess(fixture.users.member.id, fixture.household.id))).toEqual(CLOSED);

      await getDb().update(portableArchiveImports).set({ startedAt: minutesAgo(61) }).where(eq(portableArchiveImports.id, importId));
      await expect(requireHouseholdAccess(fixture.users.member.id, fixture.household.id)).resolves.toBeUndefined();
    } finally {
      await closeAllImports(fixture);
    }
  });

  it("refuses a second import attempt into the closed household with the same 409 and opens no second record", async () => {
    const fixture = await createIntegrationFixture("gate-import-closed-second");
    await openImport(fixture, { actor: fixture.users.owner, startedAt: new Date() });
    const payload = {
      format: "orbit-portable-archive" as const,
      version: 1 as const,
      exportedAt: new Date().toISOString(),
      household: { name: "Imported household" },
      sections: [{ id: randomUUID(), slug: "second-attempt", name: "Second attempt", icon: "home", accent: "blue", position: 0, visible: true }],
      items: [],
      dueEvents: [],
      reminderRules: [],
      documents: [],
    };
    const archive = encryptPortableArchive(Buffer.from(JSON.stringify(payload)), archivePassphrase);
    try {
      expect(await refusal(importPortableArchive({
        userId: fixture.users.member.id,
        householdId: fixture.household.id,
        archive,
        passphrase: archivePassphrase,
        conflictItemIds: [],
      }))).toEqual(CLOSED);
      const rows = await getDb().select({ id: portableArchiveImports.id, finishedAt: portableArchiveImports.finishedAt })
        .from(portableArchiveImports).where(eq(portableArchiveImports.householdId, fixture.household.id));
      expect(rows).toHaveLength(1);
      expect(rows[0].finishedAt).toBeNull();
    } finally {
      await closeAllImports(fixture);
    }
  });
});
