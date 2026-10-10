import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { dueEvents, items } from "@/db/schema";
import { householdToday } from "@/lib/household-date";
import { cleanupIntegrationEnvironment, createIntegrationFixture } from "./support/fixtures";
import { callRouteForSession, loadRoute } from "./support/request-event";

/* #1337 (ADR-0034 decision 3, amended in place): the dry run of `item.complete`
   answers `200 { preview: { nextDate } }`: the date the real completion would
   then store, counted from the completion date as the engine counts it, not
   from the old due date. The household payload always carries `today`. */

const { GET: readWorkspace } = await loadRoute("workspace");
const { POST: applyWorkspaceCommand } = await loadRoute("workspace/commands");

afterAll(async () => {
  await cleanupIntegrationEnvironment();
});

const commandUrl = "http://127.0.0.1:3000/api/workspace/commands";
const workspaceUrl = "http://127.0.0.1:3000/api/workspace";
type Fixture = Awaited<ReturnType<typeof createIntegrationFixture>>;
type Session = Awaited<ReturnType<Fixture["session"]>>;

function send(session: Session, body: Record<string, unknown>) {
  return callRouteForSession(applyWorkspaceCommand, session, {
    url: commandUrl,
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function seed(fixture: Fixture, session: Session, dueDate: string, recurrenceMonths: number) {
  const response = await send(session, {
    type: "item.upsert",
    householdId: fixture.household.id,
    kind: "renewal",
    item: {
      id: fixture.item.id, sectionId: fixture.section.id, title: "Boiler cover", currency: "GBP",
      dueDate, recurrenceMonths, version: 2,
    },
    activity: { id: randomUUID(), itemId: fixture.item.id, occurredAt: new Date().toISOString() },
  });
  expect(response.status).toBe(200);
}

function completion(fixture: Fixture, completedDate: string) {
  return {
    type: "item.complete",
    householdId: fixture.household.id,
    itemId: fixture.item.id,
    expectedVersion: 2,
    completedDate,
    activity: { id: randomUUID(), itemId: fixture.item.id, occurredAt: new Date().toISOString(), effectiveDate: completedDate },
  };
}

async function stored(fixture: Fixture) {
  const db = getDb();
  const [item] = await db.select().from(items).where(eq(items.id, fixture.item.id));
  const events = await db.select().from(dueEvents).where(eq(dueEvents.itemId, fixture.item.id));
  return { item, events, audits: await fixture.auditCount(fixture.item.id) };
}

describe("the completion preview", () => {
  it("equals the next date the real completion then stores, after a late completion", async () => {
    const fixture = await createIntegrationFixture("completion-preview-late");
    const owner = await fixture.session("owner");
    await seed(fixture, owner, "2026-12-20", 12);
    // Done seven weeks late: the engine counts a year from the day it was done.
    const command = completion(fixture, "2027-02-07");

    const dry = await send(owner, { ...command, dryRun: true });
    expect(dry.status).toBe(200);
    expect(dry.headers.get("cache-control")).toBe("no-store");
    const body = await dry.json() as { preview?: { nextDate?: string } };
    expect(body).toEqual({ preview: { nextDate: "2028-02-07" } });
    // Not the old due date plus a year, which is what the browser used to show.
    expect(body.preview?.nextDate).not.toBe("2027-12-20");

    const real = await send(owner, { ...command, activity: { ...command.activity, id: randomUUID() } });
    expect(real.status).toBe(200);
    const after = await stored(fixture);
    const open = after.events.filter((event) => event.completedAt == null);
    expect(open).toHaveLength(1);
    expect(open[0].dueDate).toBe(body.preview?.nextDate);
    expect(after.item.renewalDate).toBe(body.preview?.nextDate);
  });

  it("clamps a month end the way the real completion does", async () => {
    const fixture = await createIntegrationFixture("completion-preview-clamp");
    const owner = await fixture.session("owner");
    await seed(fixture, owner, "2026-12-20", 1);
    const command = completion(fixture, "2027-01-31");

    const dry = await send(owner, { ...command, dryRun: true });
    expect(dry.status).toBe(200);
    const preview = (await dry.json() as { preview: { nextDate: string } }).preview.nextDate;

    expect((await send(owner, { ...command, activity: { ...command.activity, id: randomUUID() } })).status).toBe(200);
    const after = await stored(fixture);
    expect(after.events.find((event) => event.completedAt == null)?.dueDate).toBe(preview);
    expect(preview).toBe("2027-02-28");
  });

  it("writes nothing", async () => {
    const fixture = await createIntegrationFixture("completion-preview-writes-nothing");
    const owner = await fixture.session("owner");
    await seed(fixture, owner, "2026-12-20", 12);
    const before = await stored(fixture);

    const dry = await send(owner, { ...completion(fixture, "2027-02-07"), dryRun: true });
    expect(dry.status).toBe(200);
    expect(await stored(fixture)).toEqual(before);
  });

  it("still refuses in the member's words, as a 200 verdict, with no preview", async () => {
    const fixture = await createIntegrationFixture("completion-preview-refuses");
    const owner = await fixture.session("owner");
    await seed(fixture, owner, "2026-12-20", 12);

    const dry = await send(owner, { ...completion(fixture, "2027-02-07"), expectedVersion: 7, dryRun: true });
    expect(dry.status).toBe(200);
    const body = await dry.json() as Record<string, unknown>;
    expect(body.refusal).toMatchObject({ code: "version_conflict" });
    expect(body).not.toHaveProperty("preview");
  });
});

describe("the household's today (#1337)", () => {
  it("is on every household the workspace read and a command answer carry", async () => {
    const fixture = await createIntegrationFixture("household-today-always");
    const owner = await fixture.session("owner");
    await seed(fixture, owner, "2026-12-20", 12);

    type Payload = { workspace: { households: Array<{ timezone: string; today?: string }> } };
    const read = await callRouteForSession(readWorkspace, owner, { url: workspaceUrl, method: "GET" });
    expect(read.status).toBe(200);
    const households = (await read.json() as Payload).workspace.households;
    expect(households.length).toBeGreaterThan(0);
    for (const household of households) {
      expect(household.today).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(household.today).toBe(householdToday(household.timezone));
    }

    const answered = await send(owner, completion(fixture, "2027-02-07"));
    expect(answered.status).toBe(200);
    for (const household of (await answered.json() as Payload).workspace.households) {
      expect(household.today).toBe(householdToday(household.timezone));
    }
  });
});
