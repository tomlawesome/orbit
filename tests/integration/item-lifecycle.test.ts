import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { auditLog, dueEvents, items, notificationStates, reminderRules } from "@/db/schema";
import { cleanupIntegrationEnvironment, createIntegrationFixture } from "./support/fixtures";
import { callRouteForSession, loadRoute } from "./support/request-event";

const { GET: readWorkspace } = await loadRoute("workspace");
const { POST: applyWorkspaceCommand } = await loadRoute("workspace/commands");

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

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((nextResolve) => { resolve = nextResolve; });
  return { promise, resolve };
}

async function waitForCompletionAdvisory(activityId: string): Promise<void> {
  const lockKey = `orbit:item-completion:${activityId}`;
  const deadline = performance.now() + 5_000;
  for (;;) {
    if (performance.now() >= deadline) {
      throw new Error(`Timed out waiting for completion advisory ownership: ${lockKey}`);
    }
    const ownsLock = await getDb().transaction(async (transaction) => {
      const result = await transaction.execute<{ locked: boolean }>(sql`
        select pg_try_advisory_lock(hashtextextended(${lockKey}, 0)) as locked
      `);
      const locked = Boolean(result[0]?.locked);
      if (locked) {
        await transaction.execute(sql`
          select pg_advisory_unlock(hashtextextended(${lockKey}, 0))
        `);
      }
      return locked;
    });
    if (!ownsLock) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
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
  const response = await callRouteForSession(applyWorkspaceCommand, session, { url: commandUrl,
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      type: "item.upsert",
      householdId: fixture.household.id,
      item: scheduledItem(fixture, 2),
      activity: activity(fixture.item.id, "created", { nextDate: "2026-12-20" }),
    }),
  });
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
    const updateResponse = await callRouteForSession(applyWorkspaceCommand, owner, { url: commandUrl,
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "item.upsert", householdId: fixture.household.id, item: updated, activity: updateActivity }),
    });
    expect(updateResponse.status).toBe(200);

    const reload = await callRouteForSession(readWorkspace, owner, { url: workspaceUrl });
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

  it("scopes the item history feed to entityType 'item' audit rows, not merely rows that happen to parse as an activity (#383)", async () => {
    const fixture = await createIntegrationFixture("item-activity-entity-filter");
    const owner = await fixture.session("owner");
    await upsertScheduledItem(fixture, owner);

    // Shaped exactly like a real activity payload (so the old code's
    // app-side itemActivitySchema.safeParse alone would have accepted it),
    // but on a non-"item" audit row -- the feed must be scoped by
    // entityType in the query, not merely by whether changes.activity
    // parses.
    const impostorActivity = activity(fixture.item.id, "cancelled");
    await getDb().insert(auditLog).values({
      householdId: fixture.household.id,
      actorUserId: fixture.users.owner.id,
      entityType: "document",
      entityId: fixture.item.id,
      action: "document_available",
      changes: { activity: impostorActivity },
    });

    const reload = await callRouteForSession(readWorkspace, owner, { url: workspaceUrl });
    expect(reload.status).toBe(200);
    const workspace = await json(reload);
    const household = (workspace.workspace as { households: Array<{ activities: Array<Record<string, unknown>> }> }).households[0];
    expect(household.activities.map((entry) => entry.id)).not.toContain(impostorActivity.id);
  });

  it("marks a batch of notifications read in one command, deduplicated, without dropping a concurrent single dismiss (#383)", async () => {
    const fixture = await createIntegrationFixture("notification-read-all-batch");
    const owner = await fixture.session("owner");
    const notificationIds = Array.from({ length: 12 }, (_, index) => `${fixture.item.id}:2026-12-${String(index + 1).padStart(2, "0")}:due-today`);
    const duplicatedIds = [...notificationIds, ...notificationIds];

    const readAll = await callRouteForSession(applyWorkspaceCommand, owner, { url: commandUrl,
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "notification.read-all", householdId: fixture.household.id, notificationIds: duplicatedIds }),
    });
    expect(readAll.status).toBe(200);

    const dismissedId = `${fixture.item.id}:2026-12-31:overdue`;
    const dismiss = await callRouteForSession(applyWorkspaceCommand, owner, { url: commandUrl,
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "notification.dismiss", householdId: fixture.household.id, notificationId: dismissedId }),
    });
    expect(dismiss.status).toBe(200);

    const reload = await callRouteForSession(readWorkspace, owner, { url: workspaceUrl });
    const workspace = await json(reload);
    const household = (workspace.workspace as { households: Array<{ readNotificationIds: string[]; dismissedNotificationIds: string[] }> }).households[0];
    expect(new Set(household.readNotificationIds)).toEqual(new Set(notificationIds));
    expect(household.readNotificationIds).toHaveLength(notificationIds.length);
    expect(household.dismissedNotificationIds).toEqual([dismissedId]);

    // Re-running the same batch is an idempotent upsert, not a duplicate insert.
    const rerun = await callRouteForSession(applyWorkspaceCommand, owner, { url: commandUrl,
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "notification.read-all", householdId: fixture.household.id, notificationIds }),
    });
    expect(rerun.status).toBe(200);
    const rereload = await json(await callRouteForSession(readWorkspace, owner, { url: workspaceUrl }));
    const rehousehold = (rereload.workspace as { households: Array<{ readNotificationIds: string[] }> }).households[0];
    expect(rehousehold.readNotificationIds).toHaveLength(notificationIds.length);
  });

  it("clamps items and notification ids to the outbound schema cap instead of 422ing on stored data no write path enforces (#383)", async () => {
    const fixture = await createIntegrationFixture("workspace-read-clamp");
    const owner = await fixture.session("owner");

    // No write path enforces the 500-item / 2000-notification-id caps that
    // householdWorkspaceSchema re-validates on read, so a household can
    // reach these volumes through nothing more than ordinary, uncapped
    // writes; bulk-inserting directly here stands in for that accumulation.
    await getDb().insert(items).values(Array.from({ length: 501 }, () => ({
      householdId: fixture.household.id,
      sectionId: fixture.section.id,
      title: "Overflow item",
      currency: "GBP",
    })));
    await getDb().insert(notificationStates).values(Array.from({ length: 2_001 }, (_, index) => ({
      userId: fixture.users.owner.id,
      householdId: fixture.household.id,
      notificationId: `overflow-${index}`,
      readAt: new Date(),
    })));

    const reload = await callRouteForSession(readWorkspace, owner, { url: workspaceUrl });
    expect(reload.status).toBe(200);
    const workspace = await json(reload);
    const household = (workspace.workspace as { households: Array<{ items: unknown[]; readNotificationIds: string[] }> }).households[0];
    expect(household.items.length).toBeLessThanOrEqual(500);
    expect(household.readNotificationIds.length).toBeLessThanOrEqual(2_000);
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
    const response = await callRouteForSession(applyWorkspaceCommand, owner, { url: commandUrl,
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(command),
    });
    expect(response.status).toBe(200);
    const after = await itemSnapshot(fixture);
    expect(after.item?.version).toBe((before.item?.version ?? 0) + 1);
    expect(after.auditCount).toBe(before.auditCount + 1);

    const replay = await callRouteForSession(applyWorkspaceCommand, owner, { url: commandUrl,
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(command),
    });
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
      const response = await callRouteForSession(applyWorkspaceCommand, owner, { url: commandUrl,
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...command, householdId: fixture.household.id, itemId: fixture.item.id, expectedVersion: stale }),
      });
      await expectError(response, 409, "version_conflict");
      expect(await itemSnapshot(fixture)).toEqual(before);
    }
  });

  it("rejects missing and malformed transition versions at the API contract", async () => {
    const fixture = await createIntegrationFixture("item-version-contract");
    const owner = await fixture.session("owner");
    await upsertScheduledItem(fixture, owner);
    const base = { type: "item.archive", householdId: fixture.household.id, itemId: fixture.item.id, activity: activity(fixture.item.id, "archived") };

    const missing = await callRouteForSession(applyWorkspaceCommand, owner, { url: commandUrl,
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(base),
    });
    await expectError(missing, 422, "validation_failed");

    const malformed = await callRouteForSession(applyWorkspaceCommand, owner, { url: commandUrl,
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...base, expectedVersion: 0 }),
    });
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

    const first = await callRouteForSession(applyWorkspaceCommand, owner, { url: commandUrl,
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(completion),
    });
    expect(first.status).toBe(200);
    const replay = await callRouteForSession(applyWorkspaceCommand, owner, { url: commandUrl,
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(completion),
    });
    expect(replay.status).toBe(200);

    const concurrentFixture = await createIntegrationFixture("item-completion-concurrent-replay");
    const concurrentOwner = await concurrentFixture.session("owner");
    await upsertScheduledItem(concurrentFixture, concurrentOwner);
    const concurrent = {
      ...completion,
      householdId: concurrentFixture.household.id,
      itemId: concurrentFixture.item.id,
      activity: activity(concurrentFixture.item.id, "renewal_completed", { effectiveDate: "2026-12-20", nextDate: "2027-12-20" }),
    };
    expect(concurrent.activity.id).not.toBe(completion.activity.id);
    const responses = await Promise.all([
      callRouteForSession(applyWorkspaceCommand, concurrentOwner, { url: commandUrl, method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(concurrent) }),
      callRouteForSession(applyWorkspaceCommand, concurrentOwner, { url: commandUrl, method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(concurrent) }),
    ]);
    expect(responses.map((response) => response.status).sort()).toEqual([200, 200]);

    for (const [target, completionKey] of [[fixture, completion.activity.id], [concurrentFixture, concurrent.activity.id]] as const) {
      const snapshot = await itemSnapshot(target);
      expect(snapshot.item?.version).toBe(3);
      expect(snapshot.events.filter((event) => event.completedAt != null)).toHaveLength(1);
      expect(snapshot.events.filter((event) => event.completedAt == null)).toHaveLength(1);
      expect(snapshot.events.filter((event) => event.completionKey === completionKey)).toHaveLength(1);
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
    const completed = await callRouteForSession(applyWorkspaceCommand, owner, { url: commandUrl,
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(completion),
    });
    expect(completed.status).toBe(200);

    const otherItemId = randomUUID();
    const otherActivity = activity(otherItemId, "created");
    const otherUpsert = await callRouteForSession(applyWorkspaceCommand, owner, { url: commandUrl,
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        type: "item.upsert",
        householdId: fixture.household.id,
        item: { ...scheduledItem(fixture, 1), id: otherItemId, title: "Second scheduled item", version: 1 },
        activity: otherActivity,
      }),
    });
    expect(otherUpsert.status).toBe(200);
    const before = await getDb().select().from(items).where(eq(items.id, otherItemId));
    const beforeEvents = await getDb().select().from(dueEvents).where(eq(dueEvents.itemId, otherItemId));
    const beforeAudit = await getDb().select({ id: auditLog.id }).from(auditLog).where(and(
      eq(auditLog.householdId, fixture.household.id),
      eq(auditLog.entityId, otherItemId),
    ));

    const reused = await callRouteForSession(applyWorkspaceCommand, owner, { url: commandUrl,
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...completion, itemId: otherItemId, expectedVersion: 1, activity: { ...completion.activity, itemId: otherItemId } }),
    });
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
    const firstResponse = await callRouteForSession(applyWorkspaceCommand, firstOwner, { url: commandUrl,
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(completion),
    });
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

    const secondResponse = await callRouteForSession(applyWorkspaceCommand, secondOwner, { url: commandUrl,
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(reused),
    });
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

    const response = await callRouteForSession(applyWorkspaceCommand, owner, { url: commandUrl,
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(completion),
    });
    await expectError(response, 409, "version_conflict");
    expect(await itemSnapshot(fixture)).toEqual(before);
    expect(await getDb().select().from(auditLog).where(eq(auditLog.id, completion.activity.id))).toEqual(beforeAudit);
    expect(await getDb().select().from(dueEvents).where(eq(dueEvents.completionKey, completion.activity.id))).toHaveLength(0);
  });

  it("rolls back completion state when a concurrent non-completion claims its audit ID", async () => {
    const completionFixture = await createIntegrationFixture("item-completion-audit-race-completion");
    const completionOwner = await completionFixture.session("owner");
    await upsertScheduledItem(completionFixture, completionOwner);
    const competingFixture = await createIntegrationFixture("item-completion-audit-race-competing");
    const competingOwner = await competingFixture.session("owner");
    await upsertScheduledItem(competingFixture, competingOwner);

    const completion = {
      type: "item.complete",
      householdId: completionFixture.household.id,
      itemId: completionFixture.item.id,
      expectedVersion: 2,
      completedDate: "2026-12-20",
      nextDate: "2027-12-20",
      activity: activity(completionFixture.item.id, "renewal_completed", { nextDate: "2027-12-20" }),
    } as const;
    const competing = {
      type: "item.archive",
      householdId: competingFixture.household.id,
      itemId: competingFixture.item.id,
      expectedVersion: 2,
      activity: { ...activity(competingFixture.item.id, "archived"), id: completion.activity.id },
    } as const;
    const beforeCompletion = await itemSnapshot(completionFixture);

    const dueEventHeld = deferred<void>();
    const releaseDueEvent = deferred<void>();
    const dueEventLock = getDb().transaction(async (transaction) => {
      const [event] = await transaction.select({ id: dueEvents.id }).from(dueEvents)
        .where(and(eq(dueEvents.householdId, completionFixture.household.id), eq(dueEvents.itemId, completionFixture.item.id)))
        .for("update")
        .limit(1);
      if (!event) throw new Error("Expected a completion due event");
      dueEventHeld.resolve();
      await releaseDueEvent.promise;
    });

    try {
      await dueEventHeld.promise;
      const completionRequest = callRouteForSession(applyWorkspaceCommand, completionOwner, { url: commandUrl,
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(completion),
      });
      await waitForCompletionAdvisory(completion.activity.id);

      const competingResponse = await callRouteForSession(applyWorkspaceCommand, competingOwner, { url: commandUrl,
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(competing),
      });
      expect(competingResponse.status).toBe(200);
      releaseDueEvent.resolve();

      const completionResponse = await completionRequest;
      await expectError(completionResponse, 409, "version_conflict");
      expect(await itemSnapshot(completionFixture)).toEqual(beforeCompletion);
      expect(await getDb().select().from(dueEvents).where(eq(dueEvents.completionKey, completion.activity.id))).toHaveLength(0);
      const [audit] = await getDb().select().from(auditLog).where(eq(auditLog.id, completion.activity.id));
      expect(audit).toEqual(expect.objectContaining({
        entityId: competingFixture.item.id,
        action: "archived",
      }));
      expect(await itemSnapshot(competingFixture)).toEqual(expect.objectContaining({
        item: expect.objectContaining({ status: "archived", version: 3 }),
      }));
    } finally {
      releaseDueEvent.resolve();
      await dueEventLock;
    }
  });

  it("serializes distinct completions so one wins and one conflicts", async () => {
    const fixture = await createIntegrationFixture("item-completion-conflict");
    const owner = await fixture.session("owner");
    await upsertScheduledItem(fixture, owner);
    const common = { type: "item.complete", householdId: fixture.household.id, itemId: fixture.item.id, expectedVersion: 2, completedDate: "2026-12-20", nextDate: "2027-12-20" } as const;
    const completions = ["renewal_completed", "renewal_completed"].map((kind) => ({ ...common, activity: activity(fixture.item.id, kind as "renewal_completed", { nextDate: "2027-12-20" }) }));
    const responses = await Promise.all(completions.map((command) => callRouteForSession(applyWorkspaceCommand, owner, { url: commandUrl,
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(command),
    })));
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
    const response = await callRouteForSession(applyWorkspaceCommand, outsider, { url: commandUrl,
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "item.archive", householdId: fixture.household.id, itemId: fixture.item.id, expectedVersion: 2, activity: activity(fixture.item.id, "archived") }),
    });
    await expectError(response, 404, "household_not_found");
    expect(await itemSnapshot(fixture)).toEqual(before);
  });
});
