import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { and, eq, isNull } from "drizzle-orm";
import { getDb } from "@/db";
import { auditLog, dueEvents, items, reminderRules } from "@/db/schema";
import { sweepEndedExpiries } from "@/server/notification-worker";
import { cleanupIntegrationEnvironment, createIntegrationFixture } from "./support/fixtures";
import { callRouteForSession, loadRoute } from "./support/request-event";

/**
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
    dueDate: "2026-12-20",
    scheduleKind: "expiry" as const,
    reminderDays: [30, 7],
    status: "active" as const,
    version,
    updatedAt: new Date().toISOString(),
    ...over,
  };
}

async function save(fixture: Fixture, session: Session, item: Record<string, unknown>) {
  return callRouteForSession(applyWorkspaceCommand, session, {
    url: commandUrl,
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      type: "item.upsert",
      householdId: fixture.household.id,
      item,
      activity: { id: randomUUID(), itemId: String(item.id), kind: "created", occurredAt: new Date().toISOString() },
    }),
  });
}

describe("one-off expirations", () => {
  it("stores the date in its own column and seats a due event of its own kind", async () => {
    const fixture = await createIntegrationFixture("expiry-save");
    const owner = await fixture.session("owner");
    expect((await save(fixture, owner, expiryItem(fixture, 2))).status).toBe(200);

    const db = getDb();
    const [row] = await db.select().from(items).where(eq(items.id, fixture.item.id));
    expect(row.expiryDate).toBe("2026-12-20");
    expect(row.renewalDate).toBe(null);
    expect(row.serviceDate).toBe(null);
    expect(row.recurrenceMonths).toBe(null);

    const [event] = await db.select().from(dueEvents).where(eq(dueEvents.itemId, fixture.item.id));
    expect(event.kind).toBe("expiry");
    expect(event.dueDate).toBe("2026-12-20");

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

  it("refuses a recurrence on something that happens once", async () => {
    const fixture = await createIntegrationFixture("expiry-recurrence");
    const owner = await fixture.session("owner");
    const response = await save(fixture, owner, expiryItem(fixture, 2, { recurrenceMonths: 12 }));
    expect(response.status).toBe(422);
    await fixture.cleanup();
  });

  it("refuses a next date when an expiry is completed", async () => {
    const fixture = await createIntegrationFixture("expiry-complete");
    const owner = await fixture.session("owner");
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
        kind: "renewal_completed",
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
    const lingeringId = randomUUID();
    expect((await save(fixture, owner, expiryItem(fixture, 2))).status).toBe(200);
    expect((await save(fixture, owner, {
      ...expiryItem(fixture, 1),
      id: lingeringId,
      title: "Appliance warranty",
      dueDate: "2027-01-05",
    })).status).toBe(200);

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
