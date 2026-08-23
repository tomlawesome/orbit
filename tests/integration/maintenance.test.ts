import { asc, eq, inArray } from "drizzle-orm";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { closeDatabase, getDb } from "@/db";
import { auditLog, instanceMaintenance, maintenanceNotices } from "@/db/schema";
import {
  activateMaintenance,
  cancelMaintenanceNotice,
  editMaintenanceMessage,
  endMaintenance,
  readMaintenanceState,
  scheduleMaintenanceNotice,
} from "@/server/maintenance";
import { cleanupIntegrationEnvironment, createIntegrationFixture } from "./support/fixtures";

afterAll(async () => {
  await cleanupIntegrationEnvironment();
});

/* instance_maintenance is a database-wide singleton the 0028 migration seeds
   once (never deleted, unlike instance_authority's #263 precedent, because
   this table has no foreign key forcing conditional seeding). Every test
   restores it to that seeded shape, and clears notices and this feature's
   audit rows, so sibling tests never observe a leaked version or message. */
afterEach(async () => {
  await getDb().delete(maintenanceNotices);
  await getDb().delete(auditLog).where(inArray(auditLog.entityType, ["instance_maintenance"]));
  await getDb().update(instanceMaintenance).set({
    active: false,
    message: null,
    messagePublishedAt: null,
    expectedEndAt: null,
    activatedAt: null,
    version: 1,
    updatedAt: new Date(),
  });
});

describe("maintenance state, versioned mutations and audit (#522)", () => {
  it("activates, edits and ends maintenance, auditing each transition against the stable state id", async () => {
    const fixture = await createIntegrationFixture("maintenance-lifecycle");
    const admin = fixture.users.admin;

    const activated = await activateMaintenance(admin.id, 1, {
      message: "Starting a database upgrade.",
      expectedEndAt: new Date(Date.now() + 3_600_000),
    });
    expect(activated.active).toBe(true);
    expect(activated.effectivelyActive).toBe(true);
    expect(activated.version).toBe(2);
    expect(activated.message).toBe("Starting a database upgrade.");

    const edited = await editMaintenanceMessage(admin.id, activated.version, "Still upgrading the database.");
    expect(edited.message).toBe("Still upgrading the database.");
    expect(edited.version).toBe(3);

    const ended = await endMaintenance(admin.id, edited.version);
    expect(ended.active).toBe(false);
    expect(ended.effectivelyActive).toBe(false);
    expect(ended.message).toBeNull();
    expect(ended.version).toBe(4);

    const audits = await getDb()
      .select({ action: auditLog.action, entityId: auditLog.entityId, actorUserId: auditLog.actorUserId, householdId: auditLog.householdId })
      .from(auditLog)
      .where(eq(auditLog.entityType, "instance_maintenance"))
      .orderBy(asc(auditLog.createdAt));
    expect(audits.map((row) => row.action)).toEqual(["maintenance_activated", "maintenance_message_edited", "maintenance_ended"]);
    expect(new Set(audits.map((row) => row.entityId))).toEqual(new Set([activated.id]));
    expect(audits.every((row) => row.householdId === null)).toBe(true);
    expect(audits.every((row) => row.actorUserId === admin.id)).toBe(true);

    await fixture.cleanup();
  });

  it("rejects a stale or replayed version with no state change and no audit row", async () => {
    const fixture = await createIntegrationFixture("maintenance-stale");
    const admin = fixture.users.admin;

    const activated = await activateMaintenance(admin.id, 1, { message: "First published message.", expectedEndAt: null });
    expect(activated.version).toBe(2);

    // Replays the version the caller already spent.
    await expect(editMaintenanceMessage(admin.id, 1, "This must not land.")).rejects.toMatchObject({
      code: "maintenance_state_stale",
      status: 409,
    });

    const state = await readMaintenanceState();
    expect(state.message).toBe("First published message.");
    expect(state.version).toBe(2);
    const audits = await getDb().select({ id: auditLog.id }).from(auditLog).where(eq(auditLog.entityType, "instance_maintenance"));
    expect(audits).toHaveLength(1);

    await fixture.cleanup();
  });

  it("lets only one of two concurrent mutations against the same version succeed", async () => {
    const fixture = await createIntegrationFixture("maintenance-concurrent");
    const admin = fixture.users.admin;
    const attempt = () => activateMaintenance(admin.id, 1, { message: "Concurrent activation attempt.", expectedEndAt: null });

    const results = await Promise.allSettled([attempt(), attempt()]);
    const fulfilled = results.filter((result) => result.status === "fulfilled");
    const rejected = results.filter((result) => result.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({ code: "maintenance_state_stale" });

    const state = await readMaintenanceState();
    expect(state.version).toBe(2);
    const audits = await getDb().select({ id: auditLog.id }).from(auditLog).where(eq(auditLog.action, "maintenance_activated"));
    expect(audits).toHaveLength(1);

    await fixture.cleanup();
  });

  it("persists activated state across a database connection restart", async () => {
    const fixture = await createIntegrationFixture("maintenance-restart");
    const admin = fixture.users.admin;

    const before = await activateMaintenance(admin.id, 1, { message: "Persisted across a restart.", expectedEndAt: null });

    // Simulates the application process restarting: the only thing that can
    // survive is what actually committed to PostgreSQL, not anything cached
    // in this process.
    await closeDatabase();

    const after = await readMaintenanceState();
    expect(after.active).toBe(true);
    expect(after.message).toBe("Persisted across a restart.");
    expect(after.version).toBe(before.version);

    await fixture.cleanup();
  });

  it("rejects hostile message text by the application bounds, and never logs message text", async () => {
    const fixture = await createIntegrationFixture("maintenance-hostile");
    const admin = fixture.users.admin;

    const tooLong = "x".repeat(501);
    const tooManyLines = Array.from({ length: 9 }, (_, index) => `line ${index}`).join("\n");
    const withControlCharacter = "Scheduled work tonight.";
    const secretMarker = `secret-marker-${fixture.household.id}`;

    await expect(activateMaintenance(admin.id, 1, { message: tooLong, expectedEndAt: null })).rejects.toMatchObject({
      code: "maintenance_message_invalid",
      status: 422,
    });
    await expect(activateMaintenance(admin.id, 1, { message: tooManyLines, expectedEndAt: null })).rejects.toMatchObject({
      code: "maintenance_message_invalid",
    });
    await expect(activateMaintenance(admin.id, 1, { message: withControlCharacter, expectedEndAt: null })).rejects.toMatchObject({
      code: "maintenance_message_invalid",
    });

    const logSpies = [
      vi.spyOn(console, "log").mockImplementation(() => {}),
      vi.spyOn(console, "warn").mockImplementation(() => {}),
      vi.spyOn(console, "error").mockImplementation(() => {}),
    ];
    try {
      await activateMaintenance(admin.id, 1, { message: secretMarker, expectedEndAt: null });
      const logged = logSpies.flatMap((spy) => spy.mock.calls).map((call) => JSON.stringify(call)).join("\n");
      expect(logged).not.toContain(secretMarker);
    } finally {
      logSpies.forEach((spy) => spy.mockRestore());
    }

    // None of the three rejected attempts moved the version or left an audit
    // row; only the final, valid activation did.
    const state = await readMaintenanceState();
    expect(state.version).toBe(2);
    const audits = await getDb().select({ id: auditLog.id }).from(auditLog).where(eq(auditLog.entityType, "instance_maintenance"));
    expect(audits).toHaveLength(1);

    await fixture.cleanup();
  });

  it("requires an active instance administrator for every mutation", async () => {
    const fixture = await createIntegrationFixture("maintenance-authz");
    const member = fixture.users.member;

    await expect(activateMaintenance(member.id, 1, { message: "Not an administrator.", expectedEndAt: null })).rejects.toMatchObject({
      code: "administrator_required",
      status: 403,
    });

    await fixture.disableUser("admin");
    await expect(activateMaintenance(fixture.users.admin.id, 1, { message: "Disabled administrator.", expectedEndAt: null }))
      .rejects.toMatchObject({ code: "administrator_required" });

    await fixture.cleanup();
  });

  it("refuses to edit or end maintenance that is not currently active", async () => {
    const fixture = await createIntegrationFixture("maintenance-not-active");
    const admin = fixture.users.admin;

    await expect(editMaintenanceMessage(admin.id, 1, "No maintenance is active.")).rejects.toMatchObject({
      code: "maintenance_not_active",
      status: 409,
    });
    await expect(endMaintenance(admin.id, 1)).rejects.toMatchObject({ code: "maintenance_not_active" });

    await fixture.cleanup();
  });

  it("orders notices starts_at ASC, id ASC and retains a cancelled row instead of deleting it", async () => {
    const fixture = await createIntegrationFixture("maintenance-notice-order");
    const admin = fixture.users.admin;
    const now = Date.now();

    const afterSecond = await scheduleMaintenanceNotice(admin.id, 1, {
      message: "Second window.",
      startsAt: new Date(now + 2 * 86_400_000),
      expectedEndAt: null,
    });
    const afterFirst = await scheduleMaintenanceNotice(admin.id, afterSecond.version, {
      message: "First window.",
      startsAt: new Date(now + 86_400_000),
      expectedEndAt: null,
    });
    expect(afterFirst.notices.map((notice) => notice.message)).toEqual(["First window.", "Second window."]);

    const toCancel = afterFirst.notices.find((notice) => notice.message === "First window.");
    if (!toCancel) throw new Error("Expected the first window notice to be present");
    const afterCancel = await cancelMaintenanceNotice(admin.id, afterFirst.version, toCancel.id);
    const cancelledNotice = afterCancel.notices.find((notice) => notice.id === toCancel.id);
    expect(cancelledNotice?.cancelledAt).not.toBeNull();

    const rows = await getDb().select({ id: maintenanceNotices.id }).from(maintenanceNotices).where(eq(maintenanceNotices.id, toCancel.id));
    expect(rows).toHaveLength(1);

    await expect(cancelMaintenanceNotice(admin.id, afterCancel.version, toCancel.id)).rejects.toMatchObject({
      code: "maintenance_notice_not_pending",
      status: 404,
    });

    const noticeAudits = await getDb().select({ action: auditLog.action, entityId: auditLog.entityId })
      .from(auditLog).where(eq(auditLog.entityType, "instance_maintenance")).orderBy(asc(auditLog.createdAt));
    expect(noticeAudits.map((row) => row.action)).toEqual([
      "maintenance_notice_scheduled",
      "maintenance_notice_scheduled",
      "maintenance_notice_cancelled",
    ]);
    expect(noticeAudits[2].entityId).toBe(toCancel.id);

    await fixture.cleanup();
  });

  it("rejects scheduling a 13th pending notice", async () => {
    const fixture = await createIntegrationFixture("maintenance-notice-cap");
    const admin = fixture.users.admin;

    let state = await readMaintenanceState();
    for (let index = 0; index < 12; index += 1) {
      state = await scheduleMaintenanceNotice(admin.id, state.version, {
        message: `Notice ${index}.`,
        startsAt: new Date(Date.now() + (index + 1) * 3_600_000),
        expectedEndAt: null,
      });
    }
    expect(state.notices).toHaveLength(12);

    await expect(scheduleMaintenanceNotice(admin.id, state.version, {
      message: "One too many.",
      startsAt: new Date(Date.now() + 13 * 3_600_000),
      expectedEndAt: null,
    })).rejects.toMatchObject({ code: "maintenance_notice_limit_reached", status: 409 });

    // The rejected 13th attempt still bumped nothing: version is unchanged.
    const after = await readMaintenanceState();
    expect(after.version).toBe(state.version);
    expect(after.notices).toHaveLength(12);

    await fixture.cleanup();
  });

  it("computes effective activity from a due, unclaimed notice even while the singleton stays inactive", async () => {
    const fixture = await createIntegrationFixture("maintenance-effective");
    const admin = fixture.users.admin;

    await scheduleMaintenanceNotice(admin.id, 1, {
      message: "Already due.",
      startsAt: new Date(Date.now() - 60_000),
      expectedEndAt: null,
    });

    const state = await readMaintenanceState();
    expect(state.active).toBe(false);
    expect(state.effectivelyActive).toBe(true);

    await fixture.cleanup();
  });
});

/* ADR-0015 decision 5 (#524): ending maintenance ends *effective* maintenance.
   Before this, `end` cleared the singleton and left due notices standing, so a
   due notice pinned the instance closed — and once #525's worker exists it
   would claim that stale notice and reopen maintenance seconds after an
   administrator ended it. */
describe("ending maintenance ends effective maintenance (#524)", () => {
  it("ends maintenance that only a due notice is holding open, cancelling that notice", async () => {
    const fixture = await createIntegrationFixture("end-cancels-due-notice");
    const admin = fixture.users.admin;

    await scheduleMaintenanceNotice(admin.id, 1, {
      message: "A window that has already come due.",
      startsAt: new Date(Date.now() - 60_000),
      expectedEndAt: null,
    });
    const pinned = await readMaintenanceState();
    expect(pinned.active).toBe(false);
    expect(pinned.effectivelyActive).toBe(true);

    const ended = await endMaintenance(admin.id, pinned.version);
    expect(ended.effectivelyActive).toBe(false);
    expect(ended.notices).toHaveLength(1);
    expect(ended.notices[0].cancelledAt).not.toBeNull();

    await fixture.cleanup();
  });

  it("leaves a notice that is not yet due standing", async () => {
    const fixture = await createIntegrationFixture("end-keeps-future-notice");
    const admin = fixture.users.admin;

    const activated = await activateMaintenance(admin.id, 1, {
      message: "Today's window.",
      expectedEndAt: null,
    });
    const scheduled = await scheduleMaintenanceNotice(admin.id, activated.version, {
      message: "Next week's window.",
      startsAt: new Date(Date.now() + 604_800_000),
      expectedEndAt: null,
    });

    const ended = await endMaintenance(admin.id, scheduled.version);
    expect(ended.active).toBe(false);
    expect(ended.effectivelyActive).toBe(false);
    // Ending today's maintenance is not a decision about next week.
    expect(ended.notices).toHaveLength(1);
    expect(ended.notices[0].cancelledAt).toBeNull();

    await fixture.cleanup();
  });

  it("records how many notices the ending cancelled", async () => {
    const fixture = await createIntegrationFixture("end-audits-cancelled-count");
    const admin = fixture.users.admin;

    await scheduleMaintenanceNotice(admin.id, 1, {
      message: "Due window one.",
      startsAt: new Date(Date.now() - 120_000),
      expectedEndAt: null,
    });
    const state = await readMaintenanceState();
    await endMaintenance(admin.id, state.version);

    const [ending] = await getDb()
      .select({ changes: auditLog.changes })
      .from(auditLog)
      .where(eq(auditLog.action, "maintenance_ended"));
    expect(ending.changes).toMatchObject({ active: false, cancelledNotices: 1 });

    await fixture.cleanup();
  });

  it("still answers a stale version with 409, cancelling nothing", async () => {
    const fixture = await createIntegrationFixture("end-stale-with-due-notice");
    const admin = fixture.users.admin;

    await scheduleMaintenanceNotice(admin.id, 1, {
      message: "Due, and about to be raced.",
      startsAt: new Date(Date.now() - 60_000),
      expectedEndAt: null,
    });

    await expect(endMaintenance(admin.id, 1)).rejects.toMatchObject({
      code: "maintenance_state_stale",
      status: 409,
    });
    const state = await readMaintenanceState();
    expect(state.effectivelyActive).toBe(true);
    expect(state.notices[0].cancelledAt).toBeNull();

    await fixture.cleanup();
  });
});
