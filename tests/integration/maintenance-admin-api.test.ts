import { inArray } from "drizzle-orm";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { getDb } from "@/db";
import { auditLog, instanceMaintenance, maintenanceUpdates, maintenanceWindows } from "@/db/schema";
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

const URL = "http://127.0.0.1:3000/api/admin/maintenance";

function post(session: IntegrationSession, body: unknown, overrides: Record<string, string> = {}) {
  return requestForSession(session, URL, {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json", ...overrides },
  });
}

describe("the maintenance administration API (#524, #585)", () => {
  it("reads state, then carries it through activate, publish, correct, schedule, cancel and end", async () => {
    const fixture = await createIntegrationFixture("admin-api-lifecycle");
    const admin = await fixture.session("admin");

    const read = await readMaintenance(requestForSession(admin, URL));
    expect(read.status).toBe(200);
    const initial = await read.json();
    expect(initial.maintenance).toMatchObject({ active: false, effectivelyActive: false, version: 1 });
    expect(initial.maintenance.openWindow).toBeNull();
    expect(initial.maintenance.scheduledWindows).toEqual([]);

    const activated = await mutateMaintenance(post(admin, {
      action: "activate",
      expectedVersion: initial.maintenance.version,
      message: "Upgrading the database.",
      expectedEndAt: new Date(Date.now() + 3_600_000).toISOString(),
    }));
    expect(activated.status).toBe(200);
    const activeState = (await activated.json()).maintenance;
    expect(activeState).toMatchObject({ active: true, effectivelyActive: true, version: 2 });
    expect(activeState.currentWindowId).toBe(activeState.openWindow.id);
    expect(activeState.openWindow.updates.map((entry: { kind: string; body: string }) => [entry.kind, entry.body]))
      .toEqual([["started", "Upgrading the database."]]);

    // The whole point of #585: the second message joins the first rather than
    // replacing it.
    const published = await mutateMaintenance(post(admin, {
      action: "publish_update",
      expectedVersion: activeState.version,
      message: "Twenty minutes behind; the index rebuild is slower than planned.",
    }));
    expect(published.status).toBe(200);
    const publishedState = (await published.json()).maintenance;
    expect(publishedState.openWindow.updates.map((entry: { kind: string; body: string }) => [entry.kind, entry.body]))
      .toEqual([
        ["started", "Upgrading the database."],
        ["update", "Twenty minutes behind; the index rebuild is slower than planned."],
      ]);

    const corrected = await mutateMaintenance(post(admin, {
      action: "edit_update",
      expectedVersion: publishedState.version,
      updateId: publishedState.openWindow.updates[1].id,
      message: "Thirty minutes behind; the index rebuild is slower than planned.",
    }));
    expect(corrected.status).toBe(200);
    const correctedState = (await corrected.json()).maintenance;
    expect(correctedState.openWindow.updates[1].body).toBe("Thirty minutes behind; the index rebuild is slower than planned.");
    expect(correctedState.openWindow.updates[1].editedAt).not.toBeNull();
    expect(correctedState.openWindow.updates).toHaveLength(2);

    const scheduled = await mutateMaintenance(post(admin, {
      action: "schedule_window",
      expectedVersion: correctedState.version,
      message: "A second window next week.",
      startsAt: new Date(Date.now() + 604_800_000).toISOString(),
      expectedEndAt: null,
    }));
    expect(scheduled.status).toBe(200);
    const scheduledState = (await scheduled.json()).maintenance;
    expect(scheduledState.scheduledWindows).toHaveLength(1);
    expect(scheduledState.scheduledWindows[0].updates[0].kind).toBe("scheduled");

    const cancelled = await mutateMaintenance(post(admin, {
      action: "cancel_window",
      expectedVersion: scheduledState.version,
      windowId: scheduledState.scheduledWindows[0].id,
    }));
    expect(cancelled.status).toBe(200);
    const cancelledState = (await cancelled.json()).maintenance;
    // Cancellation retains the row (ADR-0013 decision 8), it does not delete
    // it — it simply stops being scheduled.
    expect(cancelledState.scheduledWindows).toEqual([]);
    const retained = await getDb().select().from(maintenanceWindows);
    expect(retained.filter((window) => window.status === "cancelled")).toHaveLength(1);

    const ended = await mutateMaintenance(post(admin, {
      action: "end",
      expectedVersion: cancelledState.version,
    }));
    expect(ended.status).toBe(200);
    const endedState = (await ended.json()).maintenance;
    expect(endedState).toMatchObject({ active: false, effectivelyActive: false, openWindow: null });
    expect(endedState.currentWindowId).toBeNull();

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
      action: "publish_update",
      expectedVersion: 1,
      message: "Second writer is stale.",
    }));
    expect(replay.status).toBe(409);
    await expect(replay.json()).resolves.toMatchObject({ error: { code: "maintenance_state_stale" } });

    const state = await readMaintenanceState();
    expect(state.openWindow?.updates.map((entry) => entry.body)).toEqual(["First writer wins."]);

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
      message: `${"x".repeat(600)}`,
      expectedEndAt: null,
    }));
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(response.status).toBeLessThan(500);
    const state = await readMaintenanceState();
    expect(state.active).toBe(false);
    expect(state.openWindow).toBeNull();
    expect(await getDb().select().from(maintenanceUpdates)).toEqual([]);

    await fixture.cleanup();
  });

  it("revises the expected end without disturbing the timeline", async () => {
    const fixture = await createIntegrationFixture("admin-api-expected-end");
    const admin = await fixture.session("admin");

    const activated = await mutateMaintenance(post(admin, {
      action: "activate",
      expectedVersion: 1,
      message: "Back within the hour.",
      expectedEndAt: new Date(Date.now() + 3_600_000).toISOString(),
    }));
    const activeState = (await activated.json()).maintenance;

    const revisedEnd = new Date(Date.now() + 7_200_000);
    const revised = await mutateMaintenance(post(admin, {
      action: "revise_expected_end",
      expectedVersion: activeState.version,
      expectedEndAt: revisedEnd.toISOString(),
    }));
    expect(revised.status).toBe(200);
    const revisedState = (await revised.json()).maintenance;
    expect(revisedState.expectedEndAt).toBe(revisedEnd.toISOString());
    expect(revisedState.openWindow.expectedEndAt).toBe(revisedEnd.toISOString());
    expect(revisedState.openWindow.updates).toHaveLength(1);

    await fixture.cleanup();
  });
});
