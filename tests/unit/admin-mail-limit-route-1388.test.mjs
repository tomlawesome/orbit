import { beforeEach, describe, expect, it, vi } from "vitest";

/*
 * `/api/admin/mail-limit` (#1388, design note 54592): the mail size limit, a
 * copy of `/api/admin/upload-limit`. GET needs a session; POST is a `write()`.
 * Body is `{ action: "set", expectedVersion, megabytes }` (whole MB, 1 to 50)
 * or `{ action: "default", expectedVersion }`. The answer carries `mailLimit`.
 * The engine's refusals (403, 409, 422) reach the client.
 */
const mocks = vi.hoisted(() => ({
  getAuthConfig: vi.fn(),
  requireSession: vi.fn(),
  assertOutsideMaintenance: vi.fn(),
  readMailLimitSettings: vi.fn(),
  setMailLimit: vi.fn(),
  assertKeyUsable: vi.fn(),
}));

vi.mock("orbit/lib/env", () => ({ getAuthConfig: mocks.getAuthConfig }));
vi.mock("orbit/lib/auth/session", async (importOriginal) => ({ ...(await importOriginal()), requireSession: mocks.requireSession }));
vi.mock("orbit/server/maintenance", () => ({ assertOutsideMaintenance: mocks.assertOutsideMaintenance }));
vi.mock("orbit/server/mail-limit", async (importOriginal) => ({
  ...(await importOriginal()),
  readMailLimitSettings: mocks.readMailLimitSettings,
  setMailLimit: mocks.setMailLimit,
}));
vi.mock("orbit/server/key-state", () => ({ assertKeyUsable: mocks.assertKeyUsable, noteRefusedSignIn: vi.fn() }));

const { GET, POST } = await import("../../web/src/routes/api/admin/mail-limit/+server.js");
const { csrfTokenForSession } = await import("orbit/lib/auth/session");
const { AuthError } = await import("orbit/lib/auth/errors");
const { AppError } = await import("orbit/lib/app-error");
const { MaintenanceActiveError } = await import("orbit/lib/errors");

const MIB = 1_048_576;
const config = { appUrl: new URL("https://orbit.example"), sessionSecret: "s".repeat(48) };
const session = { id: "s-1", token: "tok-1", user: { id: "admin-1" } };
const mailLimit = { maxBytes: 25 * MIB, version: 2 };

const getEvent = () => ({ cookies: {}, request: new Request("https://orbit.example/api/admin/mail-limit") });
function postEvent(body, { csrf = csrfTokenForSession(session, config), origin = "https://orbit.example" } = {}) {
  const headers = { origin, "content-type": "application/json" };
  if (csrf) headers["x-csrf-token"] = csrf;
  return {
    cookies: {},
    request: new Request("https://orbit.example/api/admin/mail-limit", { method: "POST", headers, body: JSON.stringify(body) }),
  };
}

beforeEach(() => {
  vi.unstubAllEnvs();
  for (const m of Object.values(mocks)) m.mockReset();
  mocks.getAuthConfig.mockReturnValue(config);
  mocks.requireSession.mockResolvedValue(session);
  mocks.readMailLimitSettings.mockResolvedValue(mailLimit);
  mocks.setMailLimit.mockResolvedValue(mailLimit);
});

describe("GET /api/admin/mail-limit", () => {
  it("answers the limit in force as mailLimit, no-store, read for the caller's own id", async () => {
    const response = await GET(getEvent());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ mailLimit });
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(mocks.readMailLimitSettings).toHaveBeenCalledWith("admin-1");
  });

  it("passes a non-administrator's refusal through as 403", async () => {
    mocks.readMailLimitSettings.mockRejectedValue(new AppError("administrator_required", "no", 403));
    const response = await GET(getEvent());
    expect(response.status).toBe(403);
    expect((await response.json()).error.code).toBe("administrator_required");
  });

  it("refuses a signed-out caller with 401", async () => {
    mocks.requireSession.mockRejectedValue(new AuthError("session_required", "x", 401));
    expect((await GET(getEvent())).status).toBe(401);
    expect(mocks.readMailLimitSettings).not.toHaveBeenCalled();
  });
});

describe("POST /api/admin/mail-limit", () => {
  it("sets a whole-megabyte limit, converted to bytes, with the version the caller read", async () => {
    const response = await POST(postEvent({ action: "set", expectedVersion: 2, megabytes: 40 }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ mailLimit });
    expect(mocks.setMailLimit).toHaveBeenCalledWith("admin-1", 2, 40 * MIB);
  });

  it("accepts 1 MB and 50 MB, the ends of the range", async () => {
    expect((await POST(postEvent({ action: "set", expectedVersion: 1, megabytes: 1 }))).status).toBe(200);
    expect((await POST(postEvent({ action: "set", expectedVersion: 1, megabytes: 50 }))).status).toBe(200);
  });

  it("returns to the default with a null limit", async () => {
    await POST(postEvent({ action: "default", expectedVersion: 5 }));
    expect(mocks.setMailLimit).toHaveBeenCalledWith("admin-1", 5, null);
  });

  it.each([
    ["0 MB", { action: "set", expectedVersion: 1, megabytes: 0 }],
    ["51 MB", { action: "set", expectedVersion: 1, megabytes: 51 }],
    ["fractional megabytes", { action: "set", expectedVersion: 1, megabytes: 10.5 }],
    ["megabytes as a string", { action: "set", expectedVersion: 1, megabytes: "20" }],
    ["no megabytes", { action: "set", expectedVersion: 1 }],
    ["version zero", { action: "default", expectedVersion: 0 }],
    ["no version", { action: "default" }],
    ["an unknown action", { action: "unlimited", expectedVersion: 1 }],
  ])("rejects %s with 422 and writes nothing", async (_label, body) => {
    const response = await POST(postEvent(body));
    expect(response.status).toBe(422);
    expect(mocks.setMailLimit).not.toHaveBeenCalled();
  });

  it("passes the engine's 403, 409 and 422 through with their codes", async () => {
    mocks.setMailLimit.mockRejectedValueOnce(new AppError("administrator_required", "no", 403));
    expect((await POST(postEvent({ action: "default", expectedVersion: 1 }))).status).toBe(403);
    mocks.setMailLimit.mockRejectedValueOnce(new AppError("mail_limit_version_conflict", "stale", 409));
    const conflict = await POST(postEvent({ action: "default", expectedVersion: 1 }));
    expect(conflict.status).toBe(409);
    expect((await conflict.json()).error.code).toBe("mail_limit_version_conflict");
  });

  it("refuses a signed-out caller, a missing CSRF token and a cross-origin post, writing nothing", async () => {
    mocks.requireSession.mockRejectedValueOnce(new AuthError("session_required", "x", 401));
    expect((await POST(postEvent({ action: "default", expectedVersion: 1 }))).status).toBe(401);
    expect((await POST(postEvent({ action: "default", expectedVersion: 1 }, { csrf: "" }))).status).toBe(403);
    expect((await POST(postEvent({ action: "default", expectedVersion: 1 }, { origin: "https://evil.example" }))).status).toBe(403);
    expect(mocks.setMailLimit).not.toHaveBeenCalled();
  });

  it("answers 503 during maintenance", async () => {
    mocks.assertOutsideMaintenance.mockRejectedValue(new MaintenanceActiveError(null));
    expect((await POST(postEvent({ action: "default", expectedVersion: 1 }))).status).toBe(503);
    expect(mocks.setMailLimit).not.toHaveBeenCalled();
  });
});
