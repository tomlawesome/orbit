import { inArray } from "drizzle-orm";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { getDb } from "@/db";
import { auditLog, instanceMaintenance, maintenanceNotices } from "@/db/schema";
import { GET as readMaintenance, POST as mutateMaintenance } from "@/app/api/admin/maintenance/route";
import { readMaintenanceState } from "@/server/maintenance";
import {
  cleanupIntegrationEnvironment,
  createIntegrationFixture,
  requestForSession,
  requestWithoutSession,
  type IntegrationSession,
} from "./support/fixtures";

afterAll(async () => {
  await cleanupIntegrationEnvironment();
});

/* Same singleton-reset rationale as maintenance.test.ts. */
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

const URL = "http://127.0.0.1:3000/api/admin/maintenance";

function post(session: IntegrationSession, body: unknown, overrides: Record<string, string> = {}) {
  return requestForSession(session, URL, {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json", ...overrides },
  });
}

describe("the maintenance administration API (#524)", () => {
  it("reads state, then carries it through activate, edit, schedule, cancel and end", async () => {
    const fixture = await createIntegrationFixture("admin-api-lifecycle");
    const admin = await fixture.session("admin");

    const read = await readMaintenance(requestForSession(admin, URL));
    expect(read.status).toBe(200);
    const initial = await read.json();
    expect(initial.maintenance).toMatchObject({ active: false, effectivelyActive: false, version: 1 });
    expect(initial.maintenance.notices).toEqual([]);

    const activated = await mutateMaintenance(post(admin, {
      action: "activate",
      expectedVersion: initial.maintenance.version,
      message: "Upgrading the database.",
      expectedEndAt: new Date(Date.now() + 3_600_000).toISOString(),
    }));
    expect(activated.status).toBe(200);
    const activeState = (await activated.json()).maintenance;
    expect(activeState).toMatchObject({ active: true, effectivelyActive: true, version: 2 });
    expect(activeState.message).toBe("Upgrading the database.");

    const edited = await mutateMaintenance(post(admin, {
      action: "edit_message",
      expectedVersion: activeState.version,
      message: "Still upgrading.",
    }));
    expect(edited.status).toBe(200);
    const editedState = (await edited.json()).maintenance;
    expect(editedState.message).toBe("Still upgrading.");

    const scheduled = await mutateMaintenance(post(admin, {
      action: "schedule_notice",
      expectedVersion: editedState.version,
      message: "A second window next week.",
      startsAt: new Date(Date.now() + 604_800_000).toISOString(),
      expectedEndAt: null,
    }));
    expect(scheduled.status).toBe(200);
    const scheduledState = (await scheduled.json()).maintenance;
    expect(scheduledState.notices).toHaveLength(1);

    const cancelled = await mutateMaintenance(post(admin, {
      action: "cancel_notice",
      expectedVersion: scheduledState.version,
      noticeId: scheduledState.notices[0].id,
    }));
    expect(cancelled.status).toBe(200);
    const cancelledState = (await cancelled.json()).maintenance;
    // Cancellation retains the row (ADR-0013 decision 1), it does not delete it.
    expect(cancelledState.notices).toHaveLength(1);
    expect(cancelledState.notices[0].cancelledAt).not.toBeNull();

    const ended = await mutateMaintenance(post(admin, {
      action: "end",
      expectedVersion: cancelledState.version,
    }));
    expect(ended.status).toBe(200);
    expect((await ended.json()).maintenance).toMatchObject({ active: false, effectivelyActive: false });

    await fixture.cleanup();
  });

  it("answers 409 for a stale version and changes nothing", async () => {
    const fixture = await createIntegrationFixture("admin-api-stale");
    const admin = await fixture.session("admin");

    const first = await mutateMaintenance(post(admin, {
      action: "activate",
      expectedVersion: 1,
      message: "First writer wins.",
      expectedEndAt: null,
    }));
    expect(first.status).toBe(200);

    const replay = await mutateMaintenance(post(admin, {
      action: "edit_message",
      expectedVersion: 1,
      message: "Second writer is stale.",
    }));
    expect(replay.status).toBe(409);
    await expect(replay.json()).resolves.toMatchObject({ error: { code: "maintenance_state_stale" } });

    const state = await readMaintenanceState();
    expect(state.message).toBe("First writer wins.");

    await fixture.cleanup();
  });

  it("refuses a non-administrator outside maintenance without performing the mutation", async () => {
    const fixture = await createIntegrationFixture("admin-api-non-admin");
    const member = await fixture.session("member");

    const read = await readMaintenance(requestForSession(member, URL));
    expect(read.status).toBe(403);

    const attempt = await mutateMaintenance(post(member, {
      action: "activate",
      expectedVersion: 1,
      message: "Not this reader's to publish.",
      expectedEndAt: null,
    }));
    expect(attempt.status).toBe(403);
    expect((await readMaintenanceState()).active).toBe(false);

    await fixture.cleanup();
  });

  it("is neither discoverable nor invocable by a non-administrator during maintenance", async () => {
    const fixture = await createIntegrationFixture("admin-api-hidden");
    const admin = await fixture.session("admin");
    const member = await fixture.session("member");

    await mutateMaintenance(post(admin, {
      action: "activate",
      expectedVersion: 1,
      message: "Closed for now.",
      expectedEndAt: null,
    }));

    // The generic guard answer, identical to any other path: the control is
    // not announced by a different status or a different body (ADR-0013
    // decision 3 — no path exemption, so nothing to probe for).
    for (const response of [
      await readMaintenance(requestForSession(member, URL)),
      await mutateMaintenance(post(member, { action: "end", expectedVersion: 2 })),
    ]) {
      expect(response.status).toBe(503);
      await expect(response.json()).resolves.toEqual({ error: "maintenance_active" });
    }
    expect((await readMaintenanceState()).active).toBe(true);

    await fixture.cleanup();
  });

  it("still requires a session and a CSRF token", async () => {
    const fixture = await createIntegrationFixture("admin-api-csrf");
    const admin = await fixture.session("admin");

    const signedOut = await mutateMaintenance(requestWithoutSession(URL, {
      method: "POST",
      body: JSON.stringify({ action: "activate", expectedVersion: 1, message: "Anonymous.", expectedEndAt: null }),
      headers: { "content-type": "application/json" },
    }));
    expect(signedOut.status).toBe(401);

    const withoutCsrf = await mutateMaintenance(post(admin, {
      action: "activate",
      expectedVersion: 1,
      message: "No token.",
      expectedEndAt: null,
    }, { "x-csrf-token": "" }));
    expect(withoutCsrf.status).toBe(403);
    await expect(withoutCsrf.json()).resolves.toMatchObject({ error: { code: "csrf_failed" } });
    expect((await readMaintenanceState()).active).toBe(false);

    await fixture.cleanup();
  });

  it("bounds a hostile message at the API edge without writing it", async () => {
    const fixture = await createIntegrationFixture("admin-api-bounds");
    const admin = await fixture.session("admin");

    const response = await mutateMaintenance(post(admin, {
      action: "activate",
      expectedVersion: 1,
      message: `${"x".repeat(600)}`,
      expectedEndAt: null,
    }));
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(response.status).toBeLessThan(500);
    const state = await readMaintenanceState();
    expect(state.active).toBe(false);
    expect(state.message).toBeNull();

    await fixture.cleanup();
  });
});
