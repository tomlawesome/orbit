import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { auditLog, dueEvents, items, reminderRules } from "@/db/schema";
import { GET as readWorkspace } from "@/app/api/workspace/route";
import { POST as applyWorkspaceCommand } from "@/app/api/workspace/commands/route";
import { cleanupIntegrationEnvironment, createIntegrationFixture, requestForSession } from "./support/fixtures";

afterAll(async () => {
  await cleanupIntegrationEnvironment();
});

const commandUrl = "http://127.0.0.1:3000/api/workspace/commands";
const workspaceUrl = "http://127.0.0.1:3000/api/workspace";

async function json(response: Response): Promise<Record<string, unknown>> {
  return await response.json() as Record<string, unknown>;
}

async function expectError(response: Response, status: number, code: string) {
  expect(response.status).toBe(status);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect((await json(response)).error).toEqual(expect.objectContaining({ code }));
}

function activity(itemId: string, kind: "created" | "updated" | "renewal_completed" | "service_completed" | "rescheduled" | "snoozed" | "cancelled" | "restored" | "archived", details: Record<string, unknown> = {}) {
  return {
    id: randomUUID(),
    itemId,
    kind,
    occurredAt: new Date().toISOString(),
    ...details,
  };
}

function scheduledItem(fixture: Awaited<ReturnType<typeof createIntegrationFixture>>, version: number) {
  return {
    id: fixture.item.id,
    sectionId: fixture.section.id,
    title: "Boiler cover",
    subtype: "Insurance",
    provider: "Example Cover",
    reference: "POL-40",
    costMinor: 12500,
    currency: "GBP",
    dueDate: "2026-12-20",
    scheduleKind: "renewal" as const,
    recurrenceMonths: 12,
    reminderDays: [30, 7],
    notes: "Keep the renewal confirmation.",
    status: "active" as const,
    version,
    updatedAt: new Date().toISOString(),
  };
}

async function upsertScheduledItem(
  fixture: Awaited<ReturnType<typeof createIntegrationFixture>>,
  session: Awaited<ReturnType<Awaited<ReturnType<typeof createIntegrationFixture>>["session"]>>,
) {
  const response = await applyWorkspaceCommand(requestForSession(session, commandUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      type: "item.upsert",
      householdId: fixture.household.id,
      item: scheduledItem(fixture, 2),
      activity: activity(fixture.item.id, "created", { nextDate: "2026-12-20" }),
    }),
  }));
  expect(response.status).toBe(200);
  return response;
}

async function itemSnapshot(fixture: Awaited<ReturnType<typeof createIntegrationFixture>>) {
  const db = getDb();
  const [item] = await db.select().from(items).where(eq(items.id, fixture.item.id));
  const events = await db.select().from(dueEvents).where(eq(dueEvents.itemId, fixture.item.id));
  const reminders = await db.select().from(reminderRules).where(eq(reminderRules.itemId, fixture.item.id));
  return { item, events, reminders, auditCount: await fixture.auditCount(fixture.item.id) };
}

describe("conflict-safe item lifecycle", () => {
  it("creates, edits, reloads and retains canonical fields, schedule, reminders and history", async () => {
    const fixture = await createIntegrationFixture("item-round-trip");
    const owner = await fixture.session("owner");
    await upsertScheduledItem(fixture, owner);

    const updated = { ...scheduledItem(fixture, 3), title: "Updated boiler cover", dueDate: "2027-01-20", reminderDays: [14, 3] };
    const updateActivity = activity(fixture.item.id, "updated", { previousDate: "2026-12-20", nextDate: "2027-01-20" });
    const updateResponse = await applyWorkspaceCommand(requestForSession(owner, commandUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "item.upsert", householdId: fixture.household.id, item: updated, activity: updateActivity }),
    }));
    expect(updateResponse.status).toBe(200);

    const reload = await readWorkspace(requestForSession(owner, workspaceUrl));
    expect(reload.status).toBe(200);
    const workspace = await json(reload);
    const household = (workspace.workspace as { households: Array<{ items: Array<Record<string, unknown>>; activities: Array<Record<string, unknown>> }> }).households[0];
    expect(household.items).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: fixture.item.id,
        title: "Updated boiler cover",
        dueDate: "2027-01-20",
        reminderDays: [14, 3],
        version: 3,
      }),
    ]));
    expect(household.activities).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: updateActivity.id, kind: "updated" }),
    ]));
    const snapshot = await itemSnapshot(fixture);
    expect(snapshot.item).toMatchObject({ title: "Updated boiler cover", version: 3, renewalDate: "2027-01-20" });
    expect(snapshot.events.filter((event) => event.completedAt == null)).toHaveLength(1);
    expect(snapshot.reminders.map((reminder) => reminder.daysBefore).sort((left, right) => right - left)).toEqual([14, 3]);
  });

  it("increments the item version exactly once for an accepted transition", async () => {
    const fixture = await createIntegrationFixture("item-version-increment");
    const owner = await fixture.session("owner");
    await upsertScheduledItem(fixture, owner);
    const before = await itemSnapshot(fixture);
    const command = {
      type: "item.reschedule",
      householdId: fixture.household.id,
      itemId: fixture.item.id,
      expectedVersion: 2,
      dueDate: "2027-01-10",
      activity: activity(fixture.item.id, "rescheduled", { previousDate: "2026-12-20", nextDate: "2027-01-10" }),
    } as const;
    const response = await applyWorkspaceCommand(requestForSession(owner, commandUrl, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(command),
    }));
    expect(response.status).toBe(200);
    const after = await itemSnapshot(fixture);
    expect(after.item?.version).toBe((before.item?.version ?? 0) + 1);
    expect(after.auditCount).toBe(before.auditCount + 1);

    const replay = await applyWorkspaceCommand(requestForSession(owner, commandUrl, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(command),
    }));
    await expectError(replay, 409, "version_conflict");
    expect(await itemSnapshot(fixture)).toEqual(after);
  });

  it("rejects every stale transition without changing item, schedule, reminders or audit history", async () => {
    const fixture = await createIntegrationFixture("item-stale-transitions");
    const owner = await fixture.session("owner");
    await upsertScheduledItem(fixture, owner);
    const before = await itemSnapshot(fixture);
    const stale = 1;
    const commands = [
      { type: "item.archive", activity: activity(fixture.item.id, "archived") },
      { type: "item.complete", completedDate: "2026-12-20", nextDate: "2027-12-20", activity: activity(fixture.item.id, "renewal_completed") },
      { type: "item.reschedule", dueDate: "2027-01-10", activity: activity(fixture.item.id, "rescheduled") },
      { type: "item.snooze", snoozedUntil: "2026-12-01", activity: activity(fixture.item.id, "snoozed") },
      { type: "item.status", status: "cancelled", activity: activity(fixture.item.id, "cancelled") },
    ] as const;

    for (const command of commands) {
      const response = await applyWorkspaceCommand(requestForSession(owner, commandUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...command, householdId: fixture.household.id, itemId: fixture.item.id, expectedVersion: stale }),
      }));
      await expectError(response, 409, "version_conflict");
      expect(await itemSnapshot(fixture)).toEqual(before);
    }
  });

  it("rejects missing and malformed transition versions at the API contract", async () => {
    const fixture = await createIntegrationFixture("item-version-contract");
    const owner = await fixture.session("owner");
    await upsertScheduledItem(fixture, owner);
    const base = { type: "item.archive", householdId: fixture.household.id, itemId: fixture.item.id, activity: activity(fixture.item.id, "archived") };

    const missing = await applyWorkspaceCommand(requestForSession(owner, commandUrl, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(base),
    }));
    await expectError(missing, 422, "validation_failed");

    const malformed = await applyWorkspaceCommand(requestForSession(owner, commandUrl, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...base, expectedVersion: 0 }),
    }));
    await expectError(malformed, 422, "validation_failed");
  });

  it("makes sequential and concurrent completion replays exactly once", async () => {
    const fixture = await createIntegrationFixture("item-completion-replay");
    const owner = await fixture.session("owner");
    await upsertScheduledItem(fixture, owner);
    const completion = {
      type: "item.complete",
      householdId: fixture.household.id,
      itemId: fixture.item.id,
      expectedVersion: 2,
      completedDate: "2026-12-20",
      nextDate: "2027-12-20",
      activity: activity(fixture.item.id, "renewal_completed", { effectiveDate: "2026-12-20", nextDate: "2027-12-20" }),
    } as const;

    const first = await applyWorkspaceCommand(requestForSession(owner, commandUrl, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(completion),
    }));
    expect(first.status).toBe(200);
    const replay = await applyWorkspaceCommand(requestForSession(owner, commandUrl, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(completion),
    }));
    expect(replay.status).toBe(200);

    const concurrentFixture = await createIntegrationFixture("item-completion-concurrent-replay");
    const concurrentOwner = await concurrentFixture.session("owner");
    await upsertScheduledItem(concurrentFixture, concurrentOwner);
    const concurrent = {
      ...completion,
      householdId: concurrentFixture.household.id,
      itemId: concurrentFixture.item.id,
      activity: { ...completion.activity, itemId: concurrentFixture.item.id },
    };
    const responses = await Promise.all([
      applyWorkspaceCommand(requestForSession(concurrentOwner, commandUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(concurrent) })),
      applyWorkspaceCommand(requestForSession(concurrentOwner, commandUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(concurrent) })),
    ]);
    expect(responses.map((response) => response.status).sort()).toEqual([200, 200]);

    for (const target of [fixture, concurrentFixture]) {
      const snapshot = await itemSnapshot(target);
      expect(snapshot.item?.version).toBe(3);
      expect(snapshot.events.filter((event) => event.completedAt != null)).toHaveLength(1);
      expect(snapshot.events.filter((event) => event.completedAt == null)).toHaveLength(1);
      expect(snapshot.events.filter((event) => event.completionKey === completion.activity.id)).toHaveLength(1);
      expect(snapshot.auditCount).toBe(2);
    }
  });

  it("rejects a completion key reused for another item without side effects", async () => {
    const fixture = await createIntegrationFixture("item-completion-key-reuse");
    const owner = await fixture.session("owner");
    await upsertScheduledItem(fixture, owner);
    const completion = {
      type: "item.complete",
      householdId: fixture.household.id,
      itemId: fixture.item.id,
      expectedVersion: 2,
      completedDate: "2026-12-20",
      nextDate: "2027-12-20",
      activity: activity(fixture.item.id, "renewal_completed", { nextDate: "2027-12-20" }),
    } as const;
    const completed = await applyWorkspaceCommand(requestForSession(owner, commandUrl, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(completion),
    }));
    expect(completed.status).toBe(200);

    const otherItemId = randomUUID();
    const otherActivity = activity(otherItemId, "created");
    const otherUpsert = await applyWorkspaceCommand(requestForSession(owner, commandUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        type: "item.upsert",
        householdId: fixture.household.id,
        item: { ...scheduledItem(fixture, 1), id: otherItemId, title: "Second scheduled item", version: 1 },
        activity: otherActivity,
      }),
    }));
    expect(otherUpsert.status).toBe(200);
    const before = await getDb().select().from(items).where(eq(items.id, otherItemId));
    const beforeEvents = await getDb().select().from(dueEvents).where(eq(dueEvents.itemId, otherItemId));
    const beforeAudit = await getDb().select({ id: auditLog.id }).from(auditLog).where(and(
      eq(auditLog.householdId, fixture.household.id),
      eq(auditLog.entityId, otherItemId),
    ));

    const reused = await applyWorkspaceCommand(requestForSession(owner, commandUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...completion, itemId: otherItemId, expectedVersion: 1, activity: { ...completion.activity, itemId: otherItemId } }),
    }));
    await expectError(reused, 409, "version_conflict");
    expect(await getDb().select().from(items).where(eq(items.id, otherItemId))).toEqual(before);
    expect(await getDb().select().from(dueEvents).where(eq(dueEvents.itemId, otherItemId))).toEqual(beforeEvents);
    expect(await getDb().select({ id: auditLog.id }).from(auditLog).where(and(
      eq(auditLog.householdId, fixture.household.id),
      eq(auditLog.entityId, otherItemId),
    ))).toEqual(beforeAudit);
  });

  it("rejects a completion key reused in another household without side effects", async () => {
    const firstFixture = await createIntegrationFixture("item-completion-cross-household-first");
    const firstOwner = await firstFixture.session("owner");
    await upsertScheduledItem(firstFixture, firstOwner);
    const completion = {
      type: "item.complete",
      householdId: firstFixture.household.id,
      itemId: firstFixture.item.id,
      expectedVersion: 2,
      completedDate: "2026-12-20",
      nextDate: "2027-12-20",
      activity: activity(firstFixture.item.id, "renewal_completed", { nextDate: "2027-12-20" }),
    } as const;
    const firstResponse = await applyWorkspaceCommand(requestForSession(firstOwner, commandUrl, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(completion),
    }));
    expect(firstResponse.status).toBe(200);

    const secondFixture = await createIntegrationFixture("item-completion-cross-household-second");
    const secondOwner = await secondFixture.session("owner");
    await upsertScheduledItem(secondFixture, secondOwner);
    const before = await itemSnapshot(secondFixture);
    const beforeAudit = await getDb().select().from(auditLog).where(eq(auditLog.id, completion.activity.id));
    const reused = {
      ...completion,
      householdId: secondFixture.household.id,
      itemId: secondFixture.item.id,
      expectedVersion: 2,
      activity: { ...completion.activity, itemId: secondFixture.item.id },
    };

    const secondResponse = await applyWorkspaceCommand(requestForSession(secondOwner, commandUrl, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(reused),
    }));
    await expectError(secondResponse, 409, "version_conflict");
    expect(await itemSnapshot(secondFixture)).toEqual(before);
    expect(await getDb().select().from(auditLog).where(eq(auditLog.id, completion.activity.id))).toEqual(beforeAudit);
    expect(await getDb().select().from(dueEvents).where(eq(dueEvents.completionKey, completion.activity.id))).toHaveLength(1);
  });

  it("fails closed when a completion key already belongs to a non-completion audit", async () => {
    const fixture = await createIntegrationFixture("item-completion-audit-collision");
    const owner = await fixture.session("owner");
    await upsertScheduledItem(fixture, owner);
    const completion = {
      type: "item.complete",
      householdId: fixture.household.id,
      itemId: fixture.item.id,
      expectedVersion: 2,
      completedDate: "2026-12-20",
      nextDate: "2027-12-20",
      activity: activity(fixture.item.id, "renewal_completed", { nextDate: "2027-12-20" }),
    } as const;
    await getDb().insert(auditLog).values({
      id: completion.activity.id,
      householdId: fixture.household.id,
      actorUserId: owner.userId,
      entityType: "item",
      entityId: fixture.item.id,
      action: "created",
      changes: { source: "prior-non-completion" },
      createdAt: new Date(),
    });
    const before = await itemSnapshot(fixture);
    const beforeAudit = await getDb().select().from(auditLog).where(eq(auditLog.id, completion.activity.id));

    const response = await applyWorkspaceCommand(requestForSession(owner, commandUrl, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(completion),
    }));
    await expectError(response, 409, "version_conflict");
    expect(await itemSnapshot(fixture)).toEqual(before);
    expect(await getDb().select().from(auditLog).where(eq(auditLog.id, completion.activity.id))).toEqual(beforeAudit);
    expect(await getDb().select().from(dueEvents).where(eq(dueEvents.completionKey, completion.activity.id))).toHaveLength(0);
  });

  it("serializes distinct completions so one wins and one conflicts", async () => {
    const fixture = await createIntegrationFixture("item-completion-conflict");
    const owner = await fixture.session("owner");
    await upsertScheduledItem(fixture, owner);
    const common = { type: "item.complete", householdId: fixture.household.id, itemId: fixture.item.id, expectedVersion: 2, completedDate: "2026-12-20", nextDate: "2027-12-20" } as const;
    const completions = ["renewal_completed", "renewal_completed"].map((kind) => ({ ...common, activity: activity(fixture.item.id, kind as "renewal_completed", { nextDate: "2027-12-20" }) }));
    const responses = await Promise.all(completions.map((command) => applyWorkspaceCommand(requestForSession(owner, commandUrl, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(command),
    }))));
    expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
    const snapshot = await itemSnapshot(fixture);
    expect(snapshot.item?.version).toBe(3);
    expect(snapshot.events.filter((event) => event.completedAt != null)).toHaveLength(1);
    expect(snapshot.events.filter((event) => event.completedAt == null)).toHaveLength(1);
    expect(snapshot.auditCount).toBe(2);
  });

  it("denies an outsider without changing item or history", async () => {
    const fixture = await createIntegrationFixture("item-outsider");
    const owner = await fixture.session("owner");
    const outsider = await fixture.session("outsider");
    await upsertScheduledItem(fixture, owner);
    const before = await itemSnapshot(fixture);
    const response = await applyWorkspaceCommand(requestForSession(outsider, commandUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "item.archive", householdId: fixture.household.id, itemId: fixture.item.id, expectedVersion: 2, activity: activity(fixture.item.id, "archived") }),
    }));
    await expectError(response, 404, "household_not_found");
    expect(await itemSnapshot(fixture)).toEqual(before);
  });
});
