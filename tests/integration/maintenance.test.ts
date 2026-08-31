import { asc, eq, inArray } from "drizzle-orm";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { closeDatabase, getDb } from "@/db";
import * as schema from "@/db/schema";
import { auditLog, instanceMaintenance, maintenanceUpdates, maintenanceWindows } from "@/db/schema";
import {
  activateDueMaintenanceWindow,
  cancelMaintenanceWindow,
  editMaintenanceUpdate,
  endMaintenance,
  openMaintenanceWindow,
  publishMaintenanceUpdate,
  readMaintenanceState,
  rescheduleMaintenanceWindow,
  reviseMaintenanceExpectedEnd,
  scheduleMaintenanceWindow,
  type MaintenanceState,
} from "@/server/maintenance";
import { cleanupIntegrationEnvironment, createIntegrationFixture } from "./support/fixtures";

afterAll(async () => {
  await cleanupIntegrationEnvironment();
});

/* instance_maintenance is a database-wide singleton the 0028 migration seeds
   once (never deleted, unlike instance_authority's #263 precedent, because
   this table has no foreign key forcing conditional seeding). Every test
   restores it to that seeded shape, and clears windows, updates and this
   feature's audit rows, so sibling tests never observe a leaked version or
   timeline. The singleton is cleared first: it references the window rows. */
afterEach(async () => {
  await getDb().update(instanceMaintenance).set({
    active: false,
    currentWindowId: null,
    expectedEndAt: null,
    version: 1,
    updatedAt: new Date(),
  });
  await getDb().delete(maintenanceUpdates);
  await getDb().delete(maintenanceWindows);
  await getDb().delete(auditLog).where(inArray(auditLog.entityType, ["instance_maintenance", "maintenance_window"]));
});

function timeline(state: MaintenanceState): Array<[string, string]> {
  return (state.openWindow?.updates ?? []).map((entry) => [entry.kind, entry.body]);
}

/**
 * Schedules a window the way an administrator does — for a future instant —
 * and then moves that instant into the past, which is what the passage of
 * time does to the row. Writing `scheduled_start_at` in the past directly
 * would produce the same columns, but going through the domain writer first
 * keeps the fixture honest about the shape the application actually creates.
 */
async function scheduleAndLetFallDue(
  adminId: string,
  expectedVersion: number,
  params: { body: string; expectedEndAt: Date | null },
): Promise<{ windowId: string; state: MaintenanceState }> {
  const scheduled = await scheduleMaintenanceWindow(adminId, expectedVersion, {
    body: params.body,
    scheduledStartAt: new Date(Date.now() + 3_600_000),
    expectedEndAt: params.expectedEndAt,
  });
  const windowId = scheduled.scheduledWindows[scheduled.scheduledWindows.length - 1].id;
  await getDb().update(maintenanceWindows)
    .set({ scheduledStartAt: new Date(Date.now() - 60_000) })
    .where(eq(maintenanceWindows.id, windowId));
  return { windowId, state: await readMaintenanceState() };
}

/**
 * ADR-0013 decision 1's denormalisation invariant, asserted wherever the
 * state could have moved: the guard reads `expected_end_at` off the
 * singleton, so it must equal the open window's at every observable moment,
 * and be null when nothing is open.
 */
async function expectDenormalisedEndConsistent(): Promise<void> {
  const state = await readMaintenanceState();
  const [openRow] = await getDb().select().from(maintenanceWindows).where(eq(maintenanceWindows.status, "open"));
  if (openRow) {
    expect(state.expectedEndAt?.getTime() ?? null).toBe(openRow.expectedEndAt?.getTime() ?? null);
    expect(state.currentWindowId).toBe(openRow.id);
  } else {
    expect(state.expectedEndAt).toBeNull();
  }
}

describe("window lifecycle, versioned mutations and audit (#522, #585)", () => {
  it("schedules, opens, updates and resolves a window, auditing each transition against the window", async () => {
    const fixture = await createIntegrationFixture("maintenance-lifecycle");
    const admin = fixture.users.admin;

    const opened = await openMaintenanceWindow(admin.id, 1, {
      body: "Starting a database upgrade.",
      expectedEndAt: new Date(Date.now() + 3_600_000),
    });
    expect(opened.active).toBe(true);
    expect(opened.effectivelyActive).toBe(true);
    expect(opened.version).toBe(2);
    expect(timeline(opened)).toEqual([["started", "Starting a database upgrade."]]);
    expect(opened.openWindow?.status).toBe("open");
    expect(opened.openWindow?.startedAt).not.toBeNull();
    await expectDenormalisedEndConsistent();

    // The follow-on joins the timeline; nothing published is overwritten.
    const updated = await publishMaintenanceUpdate(admin.id, opened.version, "Still upgrading the database.");
    expect(timeline(updated)).toEqual([
      ["started", "Starting a database upgrade."],
      ["update", "Still upgrading the database."],
    ]);
    expect(updated.version).toBe(3);

    const resolved = await endMaintenance(admin.id, updated.version, { body: "All done, thank you for waiting." });
    expect(resolved.active).toBe(false);
    expect(resolved.effectivelyActive).toBe(false);
    expect(resolved.openWindow).toBeNull();
    expect(resolved.currentWindowId).toBeNull();
    expect(resolved.version).toBe(4);
    await expectDenormalisedEndConsistent();

    // Resolved windows are retained indefinitely, with their whole timeline.
    const [retained] = await getDb().select().from(maintenanceWindows);
    expect(retained.status).toBe("resolved");
    expect(retained.endedAt).not.toBeNull();
    const entries = await getDb().select().from(maintenanceUpdates)
      .orderBy(asc(maintenanceUpdates.publishedAt), asc(maintenanceUpdates.id));
    expect(entries.map((entry) => entry.kind)).toEqual(["started", "update", "resolved"]);

    const audits = await getDb()
      .select({ action: auditLog.action, entityType: auditLog.entityType, entityId: auditLog.entityId, actorUserId: auditLog.actorUserId, householdId: auditLog.householdId })
      .from(auditLog)
      .where(inArray(auditLog.entityType, ["instance_maintenance", "maintenance_window"]))
      .orderBy(asc(auditLog.createdAt));
    expect(audits.map((row) => row.action)).toEqual([
      "maintenance_window_opened",
      "maintenance_window_updated",
      "maintenance_window_resolved",
    ]);
    expect(new Set(audits.map((row) => row.entityType))).toEqual(new Set(["maintenance_window"]));
    expect(new Set(audits.map((row) => row.entityId))).toEqual(new Set([retained.id]));
    expect(audits.every((row) => row.householdId === null)).toBe(true);
    expect(audits.every((row) => row.actorUserId === admin.id)).toBe(true);

    await fixture.cleanup();
  });

  it("schedules a window, opens it on the tick, and orders the timeline deterministically", async () => {
    const fixture = await createIntegrationFixture("maintenance-scheduled-opens");
    const admin = fixture.users.admin;

    const { windowId } = await scheduleAndLetFallDue(admin.id, 1, {
      body: "Scheduled database upgrade.",
      expectedEndAt: new Date(Date.now() + 3_600_000),
    });
    const pinned = await readMaintenanceState();
    expect(pinned.active).toBe(false);
    // The clock is the trigger, not the tick.
    expect(pinned.effectivelyActive).toBe(true);

    const result = await activateDueMaintenanceWindow();
    expect(result.openedWindowId).toBe(windowId);
    expect(result.absorbedWindowId).toBeNull();

    const state = await readMaintenanceState();
    expect(state.active).toBe(true);
    expect(state.openWindow?.id).toBe(windowId);
    // The original `scheduled` entry is retained — an entry's kind is
    // immutable (decision 8) — so the started entry is appended after it.
    expect(timeline(state)).toEqual([
      ["scheduled", "Scheduled database upgrade."],
      ["started", "Scheduled database upgrade."],
    ]);
    await expectDenormalisedEndConsistent();

    await fixture.cleanup();
  });

  it("rejects a stale or replayed version with no state change and no audit row", async () => {
    const fixture = await createIntegrationFixture("maintenance-stale");
    const admin = fixture.users.admin;

    const opened = await openMaintenanceWindow(admin.id, 1, { body: "First published message.", expectedEndAt: null });
    expect(opened.version).toBe(2);

    // Replays the version the caller already spent.
    await expect(publishMaintenanceUpdate(admin.id, 1, "This must not land.")).rejects.toMatchObject({
      code: "maintenance_state_stale",
      status: 409,
    });

    const state = await readMaintenanceState();
    expect(timeline(state)).toEqual([["started", "First published message."]]);
    expect(state.version).toBe(2);
    const audits = await getDb().select({ id: auditLog.id }).from(auditLog)
      .where(inArray(auditLog.entityType, ["instance_maintenance", "maintenance_window"]));
    expect(audits).toHaveLength(1);

    await fixture.cleanup();
  });

  it("lets only one of two concurrent mutations against the same version succeed", async () => {
    const fixture = await createIntegrationFixture("maintenance-concurrent");
    const admin = fixture.users.admin;
    const attempt = () => openMaintenanceWindow(admin.id, 1, { body: "Concurrent activation attempt.", expectedEndAt: null });

    const results = await Promise.allSettled([attempt(), attempt()]);
    const fulfilled = results.filter((result) => result.status === "fulfilled");
    const rejected = results.filter((result) => result.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({
      code: expect.stringMatching(/maintenance_state_stale|maintenance_already_open/u),
    });

    const state = await readMaintenanceState();
    expect(state.version).toBe(2);
    const audits = await getDb().select({ id: auditLog.id }).from(auditLog).where(eq(auditLog.action, "maintenance_window_opened"));
    expect(audits).toHaveLength(1);

    await fixture.cleanup();
  });

  it("persists an open window across a database connection restart", async () => {
    const fixture = await createIntegrationFixture("maintenance-restart");
    const admin = fixture.users.admin;

    const before = await openMaintenanceWindow(admin.id, 1, { body: "Persisted across a restart.", expectedEndAt: null });

    // Simulates the application process restarting: the only thing that can
    // survive is what actually committed to PostgreSQL, not anything cached
    // in this process.
    await closeDatabase();

    const after = await readMaintenanceState();
    expect(after.active).toBe(true);
    expect(timeline(after)).toEqual([["started", "Persisted across a restart."]]);
    expect(after.version).toBe(before.version);

    await fixture.cleanup();
  });

  it("rejects hostile message text by the application bounds, and never logs message text", async () => {
    const fixture = await createIntegrationFixture("maintenance-hostile");
    const admin = fixture.users.admin;

    const tooLong = "x".repeat(501);
    const tooManyLines = Array.from({ length: 9 }, (_, index) => `line ${index}`).join("\n");
    const withControlCharacter = "Scheduled work tonight.";
    const secretMarker = `secret-marker-${fixture.household.id}`;

    await expect(openMaintenanceWindow(admin.id, 1, { body: tooLong, expectedEndAt: null })).rejects.toMatchObject({
      code: "maintenance_message_invalid",
      status: 422,
    });
    await expect(openMaintenanceWindow(admin.id, 1, { body: tooManyLines, expectedEndAt: null })).rejects.toMatchObject({
      code: "maintenance_message_invalid",
    });
    await expect(openMaintenanceWindow(admin.id, 1, { body: withControlCharacter, expectedEndAt: null })).rejects.toMatchObject({
      code: "maintenance_message_invalid",
    });

    const logSpies = [
      vi.spyOn(console, "log").mockImplementation(() => {}),
      vi.spyOn(console, "warn").mockImplementation(() => {}),
      vi.spyOn(console, "error").mockImplementation(() => {}),
    ];
    try {
      await openMaintenanceWindow(admin.id, 1, { body: secretMarker, expectedEndAt: null });
      const logged = logSpies.flatMap((spy) => spy.mock.calls).map((call) => JSON.stringify(call)).join("\n");
      expect(logged).not.toContain(secretMarker);
    } finally {
      logSpies.forEach((spy) => spy.mockRestore());
    }

    // None of the three rejected attempts moved the version or left an audit
    // row; only the final, valid activation did.
    const state = await readMaintenanceState();
    expect(state.version).toBe(2);
    const audits = await getDb().select({ id: auditLog.id }).from(auditLog)
      .where(inArray(auditLog.entityType, ["instance_maintenance", "maintenance_window"]));
    expect(audits).toHaveLength(1);

    await fixture.cleanup();
  });

  it("requires an active instance administrator for every mutation", async () => {
    const fixture = await createIntegrationFixture("maintenance-authz");
    const member = fixture.users.member;

    await expect(openMaintenanceWindow(member.id, 1, { body: "Not an administrator.", expectedEndAt: null })).rejects.toMatchObject({
      code: "administrator_required",
      status: 403,
    });

    await fixture.disableUser("admin");
    await expect(openMaintenanceWindow(fixture.users.admin.id, 1, { body: "Disabled administrator.", expectedEndAt: null }))
      .rejects.toMatchObject({ code: "administrator_required" });

    await fixture.cleanup();
  });

  it("refuses to publish, revise or end when no window is open and nothing is due", async () => {
    const fixture = await createIntegrationFixture("maintenance-not-active");
    const admin = fixture.users.admin;

    await expect(publishMaintenanceUpdate(admin.id, 1, "No maintenance is active.")).rejects.toMatchObject({
      code: "maintenance_not_active",
      status: 409,
    });
    await expect(reviseMaintenanceExpectedEnd(admin.id, 1, null)).rejects.toMatchObject({ code: "maintenance_not_active" });
    await expect(endMaintenance(admin.id, 1)).rejects.toMatchObject({ code: "maintenance_not_active" });

    await fixture.cleanup();
  });

  it("orders scheduled windows scheduled_start_at ASC, id ASC and retains a cancelled row", async () => {
    const fixture = await createIntegrationFixture("maintenance-window-order");
    const admin = fixture.users.admin;
    const now = Date.now();

    const afterSecond = await scheduleMaintenanceWindow(admin.id, 1, {
      body: "Second window.",
      scheduledStartAt: new Date(now + 2 * 86_400_000),
      expectedEndAt: null,
    });
    const afterFirst = await scheduleMaintenanceWindow(admin.id, afterSecond.version, {
      body: "First window.",
      scheduledStartAt: new Date(now + 86_400_000),
      expectedEndAt: null,
    });
    expect(afterFirst.scheduledWindows.map((window) => window.updates[0].body)).toEqual(["First window.", "Second window."]);

    const toCancel = afterFirst.scheduledWindows[0];
    const afterCancel = await cancelMaintenanceWindow(admin.id, afterFirst.version, toCancel.id);
    expect(afterCancel.scheduledWindows.map((window) => window.id)).toEqual([afterFirst.scheduledWindows[1].id]);

    const [cancelledRow] = await getDb().select().from(maintenanceWindows).where(eq(maintenanceWindows.id, toCancel.id));
    expect(cancelledRow.status).toBe("cancelled");
    expect(cancelledRow.cancelledAt).not.toBeNull();
    // Cancellation retains the entry it published, too.
    expect(await getDb().select().from(maintenanceUpdates).where(eq(maintenanceUpdates.windowId, toCancel.id))).toHaveLength(1);

    await expect(cancelMaintenanceWindow(admin.id, afterCancel.version, toCancel.id)).rejects.toMatchObject({
      code: "maintenance_window_not_scheduled",
      status: 404,
    });

    const audits = await getDb().select({ action: auditLog.action, entityId: auditLog.entityId })
      .from(auditLog).where(eq(auditLog.entityType, "maintenance_window")).orderBy(asc(auditLog.createdAt));
    expect(audits.map((row) => row.action)).toEqual([
      "maintenance_window_scheduled",
      "maintenance_window_scheduled",
      "maintenance_window_cancelled",
    ]);
    expect(audits[2].entityId).toBe(toCancel.id);

    await fixture.cleanup();
  });

  it("computes effective activity from a due scheduled window while the singleton stays inactive", async () => {
    const fixture = await createIntegrationFixture("maintenance-effective");
    await scheduleAndLetFallDue(fixture.users.admin.id, 1, { body: "Already due.", expectedEndAt: null });

    const state = await readMaintenanceState();
    expect(state.active).toBe(false);
    expect(state.effectivelyActive).toBe(true);

    await fixture.cleanup();
  });

  it("accepts any number of scheduled windows: the pending cap is gone", async () => {
    const fixture = await createIntegrationFixture("maintenance-no-cap");
    const admin = fixture.users.admin;

    let state = await readMaintenanceState();
    for (let index = 0; index < 14; index += 1) {
      state = await scheduleMaintenanceWindow(admin.id, state.version, {
        body: `Window ${index}.`,
        scheduledStartAt: new Date(Date.now() + (index + 1) * 3_600_000),
        expectedEndAt: null,
      });
    }
    expect(state.scheduledWindows).toHaveLength(14);

    await fixture.cleanup();
  });
});

describe("editability boundaries (ADR-0013 decision 8, #585)", () => {
  it("edits an entry's body, stamps edited_at and writes the prior text to audit", async () => {
    const fixture = await createIntegrationFixture("maintenance-edit-body");
    const admin = fixture.users.admin;

    const opened = await openMaintenanceWindow(admin.id, 1, { body: "Back at sux.", expectedEndAt: null });
    const target = opened.openWindow!.updates[0];
    const edited = await editMaintenanceUpdate(admin.id, opened.version, target.id, "Back at six.");

    const entry = edited.openWindow!.updates[0];
    expect(entry.id).toBe(target.id);
    expect(entry.body).toBe("Back at six.");
    expect(entry.editedAt).not.toBeNull();
    // Immutable by decision 8: re-dating an entry or re-stating its kind
    // would falsify the narrative it exists to record.
    expect(entry.kind).toBe(target.kind);
    expect(entry.windowId).toBe(target.windowId);
    expect(entry.publishedAt.getTime()).toBe(target.publishedAt.getTime());
    // Nothing is lost: the private, append-only record keeps the prior text.
    const [audit] = await getDb().select({ changes: auditLog.changes }).from(auditLog)
      .where(eq(auditLog.action, "maintenance_window_updated"));
    expect(audit.changes).toMatchObject({ previousBody: "Back at sux.", body: "Back at six.", edited: true });

    await fixture.cleanup();
  });

  it("never deletes: correcting an entry leaves exactly one row, not two", async () => {
    const fixture = await createIntegrationFixture("maintenance-edit-retains");
    const admin = fixture.users.admin;

    const opened = await openMaintenanceWindow(admin.id, 1, { body: "First wording.", expectedEndAt: null });
    await editMaintenanceUpdate(admin.id, opened.version, opened.openWindow!.updates[0].id, "Second wording.");

    expect(await getDb().select().from(maintenanceUpdates)).toHaveLength(1);

    await fixture.cleanup();
  });

  it("reschedules and cancels only before a window opens, never after", async () => {
    const fixture = await createIntegrationFixture("maintenance-reschedule-bounds");
    const admin = fixture.users.admin;

    const scheduled = await scheduleMaintenanceWindow(admin.id, 1, {
      body: "Movable.",
      scheduledStartAt: new Date(Date.now() + 86_400_000),
      expectedEndAt: null,
    });
    const windowId = scheduled.scheduledWindows[0].id;
    const movedTo = new Date(Date.now() + 2 * 86_400_000);
    const moved = await rescheduleMaintenanceWindow(admin.id, scheduled.version, windowId, {
      scheduledStartAt: movedTo,
      expectedEndAt: null,
    });
    expect(moved.scheduledWindows[0].scheduledStartAt?.getTime()).toBe(movedTo.getTime());

    // Once open, neither (decision 8).
    await getDb().update(maintenanceWindows)
      .set({ status: "open", startedAt: new Date(), scheduledStartAt: new Date(Date.now() - 60_000) })
      .where(eq(maintenanceWindows.id, windowId));
    let state = await readMaintenanceState();
    await expect(rescheduleMaintenanceWindow(admin.id, state.version, windowId, {
      scheduledStartAt: movedTo,
      expectedEndAt: null,
    })).rejects.toMatchObject({ code: "maintenance_window_not_scheduled", status: 404 });
    state = await readMaintenanceState();
    await expect(cancelMaintenanceWindow(admin.id, state.version, windowId))
      .rejects.toMatchObject({ code: "maintenance_window_not_scheduled" });

    await fixture.cleanup();
  });

  it("lets an administrator revise the open window's expected end, keeping the guard's copy in step", async () => {
    const fixture = await createIntegrationFixture("maintenance-revise-end");
    const admin = fixture.users.admin;

    const opened = await openMaintenanceWindow(admin.id, 1, {
      body: "Back within the hour.",
      expectedEndAt: new Date(Date.now() + 3_600_000),
    });
    await expectDenormalisedEndConsistent();

    // An administrator saying so may shorten it. What may never shorten it
    // automatically is the machinery — that is the absorb rule, not this.
    const shortened = new Date(Date.now() + 600_000);
    const revised = await reviseMaintenanceExpectedEnd(admin.id, opened.version, shortened);
    expect(revised.openWindow?.expectedEndAt?.getTime()).toBe(shortened.getTime());
    expect(revised.expectedEndAt?.getTime()).toBe(shortened.getTime());
    await expectDenormalisedEndConsistent();

    await fixture.cleanup();
  });
});

describe("at most one open window (#585)", () => {
  it("is enforced by the database, not by application logic", async () => {
    const fixture = await createIntegrationFixture("maintenance-one-open");
    await openMaintenanceWindow(fixture.users.admin.id, 1, { body: "The open one.", expectedEndAt: null });

    /* Drizzle wraps the driver error, so the index that refused the write is
       named on the cause. Asserting it by name is the point: this must fail
       in PostgreSQL, not in a check the application could forget to make. */
    const refused = await getDb().insert(maintenanceWindows).values({
      status: "open",
      startedAt: new Date(),
    }).then(() => null, (error: unknown) => error);
    expect(refused).toBeInstanceOf(Error);
    expect((refused as { cause?: { constraint_name?: string } }).cause?.constraint_name)
      .toBe("maintenance_window_open_unique");

    // Resolved and cancelled rows are outside the partial index, so any
    // number of them may coexist with the open one.
    await getDb().insert(maintenanceWindows).values([
      { status: "resolved", startedAt: new Date(), endedAt: new Date() },
      { status: "resolved", startedAt: new Date(), endedAt: new Date() },
      { status: "cancelled", cancelledAt: new Date() },
    ]);
    expect(await getDb().select().from(maintenanceWindows)).toHaveLength(4);

    await fixture.cleanup();
  });

  it("refuses to open a second window through the domain", async () => {
    const fixture = await createIntegrationFixture("maintenance-second-open");
    const admin = fixture.users.admin;
    const opened = await openMaintenanceWindow(admin.id, 1, { body: "The open one.", expectedEndAt: null });

    await expect(openMaintenanceWindow(admin.id, opened.version, { body: "A second one.", expectedEndAt: null }))
      .rejects.toMatchObject({ code: "maintenance_already_open", status: 409 });

    await fixture.cleanup();
  });
});

/* ADR-0015 decision 5 (#524): ending maintenance ends *effective* maintenance.
   Carried over unchanged from due unclaimed notices to due scheduled windows
   (#585): clearing the singleton alone would leave a due window pinning the
   instance closed, and the worker would re-close it seconds later. */
describe("ending maintenance ends effective maintenance (#524)", () => {
  it("ends maintenance that only a due scheduled window is holding open, cancelling that window", async () => {
    const fixture = await createIntegrationFixture("end-cancels-due-window");
    const admin = fixture.users.admin;

    const { windowId } = await scheduleAndLetFallDue(admin.id, 1, {
      body: "A window that has already come due.",
      expectedEndAt: null,
    });
    const pinned = await readMaintenanceState();
    expect(pinned.active).toBe(false);
    expect(pinned.effectivelyActive).toBe(true);

    const ended = await endMaintenance(admin.id, pinned.version);
    expect(ended.effectivelyActive).toBe(false);
    expect(ended.scheduledWindows).toEqual([]);
    const [row] = await getDb().select().from(maintenanceWindows).where(eq(maintenanceWindows.id, windowId));
    expect(row.status).toBe("cancelled");
    expect(row.cancelledAt).not.toBeNull();

    await fixture.cleanup();
  });

  it("leaves a window that is not yet due standing", async () => {
    const fixture = await createIntegrationFixture("end-keeps-future-window");
    const admin = fixture.users.admin;

    const opened = await openMaintenanceWindow(admin.id, 1, { body: "Today's window.", expectedEndAt: null });
    const scheduled = await scheduleMaintenanceWindow(admin.id, opened.version, {
      body: "Next week's window.",
      scheduledStartAt: new Date(Date.now() + 604_800_000),
      expectedEndAt: null,
    });

    const ended = await endMaintenance(admin.id, scheduled.version);
    expect(ended.active).toBe(false);
    expect(ended.effectivelyActive).toBe(false);
    // Ending today's maintenance is not a decision about next week.
    expect(ended.scheduledWindows).toHaveLength(1);
    expect(ended.scheduledWindows[0].cancelledAt).toBeNull();

    await fixture.cleanup();
  });

  it("records how many due windows the ending cancelled", async () => {
    const fixture = await createIntegrationFixture("end-audits-cancelled-count");
    const admin = fixture.users.admin;

    await scheduleAndLetFallDue(admin.id, 1, { body: "Due window one.", expectedEndAt: null });
    const state = await readMaintenanceState();
    await endMaintenance(admin.id, state.version);

    const [ending] = await getDb()
      .select({ changes: auditLog.changes, entityType: auditLog.entityType, entityId: auditLog.entityId })
      .from(auditLog)
      .where(eq(auditLog.action, "maintenance_ended"));
    expect(ending.changes).toMatchObject({ active: false, cancelledWindows: 1 });
    // Nothing was open, so this is a singleton-level change and keeps the
    // singleton's stable entity id.
    expect(ending.entityType).toBe("instance_maintenance");
    expect(ending.entityId).toBe(state.id);

    await fixture.cleanup();
  });

  it("still answers a stale version with 409, cancelling nothing", async () => {
    const fixture = await createIntegrationFixture("end-stale-with-due-window");
    const admin = fixture.users.admin;

    await scheduleAndLetFallDue(admin.id, 1, { body: "Due, and about to be raced.", expectedEndAt: null });

    await expect(endMaintenance(admin.id, 1)).rejects.toMatchObject({
      code: "maintenance_state_stale",
      status: 409,
    });
    const state = await readMaintenanceState();
    expect(state.effectivelyActive).toBe(true);
    expect(state.scheduledWindows[0].cancelledAt).toBeNull();
    expect(await getDb().select().from(auditLog).where(eq(auditLog.action, "maintenance_ended"))).toHaveLength(0);

    await fixture.cleanup();
  });
});

describe("scheduled windows open durably and exactly once (#525)", () => {
  it("opens a due window and copies it into the singleton with one audit event", async () => {
    const fixture = await createIntegrationFixture("maintenance-tick-activates");
    const expectedEndAt = new Date(Date.now() + 3_600_000);
    const { windowId } = await scheduleAndLetFallDue(fixture.users.admin.id, 1, {
      body: "Scheduled database upgrade.",
      expectedEndAt,
    });

    const result = await activateDueMaintenanceWindow();
    expect(result.openedWindowId).toBe(windowId);

    const state = await readMaintenanceState();
    expect(state.active).toBe(true);
    expect(state.effectivelyActive).toBe(true);
    expect(state.expectedEndAt?.getTime()).toBe(expectedEndAt.getTime());
    expect(state.openWindow?.startedAt).not.toBeNull();
    await expectDenormalisedEndConsistent();

    const events = await getDb().select().from(auditLog)
      .where(eq(auditLog.action, "maintenance_activated_scheduled"));
    expect(events).toHaveLength(1);
    expect(events[0].actorUserId).toBeNull();
    expect(events[0].entityType).toBe("maintenance_window");
    expect(events[0].entityId).toBe(windowId);
  });

  it("lets only one of two racing ticks open the same window, writing one audit event", async () => {
    const fixture = await createIntegrationFixture("maintenance-tick-race");
    const { windowId } = await scheduleAndLetFallDue(fixture.users.admin.id, 1, {
      body: "Scheduled database upgrade.", expectedEndAt: null,
    });

    /* The race has to be forced, not hoped for. Two ticks fired at once
       normally serialise, and the second's select then filters the claimed
       window out on its own - so the test would pass even with no conditional
       claim at all. Holding the first tick between its select and its claim,
       and letting the second run to completion inside that window, is the
       only interleaving where the conditional claim is what does the work.

       The second tick runs on its own connection, because the first is
       holding the singleton row lock; that lock is released only when the
       first transaction ends, so the second is released into its claim at
       exactly the moment the first resumes. */
    let releaseFirst: (() => void) | undefined;
    const firstReachedClaim = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let firstIsWaiting: (() => void) | undefined;
    const firstHasSelected = new Promise<void>((resolve) => { firstIsWaiting = resolve; });

    const first = activateDueMaintenanceWindow({
      beforeClaim: async () => {
        firstIsWaiting?.();
        await firstReachedClaim;
      },
    });

    await firstHasSelected;
    const second = activateDueMaintenanceWindow();
    // Both are now parked: the first on the test's own promise, the second on
    // the singleton row lock the first holds.
    releaseFirst?.();
    const [firstResult, secondResult] = await Promise.all([first, second]);

    const opened = [firstResult.openedWindowId, secondResult.openedWindowId].filter(Boolean);
    expect(opened).toEqual([windowId]);

    const events = await getDb().select().from(auditLog)
      .where(eq(auditLog.action, "maintenance_activated_scheduled"));
    expect(events).toHaveLength(1);

    // One activation means one version increment, not two.
    const state = await readMaintenanceState();
    expect(state.version).toBe(3);
    const [claimed] = await getDb().select().from(maintenanceWindows).where(eq(maintenanceWindows.id, windowId));
    expect(claimed.status).toBe("open");
    expect(claimed.startedAt).not.toBeNull();
  });

  it("leaves nothing durable when the transition fails before commit, and completes on the next tick", async () => {
    const fixture = await createIntegrationFixture("maintenance-tick-crash");
    const { windowId } = await scheduleAndLetFallDue(fixture.users.admin.id, 1, {
      body: "Scheduled database upgrade.", expectedEndAt: null,
    });
    const versionBefore = (await readMaintenanceState()).version;

    await expect(activateDueMaintenanceWindow({
      beforeCommit: async () => { throw new Error("process died mid-transition"); },
    })).rejects.toThrow("process died mid-transition");

    // The claim, the singleton write, the appended entry and the audit row
    // all roll back together.
    const crashed = await readMaintenanceState();
    expect(crashed.active).toBe(false);
    expect(crashed.version).toBe(versionBefore);
    expect(crashed.scheduledWindows[0].id).toBe(windowId);
    expect(crashed.scheduledWindows[0].updates).toHaveLength(1);
    expect(await getDb().select().from(auditLog)
      .where(eq(auditLog.action, "maintenance_activated_scheduled"))).toHaveLength(0);

    const retried = await activateDueMaintenanceWindow();
    expect(retried.openedWindowId).toBe(windowId);
    expect((await readMaintenanceState()).active).toBe(true);
  });

  it("never opens a window cancelled before its start time", async () => {
    const fixture = await createIntegrationFixture("maintenance-tick-cancelled");
    const admin = fixture.users.admin;
    const scheduled = await scheduleMaintenanceWindow(admin.id, 1, {
      body: "Upgrade that gets called off.",
      scheduledStartAt: new Date(Date.now() + 3_600_000),
      expectedEndAt: null,
    });
    const windowId = scheduled.scheduledWindows[0].id;
    await cancelMaintenanceWindow(admin.id, scheduled.version, windowId);

    // Move the cancelled window's start time into the past: cancellation, not
    // timing, is what must keep it from ever opening.
    await getDb().update(maintenanceWindows)
      .set({ scheduledStartAt: new Date(Date.now() - 60_000) })
      .where(eq(maintenanceWindows.id, windowId));

    const result = await activateDueMaintenanceWindow();
    expect(result).toEqual({ openedWindowId: null, absorbedWindowId: null });

    const state = await readMaintenanceState();
    expect(state.active).toBe(false);
    expect(state.effectivelyActive).toBe(false);
    expect(await getDb().select().from(auditLog)
      .where(eq(auditLog.action, "maintenance_activated_scheduled"))).toHaveLength(0);
  });

  it("leaves a window that is not yet due unclaimed", async () => {
    const fixture = await createIntegrationFixture("maintenance-tick-not-due");
    await scheduleMaintenanceWindow(fixture.users.admin.id, 1, {
      body: "Not yet.", scheduledStartAt: new Date(Date.now() + 3_600_000), expectedEndAt: null,
    });

    const result = await activateDueMaintenanceWindow();
    expect(result).toEqual({ openedWindowId: null, absorbedWindowId: null });
    const state = await readMaintenanceState();
    expect(state.active).toBe(false);
    expect(state.effectivelyActive).toBe(false);
  });

  it("opens the earliest due window first, one per tick", async () => {
    const fixture = await createIntegrationFixture("maintenance-tick-order");
    const admin = fixture.users.admin;
    const earlier = new Date(Date.now() - 120_000);
    const later = new Date(Date.now() - 60_000);
    const first = await scheduleAndLetFallDue(admin.id, 1, { body: "Later window.", expectedEndAt: null });
    const second = await scheduleAndLetFallDue(admin.id, first.state.version, { body: "Earlier window.", expectedEndAt: null });
    await getDb().update(maintenanceWindows).set({ scheduledStartAt: later }).where(eq(maintenanceWindows.id, first.windowId));
    await getDb().update(maintenanceWindows).set({ scheduledStartAt: earlier }).where(eq(maintenanceWindows.id, second.windowId));

    const result = await activateDueMaintenanceWindow();
    expect(result.openedWindowId).toBe(second.windowId);
    const state = await readMaintenanceState();
    expect(state.openWindow?.updates.map((entry) => entry.body)).toEqual(["Earlier window.", "Earlier window."]);
    // One per tick: the later one is still waiting.
    expect(state.scheduledWindows.map((window) => window.id)).toEqual([first.windowId]);
  });

  it("makes a scheduled activation visible to a second connection without a restart", async () => {
    const fixture = await createIntegrationFixture("maintenance-tick-second-process");
    await scheduleAndLetFallDue(fixture.users.admin.id, 1, {
      body: "Scheduled database upgrade.", expectedEndAt: null,
    });

    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL is required for maintenance worker integration tests");
    // A connection opened before the transition stands in for a second
    // application process that is already running: nothing caches maintenance
    // state, so it must observe the change without reconnecting or restarting.
    const client = postgres(url, { max: 1, prepare: false });
    const other = drizzle(client, { schema });
    try {
      const [before] = await other.select().from(schema.instanceMaintenance).limit(1);
      expect(before.active).toBe(false);

      await activateDueMaintenanceWindow();

      const [after] = await other.select().from(schema.instanceMaintenance).limit(1);
      expect(after.active).toBe(true);
      expect(after.currentWindowId).not.toBeNull();
      expect(after.version).toBe(before.version + 1);
    } finally {
      await client.end({ timeout: 5 });
    }
  });

  it("stores scheduled instants as UTC, unchanged by the server's local zone", async () => {
    const fixture = await createIntegrationFixture("maintenance-tick-utc");
    const scheduledStartAt = new Date("2026-11-03T02:30:00.000Z");
    const scheduled = await scheduleMaintenanceWindow(fixture.users.admin.id, 1, {
      body: "Scheduled database upgrade.", scheduledStartAt, expectedEndAt: null,
    });
    expect(scheduled.scheduledWindows[0].scheduledStartAt?.toISOString()).toBe("2026-11-03T02:30:00.000Z");

    const [row] = await getDb().select().from(maintenanceWindows)
      .where(eq(maintenanceWindows.id, scheduled.scheduledWindows[0].id));
    expect(row.scheduledStartAt?.getTime()).toBe(scheduledStartAt.getTime());
  });
});

/* The collision #525 surfaced and #580 ratified an answer for: a scheduled
   window falling due during an open one is absorbed, not arbitrated, so an
   operator's stated Retry-After is never silently cut short. */
describe("a due window arriving during an open one is absorbed (#585)", () => {
  async function openThenLetAnotherFallDue(adminId: string, params: {
    openEndAt: Date | null;
    dueEndAt: Date | null;
  }) {
    const opened = await openMaintenanceWindow(adminId, 1, {
      body: "Operator's window, back in two hours.",
      expectedEndAt: params.openEndAt,
    });
    const { windowId } = await scheduleAndLetFallDue(adminId, opened.version, {
      body: "Scheduled window that came due mid-flight.",
      expectedEndAt: params.dueEndAt,
    });
    return { openWindowId: opened.openWindow!.id, dueWindowId: windowId };
  }

  it("appends the due window's text, marks it absorbed, and never shortens the expected end", async () => {
    const fixture = await createIntegrationFixture("maintenance-absorb-shorter");
    const openEndAt = new Date(Date.now() + 7_200_000);
    const dueEndAt = new Date(Date.now() + 1_800_000);
    const { openWindowId, dueWindowId } = await openThenLetAnotherFallDue(fixture.users.admin.id, { openEndAt, dueEndAt });
    const versionBefore = (await readMaintenanceState()).version;

    const result = await activateDueMaintenanceWindow();
    expect(result).toEqual({ openedWindowId: null, absorbedWindowId: dueWindowId });

    const state = await readMaintenanceState();
    // The open window is still the open one, and still the later end.
    expect(state.openWindow?.id).toBe(openWindowId);
    expect(state.openWindow?.expectedEndAt?.getTime()).toBe(openEndAt.getTime());
    expect(state.expectedEndAt?.getTime()).toBe(openEndAt.getTime());
    await expectDenormalisedEndConsistent();
    expect(state.version).toBe(versionBefore + 1);

    // Its text arrives as a follow-on entry on the open window's timeline.
    expect(timeline(state)).toEqual([
      ["started", "Operator's window, back in two hours."],
      ["update", "Scheduled window that came due mid-flight."],
    ]);

    // The absorbed window never entered `open`: no started_at, and it points
    // at what took it over. Its own scheduled entry is retained.
    const [absorbed] = await getDb().select().from(maintenanceWindows).where(eq(maintenanceWindows.id, dueWindowId));
    expect(absorbed.status).toBe("absorbed");
    expect(absorbed.absorbedIntoId).toBe(openWindowId);
    expect(absorbed.startedAt).toBeNull();
    expect(await getDb().select().from(maintenanceUpdates).where(eq(maintenanceUpdates.windowId, dueWindowId)))
      .toHaveLength(1);

    const [event] = await getDb().select().from(auditLog).where(eq(auditLog.action, "maintenance_window_absorbed"));
    expect(event.entityType).toBe("maintenance_window");
    expect(event.entityId).toBe(openWindowId);
    expect(event.actorUserId).toBeNull();
    expect(event.changes).toMatchObject({ absorbedWindowId: dueWindowId });
    expect(await getDb().select().from(auditLog).where(eq(auditLog.action, "maintenance_activated_scheduled"))).toHaveLength(0);

    await fixture.cleanup();
  });

  it("extends the expected end when the absorbed window runs later", async () => {
    const fixture = await createIntegrationFixture("maintenance-absorb-longer");
    const openEndAt = new Date(Date.now() + 1_800_000);
    const dueEndAt = new Date(Date.now() + 7_200_000);
    const { openWindowId } = await openThenLetAnotherFallDue(fixture.users.admin.id, { openEndAt, dueEndAt });

    await activateDueMaintenanceWindow();

    const state = await readMaintenanceState();
    expect(state.openWindow?.id).toBe(openWindowId);
    expect(state.openWindow?.expectedEndAt?.getTime()).toBe(dueEndAt.getTime());
    expect(state.expectedEndAt?.getTime()).toBe(dueEndAt.getTime());
    await expectDenormalisedEndConsistent();

    await fixture.cleanup();
  });

  it("drops to no stated end when either window has none, because that is the later of the two", async () => {
    const fixture = await createIntegrationFixture("maintenance-absorb-open-ended");
    const openEndAt = new Date(Date.now() + 1_800_000);
    await openThenLetAnotherFallDue(fixture.users.admin.id, { openEndAt, dueEndAt: null });

    await activateDueMaintenanceWindow();

    const state = await readMaintenanceState();
    // An unstated end is unbounded, so adopting it never shortens anything;
    // keeping the old one would keep promising a time nobody now believes.
    expect(state.openWindow?.expectedEndAt).toBeNull();
    expect(state.expectedEndAt).toBeNull();
    await expectDenormalisedEndConsistent();

    await fixture.cleanup();
  });

  it("absorbs a backlog one tick at a time, and the open window stays the only open one", async () => {
    const fixture = await createIntegrationFixture("maintenance-absorb-backlog");
    const admin = fixture.users.admin;
    const opened = await openMaintenanceWindow(admin.id, 1, {
      body: "Operator's window.",
      expectedEndAt: new Date(Date.now() + 7_200_000),
    });
    const first = await scheduleAndLetFallDue(admin.id, opened.version, { body: "First due.", expectedEndAt: null });
    const second = await scheduleAndLetFallDue(admin.id, first.state.version, { body: "Second due.", expectedEndAt: null });

    expect((await activateDueMaintenanceWindow()).absorbedWindowId).not.toBeNull();
    expect((await activateDueMaintenanceWindow()).absorbedWindowId).not.toBeNull();
    expect(await activateDueMaintenanceWindow()).toEqual({ openedWindowId: null, absorbedWindowId: null });

    const rows = await getDb().select().from(maintenanceWindows);
    expect(rows.filter((row) => row.status === "open").map((row) => row.id)).toEqual([opened.openWindow!.id]);
    expect(rows.filter((row) => row.status === "absorbed").map((row) => row.id).sort())
      .toEqual([first.windowId, second.windowId].sort());
    const state = await readMaintenanceState();
    expect(timeline(state).map(([, body]) => body)).toEqual(["Operator's window.", "First due.", "Second due."]);

    await fixture.cleanup();
  });

  it("retains resolved and absorbed rows after the window is ended", async () => {
    const fixture = await createIntegrationFixture("maintenance-absorb-retention");
    const admin = fixture.users.admin;
    const { openWindowId, dueWindowId } = await openThenLetAnotherFallDue(admin.id, {
      openEndAt: new Date(Date.now() + 7_200_000),
      dueEndAt: null,
    });
    await activateDueMaintenanceWindow();

    const state = await readMaintenanceState();
    await endMaintenance(admin.id, state.version);

    const rows = await getDb().select().from(maintenanceWindows).orderBy(asc(maintenanceWindows.createdAt));
    expect(new Map(rows.map((row) => [row.id, row.status]))).toEqual(new Map([
      [openWindowId, "resolved"],
      [dueWindowId, "absorbed"],
    ]));
    // Nothing is ever deleted, and neither window is displayed again.
    expect(await getDb().select().from(maintenanceUpdates)).toHaveLength(3);
    const after = await readMaintenanceState();
    expect(after.openWindow).toBeNull();
    expect(after.scheduledWindows).toEqual([]);
    expect(after.effectivelyActive).toBe(false);

    await fixture.cleanup();
  });
});
