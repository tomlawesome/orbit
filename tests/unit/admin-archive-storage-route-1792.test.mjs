import { beforeEach, describe, expect, it, vi } from "vitest";

/*
 * `/api/admin/archive-storage` (#1792, spec-security-fixes.md 2.4, L15): the
 * three export settings, the shape of `/api/admin/upload-limit` and
 * `/api/admin/mail-limit`. GET needs a session; POST is a `write()`. Body is
 * `{ action: "set", expectedVersion, retentionHours, keepPerHousehold,
 * maxTotalGigabytes }` (whole numbers: 1 to 720 h, 1 to 10, 1 to 102 400 GB)
 * or `{ action: "default", expectedVersion }`. The answer carries
 * `archiveStorage`. The engine's refusals (403, 409, 422) reach the client.
 * Under fixtures the route answers the defaults, never changed, version 1,
 * without the engine. Shape of admin-mail-limit-route-1388.test.mjs.
 */
const mocks = vi.hoisted(() => ({
  getAuthConfig: vi.fn(),
  requireSession: vi.fn(),
  assertOutsideMaintenance: vi.fn(),
  readArchiveRetentionSettings: vi.fn(),
  setArchiveRetention: vi.fn(),
  assertKeyUsable: vi.fn(),
}));

vi.mock("orbit/lib/env", () => ({ getAuthConfig: mocks.getAuthConfig }));
vi.mock("orbit/lib/auth/session", async (importOriginal) => ({ ...(await importOriginal()), requireSession: mocks.requireSession }));
vi.mock("orbit/server/maintenance", () => ({ assertOutsideMaintenance: mocks.assertOutsideMaintenance }));
vi.mock("orbit/server/archive-retention", async (importOriginal) => ({
  ...(await importOriginal()),
  readArchiveRetentionSettings: mocks.readArchiveRetentionSettings,
  setArchiveRetention: mocks.setArchiveRetention,
}));
vi.mock("orbit/server/key-state", () => ({ assertKeyUsable: mocks.assertKeyUsable, noteRefusedSignIn: vi.fn() }));

const { GET, POST } = await import("../../web/src/routes/api/admin/archive-storage/+server.js");
const { csrfTokenForSession } = await import("orbit/lib/auth/session");
const { AuthError } = await import("orbit/lib/auth/errors");
const { AppError } = await import("orbit/lib/app-error");
const { MaintenanceActiveError } = await import("orbit/lib/errors");

const GIB = 1_073_741_824;
const config = { appUrl: new URL("https://orbit.example"), sessionSecret: "s".repeat(48) };
const session = { id: "s-1", token: "tok-1", user: { id: "admin-1" } };
const archiveStorage = { retentionHours: 6, keepPerHousehold: 2, maxTotalBytes: 10 * GIB, version: 2 };
const PATH = "https://orbit.example/api/admin/archive-storage";

const getEvent = () => ({ cookies: {}, request: new Request(PATH) });
function postEvent(body, { csrf = csrfTokenForSession(session, config), origin = "https://orbit.example" } = {}) {
  const headers = { origin, "content-type": "application/json" };
  if (csrf) headers["x-csrf-token"] = csrf;
  return { cookies: {}, request: new Request(PATH, { method: "POST", headers, body: JSON.stringify(body) }) };
}
const set = (over = {}) => ({ action: "set", expectedVersion: 2, retentionHours: 6, keepPerHousehold: 2, maxTotalGigabytes: 10, ...over });

beforeEach(() => {
  vi.unstubAllEnvs();
  for (const m of Object.values(mocks)) m.mockReset();
  mocks.getAuthConfig.mockReturnValue(config);
  mocks.requireSession.mockResolvedValue(session);
  mocks.readArchiveRetentionSettings.mockResolvedValue(archiveStorage);
  mocks.setArchiveRetention.mockResolvedValue(archiveStorage);
});

describe("GET /api/admin/archive-storage", () => {
  it("answers the settings in force as archiveStorage, no-store, read for the caller's own id", async () => {
    const response = await GET(getEvent());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ archiveStorage });
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(mocks.readArchiveRetentionSettings).toHaveBeenCalledWith("admin-1");
  });

  it("passes a non-administrator's refusal through as 403", async () => {
    mocks.readArchiveRetentionSettings.mockRejectedValue(new AppError("administrator_required", "no", 403));
    const response = await GET(getEvent());
    expect(response.status).toBe(403);
    expect((await response.json()).error.code).toBe("administrator_required");
  });

  it("refuses a signed-out caller with 401", async () => {
    mocks.requireSession.mockRejectedValue(new AuthError("session_required", "x", 401));
    expect((await GET(getEvent())).status).toBe(401);
    expect(mocks.readArchiveRetentionSettings).not.toHaveBeenCalled();
  });

  it("answers the defaults, never changed, version 1, under fixtures, without the engine", async () => {
    // Catches a fixture screen that half-reads the engine (the rule every route follows: one or the other).
    vi.stubEnv("ORBIT_FIXTURES", "1");
    const response = await GET(getEvent());
    expect(response.status).toBe(200);
    const { archiveStorage: fixture } = await response.json();
    expect(fixture).toMatchObject({
      retentionHours: 6,
      keepPerHousehold: 2,
      defaults: { retentionHours: 6, keepPerHousehold: 2 },
      overrides: { retentionHours: null, keepPerHousehold: null, maxTotalBytes: null },
      bounds: { retentionHours: [1, 720], keepPerHousehold: [1, 10], maxTotalGigabytes: [1, 102_400] },
      version: 1,
      updatedAt: null,
    });
    expect(fixture.maxTotalBytes).toBeGreaterThan(0);
    expect(fixture.defaults.maxTotalBytes).toBe(fixture.maxTotalBytes);
    expect(mocks.readArchiveRetentionSettings).not.toHaveBeenCalled();
  });
});

describe("POST /api/admin/archive-storage", () => {
  it("sets the three values with the version the caller read", async () => {
    const response = await POST(postEvent(set({ retentionHours: 2, keepPerHousehold: 3, maxTotalGigabytes: 7 })));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ archiveStorage });
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(mocks.setArchiveRetention).toHaveBeenCalledWith("admin-1", 2, { retentionHours: 2, keepPerHousehold: 3, maxTotalGigabytes: 7 });
  });

  it("accepts the ends of each range", async () => {
    expect((await POST(postEvent(set({ retentionHours: 1, keepPerHousehold: 1, maxTotalGigabytes: 1 })))).status).toBe(200);
    expect((await POST(postEvent(set({ retentionHours: 720, keepPerHousehold: 10, maxTotalGigabytes: 102_400 })))).status).toBe(200);
  });

  it("goes back to the defaults with null", async () => {
    await POST(postEvent({ action: "default", expectedVersion: 5 }));
    expect(mocks.setArchiveRetention).toHaveBeenCalledWith("admin-1", 5, null);
  });

  it.each([
    ["0 hours", set({ retentionHours: 0 })],
    ["721 hours", set({ retentionHours: 721 })],
    ["0 per system", set({ keepPerHousehold: 0 })],
    ["11 per system", set({ keepPerHousehold: 11 })],
    ["0 GB", set({ maxTotalGigabytes: 0 })],
    ["102 401 GB", set({ maxTotalGigabytes: 102_401 })],
    ["fractional hours", set({ retentionHours: 2.5 })],
    ["hours as a string", set({ retentionHours: "6" })],
    ["no space value", (({ maxTotalGigabytes: _, ...rest }) => rest)(set())],
    ["version zero", { action: "default", expectedVersion: 0 }],
    ["no version", { action: "default" }],
    ["an unknown action", { action: "forever", expectedVersion: 1 }],
  ])("rejects %s with 422 and writes nothing", async (_label, body) => {
    const response = await POST(postEvent(body));
    expect(response.status).toBe(422);
    expect(mocks.setArchiveRetention).not.toHaveBeenCalled();
  });

  it("passes the engine's 403, 409 and 422 through with their codes", async () => {
    mocks.setArchiveRetention.mockRejectedValueOnce(new AppError("administrator_required", "no", 403));
    expect((await POST(postEvent({ action: "default", expectedVersion: 1 }))).status).toBe(403);
    mocks.setArchiveRetention.mockRejectedValueOnce(new AppError("archive_retention_version_conflict", "stale", 409));
    const conflict = await POST(postEvent({ action: "default", expectedVersion: 1 }));
    expect(conflict.status).toBe(409);
    expect((await conflict.json()).error.code).toBe("archive_retention_version_conflict");
    mocks.setArchiveRetention.mockRejectedValueOnce(new AppError("archive_retention_out_of_range", "range", 422));
    const range = await POST(postEvent(set()));
    expect(range.status).toBe(422);
    expect((await range.json()).error.code).toBe("archive_retention_out_of_range");
  });

  it("refuses a signed-out caller, a missing CSRF token and a cross-origin post, writing nothing", async () => {
    mocks.requireSession.mockRejectedValueOnce(new AuthError("session_required", "x", 401));
    expect((await POST(postEvent({ action: "default", expectedVersion: 1 }))).status).toBe(401);
    expect((await POST(postEvent({ action: "default", expectedVersion: 1 }, { csrf: "" }))).status).toBe(403);
    expect((await POST(postEvent({ action: "default", expectedVersion: 1 }, { origin: "https://evil.example" }))).status).toBe(403);
    expect(mocks.setArchiveRetention).not.toHaveBeenCalled();
  });

  it("answers 503 during maintenance", async () => {
    mocks.assertOutsideMaintenance.mockRejectedValue(new MaintenanceActiveError(null));
    expect((await POST(postEvent({ action: "default", expectedVersion: 1 }))).status).toBe(503);
    expect(mocks.setArchiveRetention).not.toHaveBeenCalled();
  });
});
