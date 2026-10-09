import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { getDb } from "@/db";
import { households } from "@/db/schema";
import { AppError } from "@/lib/app-error";
import { createDocumentDraft } from "@/server/document-drafts";
import { listItemDocuments, readDocumentDownload } from "@/server/document-repository";
import { requirePortableArchiveAccess } from "@/server/portable-archive-repository";
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
  it("allows an owner to export, a member to import and an administrator both", async () => {
    const fixture = await createIntegrationFixture("archive-allowed");
    await requirePortableArchiveAccess(fixture.users.owner.id, fixture.household.id, "export");
    await requirePortableArchiveAccess(fixture.users.owner.id, fixture.household.id, "import");
    await requirePortableArchiveAccess(fixture.users.member.id, fixture.household.id, "import");
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
    expect(await refusal(createDocumentDraft(outsider, fixture.document.id))).toEqual(DOCUMENT_UNAVAILABLE);
    expect(await refusal(createDocumentDraft(fixture.users.member.id, "not-a-uuid"))).toEqual(DOCUMENT_UNAVAILABLE);
  });

  it("keeps refusing documents of a household waiting to be deleted", async () => {
    const fixture = await createIntegrationFixture("documents-pending-deletion");
    await getDb().update(households).set({ deletionRequestedAt: new Date(), deleteAfter: new Date(Date.now() + 86_400_000) }).where(eq(households.id, fixture.household.id));
    expect(await refusal(listItemDocuments(fixture.users.admin.id, fixture.household.id, fixture.item.id))).toEqual(ITEM_UNAVAILABLE);
    expect(await refusal(readDocumentDownload(fixture.users.admin.id, fixture.document.id))).toEqual(DOCUMENT_UNAVAILABLE);
    expect(await refusal(createDocumentDraft(fixture.users.admin.id, fixture.document.id))).toEqual(DOCUMENT_UNAVAILABLE);
  });

  it("refuses a disabled member from every document path", async () => {
    const fixture = await createIntegrationFixture("documents-disabled-member");
    await fixture.disableUser("member");
    const member = fixture.users.member.id;
    expect(await refusal(listItemDocuments(member, fixture.household.id, fixture.item.id))).toEqual(ITEM_UNAVAILABLE);
    expect(await refusal(readDocumentDownload(member, fixture.document.id))).toEqual(DOCUMENT_UNAVAILABLE);
    expect(await refusal(createDocumentDraft(member, fixture.document.id))).toEqual(DOCUMENT_UNAVAILABLE);
  });

  it("refuses a disabled administrator from every document path", async () => {
    const fixture = await createIntegrationFixture("documents-disabled-admin");
    await fixture.disableUser("admin");
    const admin = fixture.users.admin.id;
    expect(await refusal(listItemDocuments(admin, fixture.household.id, fixture.item.id))).toEqual(ITEM_UNAVAILABLE);
    expect(await refusal(readDocumentDownload(admin, fixture.document.id))).toEqual(DOCUMENT_UNAVAILABLE);
    expect(await refusal(createDocumentDraft(admin, fixture.document.id))).toEqual(DOCUMENT_UNAVAILABLE);
  });
});
