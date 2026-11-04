import { beforeEach, describe, expect, it, vi } from "vitest";

/*
 * `/api/admin/contact` (#860): the instance administrator's public contact
 * address. GET needs a session; POST is a `write()` (session + real CSRF check).
 * Neither route checks administrator-ness itself: it passes the caller's own
 * id to the engine, which refuses everyone else (403 administrator_required),
 * and that refusal must reach the client. POST bodies are a closed union:
 * `set` (address) or `clear`, each carrying a positive integer
 * `expectedVersion` (optimistic concurrency); anything else is 422. Answers are
 * no-store; fixtures answer an unset address without the engine.
 */
const mocks = vi.hoisted(() => ({
  getAuthConfig: vi.fn(),
  requireSession: vi.fn(),
  assertOutsideMaintenance: vi.fn(),
  readInstanceContactSettings: vi.fn(),
  setPublicContactAddress: vi.fn(),
  assertKeyUsable: vi.fn(),
}));

vi.mock("orbit/lib/env", () => ({ getAuthConfig: mocks.getAuthConfig }));
vi.mock("orbit/lib/auth/session", async (importOriginal) => ({ ...(await importOriginal()), requireSession: mocks.requireSession }));
vi.mock("orbit/server/maintenance", () => ({ assertOutsideMaintenance: mocks.assertOutsideMaintenance }));
vi.mock("orbit/server/instance-contact", () => ({
  readInstanceContactSettings: mocks.readInstanceContactSettings,
  setPublicContactAddress: mocks.setPublicContactAddress,
}));
vi.mock("orbit/server/key-state", () => ({ assertKeyUsable: mocks.assertKeyUsable, noteRefusedSignIn: vi.fn() }));

const { GET, POST } = await import("../../web/src/routes/api/admin/contact/+server.js");
const { csrfTokenForSession } = await import("orbit/lib/auth/session");
const { AuthError } = await import("orbit/lib/auth/errors");
const { AppError } = await import("orbit/lib/app-error");
const { MaintenanceActiveError } = await import("orbit/lib/errors");

const config = { appUrl: new URL("https://orbit.example"), sessionSecret: "s".repeat(48) };
const session = { id: "s-1", token: "tok-1", user: { id: "admin-1" } };
const contact = { address: "help@example.test", version: 3, updatedAt: "2026-10-01T00:00:00.000Z" };

const getEvent = () => ({ cookies: {}, request: new Request("https://orbit.example/api/admin/contact") });
function postEvent(body, { csrf = csrfTokenForSession(session, config), origin = "https://orbit.example" } = {}) {
  const headers = { origin, "content-type": "application/json" };
  if (csrf) headers["x-csrf-token"] = csrf;
  return {
    cookies: {},
    request: new Request("https://orbit.example/api/admin/contact", {
      method: "POST",
      headers,
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  };
}

beforeEach(() => {
  vi.unstubAllEnvs();
  for (const m of Object.values(mocks)) m.mockReset();
  mocks.getAuthConfig.mockReturnValue(config);
  mocks.requireSession.mockResolvedValue(session);
  mocks.readInstanceContactSettings.mockResolvedValue(contact);
  mocks.setPublicContactAddress.mockResolvedValue(contact);
});

describe("GET /api/admin/contact", () => {
  it("answers the administrator's own view, no-store", async () => {
    const response = await GET(getEvent());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ contact });
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(mocks.readInstanceContactSettings).toHaveBeenCalledWith("admin-1");
  });

  it("passes a non-administrator's refusal through as 403 administrator_required", async () => {
    mocks.readInstanceContactSettings.mockRejectedValue(new AppError("administrator_required", "Orbit administrator access is required", 403));
    const response = await GET(getEvent());
    expect(response.status).toBe(403);
    expect((await response.json()).error.code).toBe("administrator_required");
  });

  it("refuses a signed-out caller with 401", async () => {
    mocks.requireSession.mockRejectedValue(new AuthError("session_required", "A valid session is required", 401));
    const response = await GET(getEvent());
    expect(response.status).toBe(401);
    expect(mocks.readInstanceContactSettings).not.toHaveBeenCalled();
  });

  it("answers 503 during maintenance", async () => {
    mocks.assertOutsideMaintenance.mockRejectedValue(new MaintenanceActiveError(null));
    expect((await GET(getEvent())).status).toBe(503);
  });

  it("answers 'settable, not yet set' under fixtures without the engine", async () => {
    vi.stubEnv("ORBIT_FIXTURES", "1");
    const response = await GET(getEvent());
    expect(await response.json()).toEqual({ contact: { address: null, version: 1, updatedAt: null } });
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(mocks.readInstanceContactSettings).not.toHaveBeenCalled();
  });
});

describe("POST /api/admin/contact", () => {
  it("sets an address with the version the caller read, no-store", async () => {
    const response = await POST(postEvent({ action: "set", expectedVersion: 3, address: "new@example.test" }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ contact });
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(mocks.setPublicContactAddress).toHaveBeenCalledWith("admin-1", 3, "new@example.test");
  });

  it("clears with a null address, a distinct action from set", async () => {
    await POST(postEvent({ action: "clear", expectedVersion: 4 }));
    expect(mocks.setPublicContactAddress).toHaveBeenCalledWith("admin-1", 4, null);
  });

  it.each([
    ["an empty address (clear is its own action)", { action: "set", expectedVersion: 1, address: "" }],
    ["a missing address", { action: "set", expectedVersion: 1 }],
    ["a missing version", { action: "set", address: "a@example.test" }],
    ["version zero", { action: "set", expectedVersion: 0, address: "a@example.test" }],
    ["a fractional version", { action: "clear", expectedVersion: 1.5 }],
    ["a string version", { action: "clear", expectedVersion: "2" }],
    ["an unknown action", { action: "delete", expectedVersion: 1 }],
    ["no action", {}],
  ])("rejects %s with 422 validation_failed and writes nothing", async (_label, body) => {
    const response = await POST(postEvent(body));
    expect(response.status).toBe(422);
    expect((await response.json()).error.code).toBe("validation_failed");
    expect(mocks.setPublicContactAddress).not.toHaveBeenCalled();
  });

  it("never writes for a malformed JSON body", async () => {
    const response = await POST(postEvent("{nope"));
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(mocks.setPublicContactAddress).not.toHaveBeenCalled();
  });

  // FINDING (#1688, found by the #1066 sweep): an unparseable JSON body is the client's fault and
  // should be a 4xx (400 or 422). `event.request.json()` throws a SyntaxError that
  // `appErrorResponse` does not recognise, so it answers 500 internal_error and
  // logs an "application.error" as if Orbit had failed. Same pattern in every
  // route that parses the body with `await event.request.json()` unguarded.
  it.fails("answers a malformed JSON body with a 4xx, not a 500 (#1688)", async () => {
    const response = await POST(postEvent("{nope"));
    expect(response.status).toBeLessThan(500);
  });

  it("passes the engine's 409 for a stale version and 403 for a non-administrator through", async () => {
    mocks.setPublicContactAddress.mockRejectedValueOnce(new AppError("version_conflict", "Changed by someone else", 409));
    expect((await POST(postEvent({ action: "clear", expectedVersion: 1 }))).status).toBe(409);
    mocks.setPublicContactAddress.mockRejectedValueOnce(new AppError("administrator_required", "no", 403));
    expect((await POST(postEvent({ action: "clear", expectedVersion: 1 }))).status).toBe(403);
  });

  it("refuses a signed-out caller, a missing CSRF token and a cross-origin post, writing nothing", async () => {
    mocks.requireSession.mockRejectedValueOnce(new AuthError("session_required", "x", 401));
    expect((await POST(postEvent({ action: "clear", expectedVersion: 1 }))).status).toBe(401);
    expect((await POST(postEvent({ action: "clear", expectedVersion: 1 }, { csrf: "" }))).status).toBe(403);
    expect((await POST(postEvent({ action: "clear", expectedVersion: 1 }, { origin: "https://evil.example" }))).status).toBe(403);
    expect(mocks.setPublicContactAddress).not.toHaveBeenCalled();
  });

  it("answers 503 during maintenance", async () => {
    mocks.assertOutsideMaintenance.mockRejectedValue(new MaintenanceActiveError(null));
    expect((await POST(postEvent({ action: "clear", expectedVersion: 1 }))).status).toBe(503);
    expect(mocks.setPublicContactAddress).not.toHaveBeenCalled();
  });
});
