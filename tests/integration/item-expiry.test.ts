import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { and, eq, isNull } from "drizzle-orm";
import { getDb } from "@/db";
import { auditLog, dueEvents, items, reminderRules } from "@/db/schema";
import { sweepEndedExpiries } from "@/server/notification-worker";
import { cleanupIntegrationEnvironment, createIntegrationFixture, encryptedItemColumns } from "./support/fixtures";
import { callRouteForSession, loadRoute } from "./support/request-event";

/**
 * ADR-0043 (#1466, #1468 Part B): a member's Add can no longer make an
 * expiry (an item has no type; a dated new item is a renewal). An expiry now
 * comes from a stored row (what mail intake files, from the document's date
 * role) and an edit keeps it. These cases seed that row directly, the way
 * reviewed intake leaves it.
 *
 * One-off expirations end (#1005): they store their date in `items.expiry_date`,
 * carry a due event of kind `expiry`, refuse a next date on completion, and a
 * fortnight after the day itself the worker's daily sweep turns them `expired`.
 */

const { GET: readWorkspace } = await loadRoute("workspace");
const { POST: applyWorkspaceCommand } = await loadRoute("workspace/commands");

afterAll(async () => {
  await cleanupIntegrationEnvironment();
});

const commandUrl = "http://127.0.0.1:3000/api/workspace/commands";
const workspaceUrl = "http://127.0.0.1:3000/api/workspace";

type Fixture = Awaited<ReturnType<typeof createIntegrationFixture>>;
type Session = Awaited<ReturnType<Fixture["session"]>>;

function expiryItem(fixture: Fixture, version: number, over: Record<string, unknown> = {}) {
  return {
    id: fixture.item.id,
    sectionId: fixture.section.id,
    title: "Cavity wall guarantee",
    currency: "GBP",
    costMinor: 14_900,
    importance: "normal",
    dueDate: "2026-12-20",
    reminderDays: [30, 7],
    version,
    updatedAt: new Date().toISOString(),
    ...over,
  };
}

/** An edit of an item, as the drawer sends it: a date and a repeat, no kind. */
async function save(fixture: Fixture, session: Session, item: Record<string, unknown>) {
  return callRouteForSession(applyWorkspaceCommand, session, {
    url: commandUrl,
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      type: "item.upsert",
      householdId: fixture.household.id,
      item,
      activity: { id: randomUUID(), itemId: String(item.id), occurredAt: new Date().toISOString() },
    }),
  });
}

/** Makes the fixture's own item an expiry, as mail intake files one: the date in expiry_date, an open expiry event, two reminders. */
async function makeExpiry(itemId: string, householdId: string, dueDate = "2026-12-20") {
  const db = getDb();
  await db.update(items).set({ expiryDate: dueDate, renewalDate: null, serviceDate: null, recurrenceMonths: null }).where(eq(items.id, itemId));
  await db.insert(dueEvents).values({ householdId, itemId, kind: "expiry", dueDate });
  await db.insert(reminderRules).values([{ itemId, daysBefore: 30 }, { itemId, daysBefore: 7 }]);
}

/** A second, stored expiry in the fixture's household. */
async function seedExpiry(fixture: Fixture, dueDate: string) {
  const db = getDb();
  const id = randomUUID();
  await db.insert(items).values({
    id,
    householdId: fixture.household.id,
    sectionId: fixture.section.id,
    ...await encryptedItemColumns(fixture.household.id, id, { title: "Appliance warranty" }),
    currency: "GBP",
    expiryDate: dueDate,
    status: "active",
  });
  await db.insert(dueEvents).values({ householdId: fixture.household.id, itemId: id, kind: "expiry", dueDate });
  await db.insert(reminderRules).values([{ itemId: id, daysBefore: 30 }, { itemId: id, daysBefore: 7 }]);
  return id;
}

describe("one-off expirations", () => {
  it("keeps the date in its own column with a due event of its own kind, and an edit keeps both", async () => {
    const fixture = await createIntegrationFixture("expiry-save");
    const owner = await fixture.session("owner");
    await makeExpiry(fixture.item.id, fixture.household.id, "2026-11-30");
    expect((await save(fixture, owner, expiryItem(fixture, 2))).status).toBe(200);

    const db = getDb();
    const [row] = await db.select().from(items).where(eq(items.id, fixture.item.id));
    expect(row.expiryDate).toBe("2026-12-20");
    expect(row.renewalDate).toBe(null);
    expect(row.serviceDate).toBe(null);
    expect(row.recurrenceMonths).toBe(null);

    const open = await db.select().from(dueEvents).where(and(eq(dueEvents.itemId, fixture.item.id), isNull(dueEvents.completedAt)));
    expect(open.map((event) => [event.kind, event.dueDate])).toEqual([["expiry", "2026-12-20"]]);

    // And the read maps it straight back, so every screen sees one kind.
    const reload = await callRouteForSession(readWorkspace, owner, { url: workspaceUrl });
    const body = await reload.json() as {
      workspace: { households: Array<{ items: Array<Record<string, unknown>> }> };
    };
    expect(body.workspace.households[0].items).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: fixture.item.id, scheduleKind: "expiry", dueDate: "2026-12-20" }),
    ]));
    await fixture.cleanup();
  });

  it("refuses a repeat on something that happens once, and stores none", async () => {
    const fixture = await createIntegrationFixture("expiry-recurrence");
    const owner = await fixture.session("owner");
    await makeExpiry(fixture.item.id, fixture.household.id);
    const response = await save(fixture, owner, expiryItem(fixture, 2, { recurrenceMonths: 12 }));
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(JSON.stringify(await response.json())).toContain("An expiry happens once");
    const [row] = await getDb().select().from(items).where(eq(items.id, fixture.item.id));
    expect(row.recurrenceMonths).toBe(null);
    await fixture.cleanup();
  });

  it("refuses a next date when an expiry is completed", async () => {
    const fixture = await createIntegrationFixture("expiry-complete");
    const owner = await fixture.session("owner");
    await makeExpiry(fixture.item.id, fixture.household.id);
    expect((await save(fixture, owner, expiryItem(fixture, 2))).status).toBe(200);

    const completion = {
      type: "item.complete",
      householdId: fixture.household.id,
      itemId: fixture.item.id,
      expectedVersion: 2,
      completedDate: "2026-12-20",
      nextDate: "2027-12-20",
      activity: {
        id: randomUUID(),
        itemId: fixture.item.id,
        occurredAt: new Date().toISOString(),
        effectiveDate: "2026-12-20",
        nextDate: "2027-12-20",
      },
    };
    const refused = await callRouteForSession(applyWorkspaceCommand, owner, {
      url: commandUrl,
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(completion),
    });
    expect(refused.status).toBe(400);
    expect((await refused.json() as { error: { code: string } }).error.code).toBe("invalid_command");

    // Without the next date the same completion is accepted.
    const accepted = await callRouteForSession(applyWorkspaceCommand, owner, {
      url: commandUrl,
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...completion,
        nextDate: undefined,
        activity: { ...completion.activity, id: randomUUID(), nextDate: undefined },
      }),
    });
    expect(accepted.status).toBe(200);
    await fixture.cleanup();
  });

  it("ends an expiry a fortnight after its date, and leaves one still inside the linger", async () => {
    const fixture = await createIntegrationFixture("expiry-sweep");
    const owner = await fixture.session("owner");
    const db = getDb();
    const now = new Date("2027-01-10T09:00:00Z");

    // 2026-12-20 is 21 days behind `now`; 2027-01-05 is 5 days behind it.
    await makeExpiry(fixture.item.id, fixture.household.id, "2026-12-20");
    const lingeringId = await seedExpiry(fixture, "2027-01-05");

    expect(await sweepEndedExpiries(db, now)).toBe(1);

    const [ended] = await db.select().from(items).where(eq(items.id, fixture.item.id));
    expect(ended.status).toBe("expired");
    const [lingering] = await db.select().from(items).where(eq(items.id, lingeringId));
    expect(lingering.status).toBe("active");

    // Its event is closed with no successor, and its reminders go with it.
    const open = await db.select().from(dueEvents).where(and(
      eq(dueEvents.itemId, fixture.item.id),
      isNull(dueEvents.completedAt),
    ));
    expect(open).toHaveLength(0);
    const [closed] = await db.select().from(dueEvents).where(eq(dueEvents.itemId, fixture.item.id));
    expect(closed.nextEventId).toBe(null);
    expect(await db.select().from(reminderRules).where(eq(reminderRules.itemId, fixture.item.id))).toHaveLength(0);

    // The flip is recorded, the way a retire is.
    const recorded = await db.select().from(auditLog).where(and(
      eq(auditLog.entityId, fixture.item.id),
      eq(auditLog.action, "expired"),
    ));
    expect(recorded).toHaveLength(1);
    expect(recorded[0].actorUserId).toBe(null);

    // A second sweep on the same rows finds nothing left to do.
    expect(await sweepEndedExpiries(db, now)).toBe(0);
    await fixture.cleanup();
  });
});
