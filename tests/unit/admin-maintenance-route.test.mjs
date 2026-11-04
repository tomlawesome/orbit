import { beforeEach, describe, expect, it, vi } from "vitest";

/*
 * `/api/admin/maintenance` (#524, #585, ADR-0013): the administrator's
 * maintenance control. Both verbs check the administrator FIRST (a
 * non-administrator gets 403 and nothing is read or written). POST is a
 * `write()` (session + real CSRF) over a closed union of eight actions, each
 * carrying a positive integer `expectedVersion`; dates are coerced, ids must be
 * uuids. Each action calls its own engine function with the actor and version.
 * no-store throughout.
 */
const mocks = vi.hoisted(() => ({
  getAuthConfig: vi.fn(),
  requireSession: vi.fn(),
  assertOutsideMaintenance: vi.fn(),
  requireInstanceAdministrator: vi.fn(),
  readMaintenanceState: vi.fn(),
  openMaintenanceWindow: vi.fn(),
  publishMaintenanceUpdate: vi.fn(),
  editMaintenanceUpdate: vi.fn(),
  reviseMaintenanceExpectedEnd: vi.fn(),
  endMaintenance: vi.fn(),
  scheduleMaintenanceWindow: vi.fn(),
  rescheduleMaintenanceWindow: vi.fn(),
  cancelMaintenanceWindow: vi.fn(),
  assertKeyUsable: vi.fn(),
}));

vi.mock("orbit/lib/env", () => ({ getAuthConfig: mocks.getAuthConfig }));
vi.mock("orbit/lib/auth/session", async (importOriginal) => ({ ...(await importOriginal()), requireSession: mocks.requireSession }));
vi.mock("orbit/server/authorization", () => ({ requireInstanceAdministrator: mocks.requireInstanceAdministrator }));
vi.mock("orbit/server/maintenance", () => ({
  assertOutsideMaintenance: mocks.assertOutsideMaintenance,
  readMaintenanceState: mocks.readMaintenanceState,
  openMaintenanceWindow: mocks.openMaintenanceWindow,
  publishMaintenanceUpdate: mocks.publishMaintenanceUpdate,
  editMaintenanceUpdate: mocks.editMaintenanceUpdate,
  reviseMaintenanceExpectedEnd: mocks.reviseMaintenanceExpectedEnd,
  endMaintenance: mocks.endMaintenance,
  scheduleMaintenanceWindow: mocks.scheduleMaintenanceWindow,
  rescheduleMaintenanceWindow: mocks.rescheduleMaintenanceWindow,
  cancelMaintenanceWindow: mocks.cancelMaintenanceWindow,
}));
vi.mock("orbit/server/key-state", () => ({ assertKeyUsable: mocks.assertKeyUsable, noteRefusedSignIn: vi.fn() }));

const { GET, POST } = await import("../../web/src/routes/api/admin/maintenance/+server.js");
const { csrfTokenForSession } = await import("orbit/lib/auth/session");
const { AuthError } = await import("orbit/lib/auth/errors");
const { AppError } = await import("orbit/lib/app-error");

const config = { appUrl: new URL("https://orbit.example"), sessionSecret: "s".repeat(48) };
const session = { id: "s-1", token: "tok-1", user: { id: "admin-1" } };
const UUID = "6f1c2b0e-3d5a-4b8e-9a47-0c1d2e3f4a5b";
const state = { version: 8 };
const writes = ["openMaintenanceWindow", "publishMaintenanceUpdate", "editMaintenanceUpdate", "reviseMaintenanceExpectedEnd", "endMaintenance", "scheduleMaintenanceWindow", "rescheduleMaintenanceWindow", "cancelMaintenanceWindow"];

const getEvent = () => ({ cookies: {}, request: new Request("https://orbit.example/api/admin/maintenance") });
function postEvent(body, { csrf = csrfTokenForSession(session, config), origin = "https://orbit.example" } = {}) {
  const headers = { origin, "content-type": "application/json" };
  if (csrf) headers["x-csrf-token"] = csrf;
  return {
    cookies: {},
    request: new Request("https://orbit.example/api/admin/maintenance", { method: "POST", headers, body: JSON.stringify(body) }),
  };
}
const noWrites = () => writes.forEach((name) => expect(mocks[name]).not.toHaveBeenCalled());

beforeEach(() => {
  for (const m of Object.values(mocks)) m.mockReset();
  mocks.getAuthConfig.mockReturnValue(config);
  mocks.requireSession.mockResolvedValue(session);
  mocks.requireInstanceAdministrator.mockResolvedValue(undefined);
  mocks.readMaintenanceState.mockResolvedValue(state);
  for (const name of writes) mocks[name].mockResolvedValue(state);
});

describe("GET /api/admin/maintenance", () => {
  it("answers the state to an administrator, no-store", async () => {
    const response = await GET(getEvent());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ maintenance: state });
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("refuses a non-administrator with 403 and reads nothing", async () => {
    mocks.requireInstanceAdministrator.mockRejectedValue(new AppError("administrator_required", "no", 403));
    const response = await GET(getEvent());
    expect(response.status).toBe(403);
    expect(mocks.readMaintenanceState).not.toHaveBeenCalled();
  });

  it("refuses a signed-out caller with 401", async () => {
    mocks.requireSession.mockRejectedValue(new AuthError("session_required", "x", 401));
    expect((await GET(getEvent())).status).toBe(401);
    expect(mocks.readMaintenanceState).not.toHaveBeenCalled();
  });
});

describe("POST /api/admin/maintenance", () => {
  const end = "2026-12-01T10:00:00.000Z";
  const cases = [
    ["activate", { message: "Upgrading", expectedEndAt: end }, "openMaintenanceWindow", [8, { body: "Upgrading", expectedEndAt: new Date(end) }]],
    ["activate", { message: "Upgrading", expectedEndAt: null }, "openMaintenanceWindow", [8, { body: "Upgrading", expectedEndAt: null }]],
    ["publish_update", { message: "Halfway" }, "publishMaintenanceUpdate", [8, "Halfway"]],
    ["edit_update", { updateId: UUID, message: "Fixed typo" }, "editMaintenanceUpdate", [8, UUID, "Fixed typo"]],
    ["revise_expected_end", { expectedEndAt: end }, "reviseMaintenanceExpectedEnd", [8, new Date(end)]],
    ["end", { message: "Done" }, "endMaintenance", [8, { body: "Done" }]],
    ["schedule_window", { message: "Soon", startsAt: end, expectedEndAt: null }, "scheduleMaintenanceWindow", [8, { body: "Soon", scheduledStartAt: new Date(end), expectedEndAt: null }]],
    ["reschedule_window", { windowId: UUID, startsAt: end, expectedEndAt: null }, "rescheduleMaintenanceWindow", [8, UUID, { scheduledStartAt: new Date(end), expectedEndAt: null }]],
    ["cancel_window", { windowId: UUID }, "cancelMaintenanceWindow", [8, UUID]],
  ];

  it.each(cases)("%s calls only its own engine function with the actor and version", async (action, extra, fn, args) => {
    const response = await POST(postEvent({ action, expectedVersion: 8, ...extra }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ maintenance: state });
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(mocks[fn]).toHaveBeenCalledWith("admin-1", ...args);
    for (const other of writes.filter((name) => name !== fn)) expect(mocks[other]).not.toHaveBeenCalled();
  });

  it("ends maintenance without a closing message", async () => {
    await POST(postEvent({ action: "end", expectedVersion: 8 }));
    expect(mocks.endMaintenance).toHaveBeenCalledWith("admin-1", 8, { body: undefined });
  });

  it.each([
    ["an unknown action", { action: "wipe", expectedVersion: 1 }],
    ["activate without expectedEndAt", { action: "activate", expectedVersion: 1, message: "x" }],
    ["a non-uuid window id", { action: "cancel_window", expectedVersion: 1, windowId: "1" }],
    ["a non-uuid update id", { action: "edit_update", expectedVersion: 1, updateId: "nope", message: "x" }],
    ["an unparseable date", { action: "schedule_window", expectedVersion: 1, message: "x", startsAt: "tomorrow-ish", expectedEndAt: null }],
    ["version zero", { action: "publish_update", expectedVersion: 0, message: "x" }],
    ["a missing version", { action: "publish_update", message: "x" }],
    ["a missing message", { action: "publish_update", expectedVersion: 1 }],
  ])("rejects %s with 422 and changes nothing", async (_label, body) => {
    const response = await POST(postEvent(body));
    expect(response.status).toBe(422);
    expect((await response.json()).error.code).toBe("validation_failed");
    noWrites();
  });

  it("passes the engine's 403 for a non-administrator through and writes nothing", async () => {
    mocks.requireInstanceAdministrator.mockRejectedValue(new AppError("administrator_required", "no", 403));
    const response = await POST(postEvent({ action: "end", expectedVersion: 1 }));
    expect(response.status).toBe(403);
    noWrites();
  });

  it("passes the engine's 409 for a stale version through", async () => {
    mocks.endMaintenance.mockRejectedValue(new AppError("version_conflict", "stale", 409));
    expect((await POST(postEvent({ action: "end", expectedVersion: 1 }))).status).toBe(409);
  });

  it("refuses a signed-out caller, a missing CSRF token and a cross-origin post, writing nothing", async () => {
    mocks.requireSession.mockRejectedValueOnce(new AuthError("session_required", "x", 401));
    expect((await POST(postEvent({ action: "end", expectedVersion: 1 }))).status).toBe(401);
    expect((await POST(postEvent({ action: "end", expectedVersion: 1 }, { csrf: "" }))).status).toBe(403);
    expect((await POST(postEvent({ action: "end", expectedVersion: 1 }, { origin: "https://evil.example" }))).status).toBe(403);
    noWrites();
  });
});
