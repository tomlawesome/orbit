import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { and, eq, isNull } from "drizzle-orm";
import { getDb } from "@/db";
import { dueEvents, items } from "@/db/schema";
import type { WorkspaceState } from "@/lib/workspace";
import { readWorkspace } from "@/server/workspace-repository";
import { cleanupIntegrationEnvironment, createIntegrationFixture, encryptedItemColumns } from "./support/fixtures";
import { callRouteForSession, loadRoute } from "./support/request-event";

/**
 * ADR-0043 (#1466 note 53014, #1468 Part B): an item has no type. The
 * command carries a date and a repeat and nothing names a kind; the engine
 * gives a dated new item the `renewal` schedule kind and a dateless one no
 * schedule; an edit keeps the stored schedule kind; `kind` is accepted and
 * ignored for one release; the read payload carries no `kind`; and existing
 * rows read back unchanged, with no migration.
 */

const { GET: readWorkspaceRoute } = await loadRoute("workspace");
const { POST: applyWorkspaceCommand } = await loadRoute("workspace/commands");
const workspaceUrl = "http://127.0.0.1:3000/api/workspace";
const commandUrl = "http://127.0.0.1:3000/api/workspace/commands";

afterAll(async () => {
  await cleanupIntegrationEnvironment();
});

type Fixture = Awaited<ReturnType<typeof createIntegrationFixture>>;
type Session = Awaited<ReturnType<Fixture["session"]>>;
type PayloadItem = WorkspaceState["households"][number]["items"][number];

function send(session: Session, body: Record<string, unknown>) {
  return callRouteForSession(applyWorkspaceCommand, session, {
    url: commandUrl, method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
}

/** A brand-new item's upsert: a fresh id, no version, and no kind unless the case adds one. */
function create(fixture: Fixture, id: string, item: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) {
  return {
    type: "item.upsert",
    householdId: fixture.household.id,
    item: { id, sectionId: fixture.section.id, title: "Boiler cover", currency: "GBP", importance: "normal", ...item },
    activity: { id: randomUUID(), itemId: id, occurredAt: new Date().toISOString() },
    ...extra,
  };
}

const rowOf = async (id: string) => (await getDb().select().from(items).where(eq(items.id, id)))[0];
const openEvents = (id: string) => getDb().select().from(dueEvents).where(and(eq(dueEvents.itemId, id), isNull(dueEvents.completedAt)));

async function payloadItem(session: Session, fixture: Fixture, id: string): Promise<PayloadItem | undefined> {
  const response = await callRouteForSession(readWorkspaceRoute, session, { url: workspaceUrl });
  expect(response.status).toBe(200);
  const body = await response.json() as { workspace: WorkspaceState };
  return body.workspace.households.find((entry) => entry.id === fixture.household.id)?.items.find((entry) => entry.id === id);
}

describe("a new item: its schedule follows from its date and its repeat", () => {
  it("with a date and every 12 months is a renewal that repeats, with no subtype", async () => {
    const fixture = await createIntegrationFixture("no-type-new-repeat");
    const owner = await fixture.session("owner");
    const id = randomUUID();
    const response = await send(owner, create(fixture, id, { dueDate: "2026-12-20", recurrenceMonths: 12 }));
    expect(response.status).toBe(200);

    const row = await rowOf(id);
    expect(row.renewalDate).toBe("2026-12-20");
    expect(row.serviceDate).toBeNull();
    expect(row.expiryDate).toBeNull();
    expect(row.recurrenceMonths).toBe(12);
    expect(row.subtype).toBeNull();
    const events = await openEvents(id);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: "renewal", dueDate: "2026-12-20" });

    const read = await payloadItem(owner, fixture, id);
    expect(read).toMatchObject({ scheduleKind: "renewal", dueDate: "2026-12-20", recurrenceMonths: 12 });
    await fixture.cleanup();
  });

  it("with a date and a repeat of 0 is a renewal that happens once", async () => {
    const fixture = await createIntegrationFixture("no-type-new-once");
    const owner = await fixture.session("owner");
    const id = randomUUID();
    expect((await send(owner, create(fixture, id, { dueDate: "2026-12-20", recurrenceMonths: 0 }))).status).toBe(200);
    const row = await rowOf(id);
    expect(row.renewalDate).toBe("2026-12-20");
    expect(row.recurrenceMonths).toBeNull();
    expect(row.subtype).toBeNull();
    expect((await openEvents(id)).map((event) => event.kind)).toEqual(["renewal"]);
    await fixture.cleanup();
  });

  it("with no date has no schedule, no event and no repeat, and reads back dateless", async () => {
    const fixture = await createIntegrationFixture("no-type-new-dateless");
    const owner = await fixture.session("owner");
    const id = randomUUID();
    expect((await send(owner, create(fixture, id))).status).toBe(200);
    const row = await rowOf(id);
    expect([row.renewalDate, row.serviceDate, row.expiryDate, row.recurrenceMonths, row.subtype]).toEqual([null, null, null, null, null]);
    expect(await openEvents(id)).toHaveLength(0);
    const read = await payloadItem(owner, fixture, id);
    expect(read).toBeDefined();
    expect(read?.dueDate).toBeUndefined();
    expect(read?.scheduleKind).toBeUndefined();
    expect(read?.recurrenceMonths).toBeUndefined();
    await fixture.cleanup();
  });

  it("with no date and a repeat is refused 422 repeat_needs_date, and nothing is written", async () => {
    const fixture = await createIntegrationFixture("no-type-new-repeat-no-date");
    const owner = await fixture.session("owner");
    const id = randomUUID();
    const response = await send(owner, create(fixture, id, { recurrenceMonths: 12 }));
    expect(response.status).toBe(422);
    expect(JSON.stringify(await response.json())).toContain("repeat_needs_date");
    expect(await rowOf(id)).toBeUndefined();
    await fixture.cleanup();
  });

  it("sending no kind is a 200 and never item_kind_missing", async () => {
    const fixture = await createIntegrationFixture("no-type-no-kind");
    const owner = await fixture.session("owner");
    for (const item of [{}, { dueDate: "2026-12-20" }, { dueDate: "2026-12-20", recurrenceMonths: 12 }]) {
      const response = await send(owner, create(fixture, randomUUID(), item));
      expect(response.status).toBe(200);
      expect(JSON.stringify(await response.json())).not.toContain("item_kind_missing");
    }
    await fixture.cleanup();
  });
});

describe("compatibility: an older cached bundle's command saves as if it had sent no kind", () => {
  it("saves kind inspection with a date exactly as if it were absent", async () => {
    const fixture = await createIntegrationFixture("no-type-compat-kind");
    const owner = await fixture.session("owner");
    const withKind = randomUUID();
    const without = randomUUID();
    const item = { dueDate: "2026-12-20", recurrenceMonths: 12 };
    expect((await send(owner, create(fixture, withKind, item, { kind: "inspection" }))).status).toBe(200);
    expect((await send(owner, create(fixture, without, item))).status).toBe(200);

    const a = await rowOf(withKind);
    const b = await rowOf(without);
    expect(a.subtype).toBeNull();
    expect([a.renewalDate, a.serviceDate, a.expiryDate, a.recurrenceMonths]).toEqual([b.renewalDate, null, null, b.recurrenceMonths]);
    expect(a.renewalDate).toBe("2026-12-20");
    expect((await openEvents(withKind)).map((event) => event.kind)).toEqual(["renewal"]);
    const read = await payloadItem(owner, fixture, withKind);
    expect(read?.scheduleKind).toBe("renewal");
    expect(read?.subtype).toBeUndefined();
    await fixture.cleanup();
  });

  it("saves kind document with a date as a renewal too (it can no longer make an expiry)", async () => {
    const fixture = await createIntegrationFixture("no-type-compat-document");
    const owner = await fixture.session("owner");
    const id = randomUUID();
    expect((await send(owner, create(fixture, id, { dueDate: "2026-12-20" }, { kind: "document" }))).status).toBe(200);
    const row = await rowOf(id);
    expect([row.renewalDate, row.expiryDate, row.subtype]).toEqual(["2026-12-20", null, null]);
    await fixture.cleanup();
  });

  it("saves kind suggestion with no date as an unscheduled item with no subtype", async () => {
    const fixture = await createIntegrationFixture("no-type-compat-suggestion");
    const owner = await fixture.session("owner");
    const id = randomUUID();
    expect((await send(owner, create(fixture, id, {}, { kind: "suggestion" }))).status).toBe(200);
    expect((await rowOf(id)).subtype).toBeNull();
    await fixture.cleanup();
  });

  it("still refuses a kind on the item itself with 400", async () => {
    const fixture = await createIntegrationFixture("no-type-kind-on-item");
    const owner = await fixture.session("owner");
    const id = randomUUID();
    const response = await send(owner, create(fixture, id, { kind: "inspection" }));
    expect(response.status).toBe(400);
    expect(await rowOf(id)).toBeUndefined();
    await fixture.cleanup();
  });

  it.each(["scheduleKind", "subtype", "status"])("still refuses %s on the item with 400 and the new wording", async (field) => {
    const fixture = await createIntegrationFixture(`no-type-derived-${field}`);
    const owner = await fixture.session("owner");
    const response = await send(owner, create(fixture, randomUUID(), { [field]: field === "status" ? "active" : "service" }));
    expect(response.status).toBe(400);
    const text = JSON.stringify(await response.json());
    expect(text).toContain("from the date and the repeat");
    expect(text).not.toContain("from the kind");
    await fixture.cleanup();
  });
});

/** A stored row as a v0.3.6 household left it: a subtype marker word, one date column, one open event. */
async function seedStored(fixture: Fixture, row: { subtype: string | null; column: "serviceDate" | "renewalDate" | "expiryDate"; eventKind: "service" | "renewal" | "expiry"; recurrenceMonths?: number }) {
  const db = getDb();
  const id = randomUUID();
  await db.insert(items).values({
    id,
    householdId: fixture.household.id,
    sectionId: fixture.section.id,
    subtype: row.subtype,
    ...await encryptedItemColumns(fixture.household.id, id, { title: "Stored item" }),
    currency: "GBP",
    [row.column]: "2026-12-01",
    recurrenceMonths: row.recurrenceMonths ?? null,
    status: "active",
  });
  await db.insert(dueEvents).values({ householdId: fixture.household.id, itemId: id, kind: row.eventKind, dueDate: "2026-12-01" });
  return id;
}

describe("an edit keeps the stored schedule kind", () => {
  it("keeps a stored service item (inspection) a service, with its subtype and service date, and its completion is a service_completed", async () => {
    const fixture = await createIntegrationFixture("no-type-edit-service");
    const owner = await fixture.session("owner");
    const id = await seedStored(fixture, { subtype: "inspection", column: "serviceDate", eventKind: "service", recurrenceMonths: 12 });

    const edit = await send(owner, create(fixture, id, { dueDate: "2027-03-01", recurrenceMonths: 6, version: 2 }));
    expect(edit.status).toBe(200);
    const row = await rowOf(id);
    expect(row.subtype).toBe("inspection");
    expect(row.serviceDate).toBe("2027-03-01");
    expect(row.renewalDate).toBeNull();
    expect(row.recurrenceMonths).toBe(6);
    expect((await openEvents(id)).map((event) => [event.kind, event.dueDate])).toEqual([["service", "2027-03-01"]]);

    const activityId = randomUUID();
    const done = await send(owner, {
      type: "item.complete", householdId: fixture.household.id, itemId: id, expectedVersion: 2, completedDate: "2027-03-01",
      activity: { id: activityId, itemId: id, occurredAt: new Date().toISOString(), effectiveDate: "2027-03-01" },
    });
    expect(done.status).toBe(200);
    const body = await done.json() as { workspace: WorkspaceState };
    const recorded = body.workspace.households.flatMap((household) => household.activities).find((entry) => entry.id === activityId);
    expect(recorded?.kind).toBe("service_completed");
    await fixture.cleanup();
  });

  it("keeps a stored expiry an expiry and still refuses a repeat on it", async () => {
    const fixture = await createIntegrationFixture("no-type-edit-expiry");
    const owner = await fixture.session("owner");
    const id = await seedStored(fixture, { subtype: "Passport", column: "expiryDate", eventKind: "expiry" });

    const dated = await send(owner, create(fixture, id, { dueDate: "2027-05-01", version: 2 }));
    expect(dated.status).toBe(200);
    const row = await rowOf(id);
    expect([row.expiryDate, row.renewalDate, row.serviceDate, row.subtype]).toEqual(["2027-05-01", null, null, "Passport"]);
    expect((await openEvents(id)).map((event) => event.kind)).toEqual(["expiry"]);

    const repeated = await send(owner, create(fixture, id, { dueDate: "2027-05-01", recurrenceMonths: 12, version: 3 }));
    expect(repeated.status).toBeGreaterThanOrEqual(400);
    expect(JSON.stringify(await repeated.json())).toContain("An expiry happens once");
    expect((await rowOf(id)).recurrenceMonths).toBeNull();
    await fixture.cleanup();
  });

  it("gives a dateless item a renewal when it is given a date", async () => {
    const fixture = await createIntegrationFixture("no-type-edit-dateless");
    const owner = await fixture.session("owner");
    const id = randomUUID();
    expect((await send(owner, create(fixture, id))).status).toBe(200);
    const edit = await send(owner, create(fixture, id, { dueDate: "2027-01-15", recurrenceMonths: 12, version: 2 }));
    expect(edit.status).toBe(200);
    const row = await rowOf(id);
    expect([row.renewalDate, row.recurrenceMonths, row.subtype]).toEqual(["2027-01-15", 12, null]);
    expect((await openEvents(id)).map((event) => event.kind)).toEqual(["renewal"]);
    await fixture.cleanup();
  });
});

describe("the dry run answers the four new-item cases as the real call does", () => {
  const cases = [
    ["a date and every 12 months", { dueDate: "2026-12-20", recurrenceMonths: 12 }, null],
    ["a date and once", { dueDate: "2026-12-20", recurrenceMonths: 0 }, null],
    ["no date", {}, null],
    ["no date and a repeat", { recurrenceMonths: 12 }, "repeat_needs_date"],
  ] as const;

  it.each(cases)("%s", async (_label, item, refusal) => {
    const fixture = await createIntegrationFixture("no-type-dry-run");
    const owner = await fixture.session("owner");
    const id = randomUUID();
    const dry = await send(owner, { ...create(fixture, id, item), dryRun: true });
    expect(dry.status).toBe(200);
    const verdict = await dry.json() as { refusal?: { code: string } };
    if (refusal) expect(verdict.refusal?.code).toBe(refusal);
    else expect(verdict).toEqual({});
    expect(await rowOf(id)).toBeUndefined();
    const real = await send(owner, create(fixture, id, item));
    expect(real.status).toBe(refusal ? 422 : 200);
    await fixture.cleanup();
  });
});

describe("existing rows read back unchanged, with no kind key", () => {
  it("a v0.3.6 row (subtype inspection, an open service event) keeps its schedule, dates, days and reminders", async () => {
    const fixture = await createIntegrationFixture("no-type-existing-row");
    const owner = await fixture.session("owner");
    const id = await seedStored(fixture, { subtype: "inspection", column: "serviceDate", eventKind: "service", recurrenceMonths: 12 });
    const session = await fixture.session("member");
    const workspace = await readWorkspace(fixture.users.member.id, session.sessionId);
    const read = workspace.households.find((entry) => entry.id === fixture.household.id)?.items.find((entry) => entry.id === id);
    expect(read).toMatchObject({ subtype: "inspection", scheduleKind: "service", dueDate: "2026-12-01", recurrenceMonths: 12, status: "active" });
    expect(read).not.toHaveProperty("kind");

    const wire = await payloadItem(owner, fixture, id);
    expect(wire).toMatchObject({ subtype: "inspection", scheduleKind: "service", dueDate: "2026-12-01" });
    expect(wire).not.toHaveProperty("kind");
    await fixture.cleanup();
  });

  it("no item in the payload has a kind key, whatever its subtype or schedule", async () => {
    const fixture = await createIntegrationFixture("no-type-no-kind-key");
    const owner = await fixture.session("owner");
    for (const row of [
      { subtype: "document", column: "expiryDate", eventKind: "expiry" },
      { subtype: "suggestion", column: "renewalDate", eventKind: "renewal" },
      { subtype: null, column: "renewalDate", eventKind: "renewal" },
    ] as const) await seedStored(fixture, row);
    const response = await callRouteForSession(readWorkspaceRoute, owner, { url: workspaceUrl });
    const body = await response.json() as { workspace: WorkspaceState };
    const all = body.workspace.households.find((entry) => entry.id === fixture.household.id)?.items ?? [];
    expect(all.length).toBeGreaterThanOrEqual(3);
    for (const item of all) expect(item).not.toHaveProperty("kind");
    await fixture.cleanup();
  });

  it("adds no migration that nulls the marker words (that contract step is v0.3.8's)", () => {
    const dir = join(process.cwd(), "drizzle");
    for (const name of readdirSync(dir).filter((file) => file.endsWith(".sql"))) {
      expect(readFileSync(join(dir, name), "utf8"), name).not.toMatch(/subtype\s*=\s*null/iu);
    }
    const journal = JSON.parse(readFileSync(join(dir, "meta/_journal.json"), "utf8")) as { entries: { tag: string }[] };
    expect(journal.entries.map((entry) => entry.tag)).not.toContainEqual(expect.stringMatching(/subtype|marker|kind/iu));
  });
});
