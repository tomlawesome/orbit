import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { items } from "@/db/schema";
import { expectApiError } from "./support/auth";
import { cleanupIntegrationEnvironment, createIntegrationFixture } from "./support/fixtures";
import { callRouteForSession, loadRoute } from "./support/request-event";

/**
 * #1463: items.importance, 'low' | 'normal' | 'high' or null (not set).
 *  - A CREATE (an item.upsert for an id with no row) must carry one: a missing
 *    or bad value gets 422 validation_failed, nothing is written.
 *  - An UPDATE accepts one of the three; one that doesn't mention it leaves it.
 *  - A row that was never given one (every existing item) reads back as null.
 * The pattern is item-lifecycle.test.ts: the real routes, a real database.
 */
const { GET: readWorkspace } = await loadRoute("workspace");
const { POST: applyWorkspaceCommand } = await loadRoute("workspace/commands");

afterAll(async () => {
  await cleanupIntegrationEnvironment();
});

type Fixture = Awaited<ReturnType<typeof createIntegrationFixture>>;
type Session = Awaited<ReturnType<Fixture["session"]>>;

const commandUrl = "http://127.0.0.1:3000/api/workspace/commands";
const workspaceUrl = "http://127.0.0.1:3000/api/workspace";

const post = (session: Session, body: unknown) =>
  callRouteForSession(applyWorkspaceCommand, session, {
    url: commandUrl, method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });

function newItem(fixture: Fixture, extra: Record<string, unknown> = {}) {
  return { id: randomUUID(), sectionId: fixture.section.id, title: "Importance proving", currency: "GBP", dueDate: "2026-12-20", version: 1, ...extra };
}

const create = (fixture: Fixture, session: Session, item: Record<string, unknown>) =>
  post(session, { type: "item.upsert", householdId: fixture.household.id, kind: "service", item });

/** The importance the workspace read gives an item, undefined when the item is not there. */
async function readImportance(fixture: Fixture, session: Session, id: string) {
  const reload = await callRouteForSession(readWorkspace, session, { url: workspaceUrl });
  expect(reload.status).toBe(200);
  const body = await reload.json() as { workspace: { households: Array<{ id: string; items: Array<{ id: string; importance?: string | null }> }> } };
  const household = body.workspace.households.find((one) => one.id === fixture.household.id)!;
  const found = household.items.find((one) => one.id === id);
  return found ? (found.importance ?? null) : undefined;
}

async function storedImportance(id: string) {
  const [row] = await getDb().select({ importance: items.importance }).from(items).where(eq(items.id, id));
  return row ? row.importance : undefined;
}

describe("creating an item needs an importance", () => {
  it("refuses a create that leaves it out with 422 validation_failed, and writes nothing", async () => {
    const fixture = await createIntegrationFixture("importance-create-missing");
    const owner = await fixture.session("owner");
    const item = newItem(fixture);
    await expectApiError(await create(fixture, owner, item), 422, "validation_failed");
    expect(await storedImportance(item.id as string)).toBeUndefined();
  });

  it("refuses a create that sends null with 422 validation_failed", async () => {
    const fixture = await createIntegrationFixture("importance-create-null");
    const owner = await fixture.session("owner");
    const item = newItem(fixture, { importance: null });
    await expectApiError(await create(fixture, owner, item), 422, "validation_failed");
    expect(await storedImportance(item.id as string)).toBeUndefined();
  });

  it.each(["urgent", "", "High", 2])("refuses a create with %j with 422 validation_failed", async (importance) => {
    const fixture = await createIntegrationFixture("importance-create-bad");
    const owner = await fixture.session("owner");
    const item = newItem(fixture, { importance });
    await expectApiError(await create(fixture, owner, item), 422, "validation_failed");
    expect(await storedImportance(item.id as string)).toBeUndefined();
  });

  it.each(["low", "normal", "high"])("stores %s and reads it back", async (importance) => {
    const fixture = await createIntegrationFixture(`importance-create-${importance}`);
    const owner = await fixture.session("owner");
    const item = newItem(fixture, { importance });
    const response = await create(fixture, owner, item);
    expect(response.status).toBe(200);
    expect(await storedImportance(item.id as string)).toBe(importance);
    expect(await readImportance(fixture, owner, item.id as string)).toBe(importance);
  });
});

describe("updating an item", () => {
  it("reads an existing row that was never given one back as null (not set)", async () => {
    const fixture = await createIntegrationFixture("importance-existing-null");
    const owner = await fixture.session("owner");
    expect(await storedImportance(fixture.item.id)).toBeNull();
    expect(await readImportance(fixture, owner, fixture.item.id)).toBeNull();
  });

  it("changes it when the update names one of the three", async () => {
    const fixture = await createIntegrationFixture("importance-update-sets");
    const owner = await fixture.session("owner");
    // an existing row (never given one) takes a level by update
    const response = await post(owner, {
      type: "item.upsert", householdId: fixture.household.id, kind: "service",
      item: { id: fixture.item.id, sectionId: fixture.section.id, title: "Boiler cover", currency: "GBP", dueDate: "2026-12-20", version: 2, importance: "low" },
    });
    expect(response.status).toBe(200);
    expect(await storedImportance(fixture.item.id)).toBe("low");
    expect(await readImportance(fixture, owner, fixture.item.id)).toBe("low");
  });

  it("leaves it as it was when the update does not mention it", async () => {
    const fixture = await createIntegrationFixture("importance-update-leaves");
    const owner = await fixture.session("owner");
    const base = { id: fixture.item.id, sectionId: fixture.section.id, title: "Boiler cover", currency: "GBP", dueDate: "2026-12-20" };
    const set = await post(owner, { type: "item.upsert", householdId: fixture.household.id, kind: "service", item: { ...base, version: 2, importance: "high" } });
    expect(set.status).toBe(200);
    const rename = await post(owner, { type: "item.upsert", householdId: fixture.household.id, kind: "service", item: { ...base, title: "Boiler cover, renamed", version: 3 } });
    expect(rename.status).toBe(200);
    expect(await storedImportance(fixture.item.id)).toBe("high");
    expect(await readImportance(fixture, owner, fixture.item.id)).toBe("high");
  });

  it("refuses an update with a value outside the three with 422 validation_failed, and leaves the item", async () => {
    const fixture = await createIntegrationFixture("importance-update-bad");
    const owner = await fixture.session("owner");
    const response = await post(owner, {
      type: "item.upsert", householdId: fixture.household.id, kind: "service",
      item: { id: fixture.item.id, sectionId: fixture.section.id, title: "Boiler cover", currency: "GBP", dueDate: "2026-12-20", version: 2, importance: "urgent" },
    });
    await expectApiError(response, 422, "validation_failed");
    expect(await storedImportance(fixture.item.id)).toBeNull();
  });

  it("does not require one: an existing item that was never given a level can be edited without picking", async () => {
    const fixture = await createIntegrationFixture("importance-update-not-required");
    const owner = await fixture.session("owner");
    const response = await post(owner, {
      type: "item.upsert", householdId: fixture.household.id, kind: "service",
      item: { id: fixture.item.id, sectionId: fixture.section.id, title: "Boiler cover, renamed", currency: "GBP", dueDate: "2026-12-20", version: 2 },
    });
    expect(response.status).toBe(200);
    expect(await storedImportance(fixture.item.id)).toBeNull();
  });
});
