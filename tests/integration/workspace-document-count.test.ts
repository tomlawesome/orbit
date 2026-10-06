import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { getDb } from "@/db";
import { documents, items } from "@/db/schema";
import { readWorkspace } from "@/server/workspace-repository";
import type { WorkspaceState } from "@/lib/workspace";
import { cleanupIntegrationEnvironment, createIntegrationFixture } from "./support/fixtures";

/**
 * `readWorkspace` never computed `documentCount` (#1091): items always came
 * back without the field, so `readBelt`'s `(item.documentCount ?? 0) > 0`
 * filter was always false for a real household and no document ever reached
 * the belt. Only the demo fixtures hand-wrote the field, which is why
 * nothing that exercised only fixtures noticed.
 */

afterAll(async () => {
  await cleanupIntegrationEnvironment();
});

type Fixture = Awaited<ReturnType<typeof createIntegrationFixture>>;

async function workspaceFor(fixture: Fixture): Promise<WorkspaceState> {
  const session = await fixture.session("member");
  return readWorkspace(fixture.users.member.id, session.sessionId);
}

function itemIn(workspace: WorkspaceState, fixture: Fixture, itemId: string) {
  const household = workspace.households.find((entry) => entry.id === fixture.household.id);
  return household?.items.find((entry) => entry.id === itemId);
}

describe("workspace document counts (#1091)", () => {
  it("counts a real household's listable document against its item", async () => {
    const fixture = await createIntegrationFixture("document-count-basic");
    // The fixture itself seats one document in lifecycle "available" (a
    // listable lifecycle) against fixture.item -- exactly the case that was
    // never computed.
    const workspace = await workspaceFor(fixture);
    expect(itemIn(workspace, fixture, fixture.item.id)?.documentCount).toBe(1);
    await fixture.cleanup();
  });

  it("gives an item with no documents a count of zero, not undefined", async () => {
    const fixture = await createIntegrationFixture("document-count-zero");
    const db = getDb();
    const [bareItem] = await db.insert(items).values({
      householdId: fixture.household.id,
      sectionId: fixture.section.id,
      title: "No documents yet",
      currency: "GBP",
    }).returning({ id: items.id });

    const workspace = await workspaceFor(fixture);
    expect(itemIn(workspace, fixture, bareItem.id)?.documentCount).toBe(0);
    await fixture.cleanup();
  });

  it("does not count a document in a non-listable lifecycle", async () => {
    const fixture = await createIntegrationFixture("document-count-lifecycle");
    const db = getDb();
    await db.insert(documents).values({
      householdId: fixture.household.id,
      itemId: fixture.item.id,
      uploadedByUserId: fixture.users.member.id,
      displayName: "purged.pdf",
      mediaType: "application/pdf",
      sizeBytes: 64,
      contentSha256: randomUUID().replaceAll("-", ""),
      lifecycle: "deleted",
      scanStatus: "skipped",
    });

    const workspace = await workspaceFor(fixture);
    // The fixture's own document is still there in "available"; the
    // "deleted" one just inserted must not add to it.
    expect(itemIn(workspace, fixture, fixture.item.id)?.documentCount).toBe(1);
    await fixture.cleanup();
  });

  it("gives two items in one household their own counts, not each other's", async () => {
    const fixture = await createIntegrationFixture("document-count-separate");
    const db = getDb();
    const [secondItem] = await db.insert(items).values({
      householdId: fixture.household.id,
      sectionId: fixture.section.id,
      title: "Second item, same household",
      currency: "GBP",
    }).returning({ id: items.id });
    await db.insert(documents).values([
      {
        householdId: fixture.household.id,
        itemId: secondItem.id,
        uploadedByUserId: fixture.users.member.id,
        displayName: "one.pdf",
        mediaType: "application/pdf",
        sizeBytes: 64,
        contentSha256: randomUUID().replaceAll("-", ""),
        lifecycle: "available",
        scanStatus: "skipped",
        availableAt: new Date(),
      },
      {
        householdId: fixture.household.id,
        itemId: secondItem.id,
        uploadedByUserId: fixture.users.member.id,
        displayName: "two.pdf",
        mediaType: "application/pdf",
        sizeBytes: 64,
        contentSha256: randomUUID().replaceAll("-", ""),
        lifecycle: "available",
        scanStatus: "skipped",
        availableAt: new Date(),
      },
    ]);

    const workspace = await workspaceFor(fixture);
    expect(itemIn(workspace, fixture, fixture.item.id)?.documentCount).toBe(1);
    expect(itemIn(workspace, fixture, secondItem.id)?.documentCount).toBe(2);
    await fixture.cleanup();
  });
});
