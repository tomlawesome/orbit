import { beforeEach, describe, expect, it, vi } from "vitest";

/*
 * `/api/admin/upload-limit` (#1285): the document upload size limit. GET needs
 * a session; POST is a `write()` (session + real CSRF). The route passes the
 * caller's own id to the engine, which refuses non-administrators (403) -- that
 * refusal must reach the client. POST is `set` (whole megabytes within the
 * published bounds, converted to bytes) or `default` (back to the configured
 * default, a distinct action), each with a positive integer `expectedVersion`.
 * Out-of-bounds, fractional or missing values are 422. Answers are no-store;
 * fixtures answer the default without the engine.
 */
const mocks = vi.hoisted(() => ({
  getAuthConfig: vi.fn(),
  requireSession: vi.fn(),
  assertOutsideMaintenance: vi.fn(),
  readUploadLimitSettings: vi.fn(),
  setUploadLimit: vi.fn(),
  assertKeyUsable: vi.fn(),
}));

vi.mock("orbit/lib/env", () => ({ getAuthConfig: mocks.getAuthConfig }));
vi.mock("orbit/lib/auth/session", async (importOriginal) => ({ ...(await importOriginal()), requireSession: mocks.requireSession }));
vi.mock("orbit/server/maintenance", () => ({ assertOutsideMaintenance: mocks.assertOutsideMaintenance }));
vi.mock("orbit/server/upload-limit", async (importOriginal) => ({
  ...(await importOriginal()),
  readUploadLimitSettings: mocks.readUploadLimitSettings,
  setUploadLimit: mocks.setUploadLimit,
}));
vi.mock("orbit/server/key-state", () => ({ assertKeyUsable: mocks.assertKeyUsable, noteRefusedSignIn: vi.fn() }));

const { GET, POST } = await import("../../web/src/routes/api/admin/upload-limit/+server.js");
const { UPLOAD_LIMIT_MAX_MEGABYTES, UPLOAD_LIMIT_MIN_MEGABYTES } = await import("orbit/server/upload-limit");
const { csrfTokenForSession } = await import("orbit/lib/auth/session");
const { AuthError } = await import("orbit/lib/auth/errors");
const { AppError } = await import("orbit/lib/app-error");
const { MaintenanceActiveError } = await import("orbit/lib/errors");

const MIB = 1_048_576;
const config = { appUrl: new URL("https://orbit.example"), sessionSecret: "s".repeat(48) };
const session = { id: "s-1", token: "tok-1", user: { id: "admin-1" } };
const uploadLimit = { maxBytes: 20 * MIB, version: 2 };

const getEvent = () => ({ cookies: {}, request: new Request("https://orbit.example/api/admin/upload-limit") });
function postEvent(body, { csrf = csrfTokenForSession(session, config), origin = "https://orbit.example" } = {}) {
  const headers = { origin, "content-type": "application/json" };
  if (csrf) headers["x-csrf-token"] = csrf;
  return {
    cookies: {},
    request: new Request("https://orbit.example/api/admin/upload-limit", { method: "POST", headers, body: JSON.stringify(body) }),
  };
}

beforeEach(() => {
  vi.unstubAllEnvs();
  for (const m of Object.values(mocks)) m.mockReset();
  mocks.getAuthConfig.mockReturnValue(config);
  mocks.requireSession.mockResolvedValue(session);
  mocks.readUploadLimitSettings.mockResolvedValue(uploadLimit);
  mocks.setUploadLimit.mockResolvedValue(uploadLimit);
});

describe("GET /api/admin/upload-limit", () => {
  it("answers the limit in force, no-store, read for the caller's own id", async () => {
    const response = await GET(getEvent());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ uploadLimit });
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(mocks.readUploadLimitSettings).toHaveBeenCalledWith("admin-1");
  });

  it("passes a non-administrator's refusal through as 403", async () => {
    mocks.readUploadLimitSettings.mockRejectedValue(new AppError("administrator_required", "no", 403));
    const response = await GET(getEvent());
    expect(response.status).toBe(403);
    expect((await response.json()).error.code).toBe("administrator_required");
  });

  it("refuses a signed-out caller with 401", async () => {
    mocks.requireSession.mockRejectedValue(new AuthError("session_required", "x", 401));
    expect((await GET(getEvent())).status).toBe(401);
    expect(mocks.readUploadLimitSettings).not.toHaveBeenCalled();
  });

  it("answers the 50 MiB default under fixtures with the published bounds, without the engine", async () => {
    vi.stubEnv("ORBIT_FIXTURES", "1");
    const { uploadLimit: fixture } = await (await GET(getEvent())).json();
    expect(fixture).toMatchObject({
      maxBytes: 50 * MIB,
      overrideBytes: null,
      minBytes: UPLOAD_LIMIT_MIN_MEGABYTES * MIB,
      ceilingBytes: UPLOAD_LIMIT_MAX_MEGABYTES * MIB,
    });
    expect(mocks.readUploadLimitSettings).not.toHaveBeenCalled();
  });
});

describe("POST /api/admin/upload-limit", () => {
  it("sets a whole-megabyte limit, converted to bytes, with the version the caller read", async () => {
    const response = await POST(postEvent({ action: "set", expectedVersion: 2, megabytes: 20 }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ uploadLimit });
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(mocks.setUploadLimit).toHaveBeenCalledWith("admin-1", 2, 20 * MIB);
  });

  it("accepts both ends of the published bounds", async () => {
    expect((await POST(postEvent({ action: "set", expectedVersion: 1, megabytes: UPLOAD_LIMIT_MIN_MEGABYTES }))).status).toBe(200);
    expect((await POST(postEvent({ action: "set", expectedVersion: 1, megabytes: UPLOAD_LIMIT_MAX_MEGABYTES }))).status).toBe(200);
  });

  it("returns to the configured default with a null limit, a distinct action", async () => {
    await POST(postEvent({ action: "default", expectedVersion: 5 }));
    expect(mocks.setUploadLimit).toHaveBeenCalledWith("admin-1", 5, null);
  });

  it.each([
    ["one under the minimum", () => ({ action: "set", expectedVersion: 1, megabytes: UPLOAD_LIMIT_MIN_MEGABYTES - 1 })],
    ["one over the ceiling", () => ({ action: "set", expectedVersion: 1, megabytes: UPLOAD_LIMIT_MAX_MEGABYTES + 1 })],
    ["fractional megabytes", () => ({ action: "set", expectedVersion: 1, megabytes: 10.5 })],
    ["megabytes as a string", () => ({ action: "set", expectedVersion: 1, megabytes: "20" })],
    ["no megabytes", () => ({ action: "set", expectedVersion: 1 })],
    ["version zero", () => ({ action: "default", expectedVersion: 0 })],
    ["no version", () => ({ action: "default" })],
    ["an unknown action", () => ({ action: "unlimited", expectedVersion: 1 })],
  ])("rejects %s with 422 and writes nothing", async (_label, body) => {
    const response = await POST(postEvent(body()));
    expect(response.status).toBe(422);
    expect((await response.json()).error.code).toBe("validation_failed");
    expect(mocks.setUploadLimit).not.toHaveBeenCalled();
  });

  it("passes the engine's 403 and 409 through", async () => {
    mocks.setUploadLimit.mockRejectedValueOnce(new AppError("administrator_required", "no", 403));
    expect((await POST(postEvent({ action: "default", expectedVersion: 1 }))).status).toBe(403);
    mocks.setUploadLimit.mockRejectedValueOnce(new AppError("version_conflict", "stale", 409));
    expect((await POST(postEvent({ action: "default", expectedVersion: 1 }))).status).toBe(409);
  });

  it("refuses a signed-out caller, a missing CSRF token and a cross-origin post, writing nothing", async () => {
    mocks.requireSession.mockRejectedValueOnce(new AuthError("session_required", "x", 401));
    expect((await POST(postEvent({ action: "default", expectedVersion: 1 }))).status).toBe(401);
    expect((await POST(postEvent({ action: "default", expectedVersion: 1 }, { csrf: "" }))).status).toBe(403);
    expect((await POST(postEvent({ action: "default", expectedVersion: 1 }, { origin: "https://evil.example" }))).status).toBe(403);
    expect(mocks.setUploadLimit).not.toHaveBeenCalled();
  });

  it("answers 503 during maintenance", async () => {
    mocks.assertOutsideMaintenance.mockRejectedValue(new MaintenanceActiveError(null));
    expect((await POST(postEvent({ action: "default", expectedVersion: 1 }))).status).toBe(503);
    expect(mocks.setUploadLimit).not.toHaveBeenCalled();
  });
});
