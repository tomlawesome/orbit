import { inArray } from "drizzle-orm";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { getDb } from "@/db";
import { auditLog, instanceMaintenance, maintenanceUpdates, maintenanceWindows } from "@/db/schema";
import { openMaintenanceWindow, readMaintenanceState } from "@/server/maintenance";
import { setReadinessDependenciesForTests } from "@/server/readiness";
import { readReminderSettings } from "@/server/reminder-settings";
import {
  cleanupIntegrationEnvironment,
  createIntegrationFixture,
  type IntegrationFixture,
  type IntegrationSession,
} from "./support/fixtures";
import { callRoute, callRouteForSession, loadRoute } from "./support/request-event";

const { GET: readReminders, PUT: writeReminders } = await loadRoute("settings/reminders");
const { GET: sessionStatus } = await loadRoute("auth/session");
const { POST: logout } = await loadRoute("auth/logout");
const { GET: health } = await loadRoute("health");

afterAll(async () => {
  await cleanupIntegrationEnvironment();
});

/* Same singleton-reset rationale as maintenance.test.ts: the 0028 migration
   seeds instance_maintenance once, so every test restores the seeded shape
   and clears windows and this feature's audit rows. */
afterEach(async () => {
  setReadinessDependenciesForTests(undefined);
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

const REMINDERS_URL = "http://127.0.0.1:3000/api/settings/reminders";
const REMINDER_WRITE = { emailEnabled: false, firstWarningDays: 10, finalWarningDays: 2 };

async function activate(fixture: IntegrationFixture, expectedEndAt: Date | null): Promise<void> {
  const state = await readMaintenanceState();
  await openMaintenanceWindow(fixture.users.admin.id, state.version, {
    body: "Planned upgrade underway.",
    expectedEndAt,
  });
}

function reminderWrite(session: IntegrationSession, url = REMINDERS_URL): Promise<Response> {
  return callRouteForSession(writeReminders, session, {
    url,
    method: "PUT",
    body: JSON.stringify(REMINDER_WRITE),
    headers: { "content-type": "application/json" },
  });
}

/** The bounded blocked-API contract of ADR-0013 decision 2, asserted whole. */
async function expectMaintenanceBlocked(response: Response): Promise<void> {
  expect(response.status).toBe(503);
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  await expect(response.json()).resolves.toEqual({ error: "maintenance_active" });
}

describe("the maintenance guard and 503 semantics (#523)", () => {
  it("blocks a non-administrator write during maintenance and the write never lands", async () => {
    const fixture = await createIntegrationFixture("guard-blocked-write");
    const member = await fixture.session("member");

    // Prove the request is well-formed before maintenance: the same write passes.
    const before = await reminderWrite(member);
    expect(before.status).toBe(200);

    await activate(fixture, null);

    const blocked = await callRouteForSession(writeReminders, member, {
      url: REMINDERS_URL,
      method: "PUT",
      body: JSON.stringify({ emailEnabled: true, firstWarningDays: 30, finalWarningDays: 7 }),
      headers: { "content-type": "application/json" },
    });
    await expectMaintenanceBlocked(blocked);

    // The blocked write left no trace: the pre-maintenance settings survive.
    const settings = await readReminderSettings(member.userId);
    expect(settings.emailEnabled).toBe(false);
    expect(settings.firstWarningDays).toBe(10);

    // Reads are blocked for the member too, not just writes.
    await expectMaintenanceBlocked(await callRouteForSession(readReminders, member, { url: REMINDERS_URL }));

    await fixture.cleanup();
  });

  it("blocks a signed-out request with the same generic 503, not a 401", async () => {
    const fixture = await createIntegrationFixture("guard-signed-out");
    await activate(fixture, null);

    const response = await callRoute(writeReminders, {
      url: REMINDERS_URL,
      method: "PUT",
      body: JSON.stringify(REMINDER_WRITE),
      headers: { "content-type": "application/json" },
    });
    await expectMaintenanceBlocked(response);

    await fixture.cleanup();
  });

  it("passes an active instance administrator on an ordinary guarded route", async () => {
    const fixture = await createIntegrationFixture("guard-admin-passes");
    const admin = await fixture.session("admin");
    await activate(fixture, null);

    const response = await reminderWrite(admin);
    expect(response.status).toBe(200);

    await fixture.cleanup();
  });

  it("derives Retry-After from expected_end_at when it is in the future", async () => {
    const fixture = await createIntegrationFixture("guard-retry-after");
    const member = await fixture.session("member");
    await activate(fixture, new Date(Date.now() + 600_000));

    const response = await reminderWrite(member);
    await expectMaintenanceBlocked(response);
    const retryAfter = Number(response.headers.get("Retry-After"));
    expect(retryAfter).toBeGreaterThan(540);
    expect(retryAfter).toBeLessThanOrEqual(600);

    await fixture.cleanup();
  });

  it("omits Retry-After when no end is expected", async () => {
    const fixture = await createIntegrationFixture("guard-no-retry-after");
    const member = await fixture.session("member");
    await activate(fixture, null);

    const response = await reminderWrite(member);
    await expectMaintenanceBlocked(response);
    expect(response.headers.get("Retry-After")).toBeNull();

    await fixture.cleanup();
  });

  it("cannot be talked out of blocking by prefix, traversal or encoding tricks in the URL", async () => {
    const fixture = await createIntegrationFixture("guard-url-tricks");
    const member = await fixture.session("member");
    await activate(fixture, null);

    // The guard binds to the route module, not the URL, so however the
    // request addresses the handler, the decision is identical.
    const disguises = [
      "http://127.0.0.1:3000/api/health/../settings/reminders",
      "http://127.0.0.1:3000/api/health%2F..%2Fsettings/reminders",
      "http://127.0.0.1:3000/api/auth/login/../../settings/reminders",
    ];
    for (const url of disguises) {
      await expectMaintenanceBlocked(await reminderWrite(member, url));
    }

    await fixture.cleanup();
  });

  it("keeps the exempt session read and sign-out working during maintenance", async () => {
    const fixture = await createIntegrationFixture("guard-exempt-routes");
    const member = await fixture.session("member");
    await activate(fixture, null);

    const who = await callRouteForSession(sessionStatus, member, { url: "http://127.0.0.1:3000/api/auth/session" });
    expect(who.status).toBe(200);

    const out = await callRouteForSession(logout, member, { url: "http://127.0.0.1:3000/api/auth/logout", method: "POST" });
    expect(out.status).toBeLessThan(400);

    await fixture.cleanup();
  });

  it("health reports maintenance with 200 and leaks no configuration", async () => {
    const fixture = await createIntegrationFixture("guard-health-maintenance");
    await activate(fixture, new Date(Date.now() + 600_000));

    const response = await callRoute(health, { url: "http://127.0.0.1:3000/api/health" });
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const body = await response.json();
    expect(body.status).toBe("maintenance");
    expect(body.service).toBe("orbit");
    // Content-free by contract: nothing but the category, the service name
    // and the timestamp — never the message, schedule or version.
    expect(Object.keys(body).sort()).toEqual(["service", "status", "timestamp"]);

    await fixture.cleanup();
  });

  it("health never hides a real dependency failure behind maintenance", async () => {
    const fixture = await createIntegrationFixture("guard-health-degraded");
    await activate(fixture, null);
    setReadinessDependenciesForTests({
      checkDatabase: () => Promise.reject(new Error("database unreachable")),
    });

    const response = await callRoute(health, { url: "http://127.0.0.1:3000/api/health" });
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({ status: "degraded" });

    await fixture.cleanup();
  });
});
