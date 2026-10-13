import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/*
 * #1405: the API wrapper (web/src/lib/server/api.js) is where the key gate
 * lives for every route that uses it. With no usable encryption key every
 * wrapped handler answers the bounded 503 BEFORE anything else is looked at
 * (the maintenance guard, the session, a credential), except a route that
 * opts out by name -- sign-out, so a member may still end a session.
 *
 * The real key-state module is used, set with `setKeyStateForTests`; only the
 * things the wrapper reaches past it are stood in for.
 */
const mocks = vi.hoisted(() => ({
  assertOutsideMaintenance: vi.fn(),
  requireSession: vi.fn(),
  assertCsrf: vi.fn(),
  getAuthConfig: vi.fn(),
  log: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

vi.mock("orbit/server/maintenance", () => ({ assertOutsideMaintenance: mocks.assertOutsideMaintenance }));
vi.mock("orbit/lib/auth/session", () => ({ requireSession: mocks.requireSession, assertCsrf: mocks.assertCsrf }));
vi.mock("orbit/lib/env", () => ({ getAuthConfig: mocks.getAuthConfig }));
vi.mock("orbit/lib/logger", async (importOriginal) => ({
  ...(await importOriginal()),
  log: mocks.log,
}));

const USABLE = { verdict: "usable", heldKeyId: "a".repeat(24) };
const UNUSABLE = { verdict: "unusable", reason: "mismatch", heldKeyId: "a".repeat(24), storedKeyId: "b".repeat(24) };

const event = (routeId = "/api/workspace") => ({
  route: { id: routeId },
  url: new URL(`http://orbit.invalid${routeId}`),
  request: new Request(`http://orbit.invalid${routeId}`, { method: "POST" }),
  cookies: { get: vi.fn(), set: vi.fn(), delete: vi.fn() },
});

const session = { user: { id: "u1" } };
const ok = () => Response.json({ fine: true });

let setKeyStateForTests;
let api;
let read;
let write;

beforeEach(async () => {
  vi.resetModules();
  delete process.env.ORBIT_FIXTURES;
  for (const mock of [mocks.assertOutsideMaintenance, mocks.requireSession, mocks.assertCsrf, mocks.getAuthConfig]) mock.mockReset();
  for (const mock of Object.values(mocks.log)) mock.mockReset();
  mocks.requireSession.mockResolvedValue(session);
  mocks.getAuthConfig.mockReturnValue({});
  ({ setKeyStateForTests } = await import("../../src/server/key-state"));
  ({ api, read, write } = await import("../../web/src/lib/server/api.js"));
  setKeyStateForTests(UNUSABLE);
});

afterEach(() => {
  vi.useRealTimers();
  setKeyStateForTests?.(undefined);
  delete process.env.ORBIT_FIXTURES;
});

describe("api() with no usable encryption key (#1405)", () => {
  it("answers the bounded 503 and never runs the handler", async () => {
    const handler = vi.fn(ok);

    const response = await api(handler)(event());

    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("retry-after")).toBeNull();
    expect(await response.json()).toEqual({ error: "encryption_key_unavailable" });
    expect(handler).not.toHaveBeenCalled();
  });

  it("treats a verdict not yet taken as unusable", async () => {
    setKeyStateForTests(undefined);
    const handler = vi.fn(ok);

    const response = await api(handler)(event());

    expect(response.status).toBe(503);
    expect(handler).not.toHaveBeenCalled();
  });

  it("runs the handler when the key is usable", async () => {
    setKeyStateForTests(USABLE);
    const handler = vi.fn(ok);

    const response = await api(handler)(event());

    expect(response.status).toBe(200);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("lets a route that opts out by name through, and only that route", async () => {
    const handler = vi.fn(ok);

    const response = await api(handler, { openWhileKeyUnusable: true })(event("/api/auth/logout"));

    expect(response.status).toBe(200);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("is answered in the shared envelope by an auth route too (its errorResponse passes the key error through)", async () => {
    const { authErrorResponse } = await import("../../src/lib/auth/http");
    const handler = vi.fn(ok);

    const response = await api(handler, { errorResponse: authErrorResponse })(event("/api/auth/local/login"));

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "encryption_key_unavailable" });
  });

  it("leaves the fixture harness alone, which never boots and so never has a verdict", async () => {
    process.env.ORBIT_FIXTURES = "1";
    setKeyStateForTests(undefined);
    const handler = vi.fn(ok);

    const response = await api(handler, { fixture: ok })(event());

    expect(response.status).toBe(200);
    expect(handler).not.toHaveBeenCalled();
  });

  it("closes read() and write() before the maintenance guard, the session or the CSRF check is touched", async () => {
    const handler = vi.fn(ok);

    const readResponse = await read(handler)(event());
    const writeResponse = await write(handler)(event());

    for (const response of [readResponse, writeResponse]) {
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ error: "encryption_key_unavailable" });
    }
    expect(mocks.assertOutsideMaintenance).not.toHaveBeenCalled();
    expect(mocks.requireSession).not.toHaveBeenCalled();
    expect(mocks.assertCsrf).not.toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();
  });

  it("answers the key error, not maintenance_active, when operator maintenance is also on", async () => {
    const { MaintenanceActiveError } = await import("../../src/lib/errors");
    mocks.assertOutsideMaintenance.mockRejectedValue(new MaintenanceActiveError(null));

    const response = await read(vi.fn(ok))(event());

    expect(await response.json()).toEqual({ error: "encryption_key_unavailable" });
  });

  it("goes on exactly as before when the key is usable", async () => {
    setKeyStateForTests(USABLE);
    const handler = vi.fn(ok);

    expect((await read(handler)(event())).status).toBe(200);
    expect((await write(handler)(event())).status).toBe(200);
    expect(mocks.assertOutsideMaintenance).toHaveBeenCalledTimes(2);
    expect(mocks.requireSession).toHaveBeenCalledTimes(2);
    expect(mocks.assertCsrf).toHaveBeenCalledTimes(1);
  });
});

describe("what the log says about a refused sign-in (#1405 section 4)", () => {
  const signIns = () => mocks.log.warn.mock.calls
    .map(([entry]) => entry)
    .filter((entry) => entry.event === "encryption.key");

  it("states each refused sign-in once, as blocked sign-in, without the key", async () => {
    await api(vi.fn(ok))(event("/api/auth/local/login"));

    expect(signIns()).toHaveLength(1);
    expect(signIns()[0]).toMatchObject({
      event: "encryption.key",
      state: "blocked",
      reason: "key_unavailable",
      action: "check_configuration",
      impact: "sign_in_blocked",
    });
    expect(JSON.stringify(signIns())).not.toContain("a".repeat(24));
  });

  it.each([
    "/api/auth/login",
    "/api/auth/local/login",
    "/api/auth/local/login/pending",
    "/api/auth/local/setup",
    "/api/auth/bootstrap/claim",
    "/api/auth/bootstrap/local",
    "/api/auth/approve",
  ])("logs a refusal on %s", async (routeId) => {
    await api(vi.fn(ok))(event(routeId));
    expect(signIns()).toHaveLength(1);
  });

  it.each([
    "/api/workspace",
    "/api/admin/health",
    "/api/auth/session",
    "/api/settings/reminders",
  ])("does not log a refusal on %s, which is not a sign-in and would drown the fault", async (routeId) => {
    await api(vi.fn(ok))(event(routeId));
    expect(signIns()).toEqual([]);
  });

  it("holds to ten lines in a minute, then says how many more it refused", async () => {
    vi.useFakeTimers();
    const route = api(vi.fn(ok));
    for (let attempt = 0; attempt < 12; attempt += 1) await route(event("/api/auth/local/login"));
    await vi.advanceTimersByTimeAsync(61_000);
    await route(event("/api/auth/local/login"));

    const lines = signIns();
    const summaries = lines.filter((entry) => String(entry.detail ?? "").includes("more sign-in attempts refused in the last minute"));
    expect(summaries).toHaveLength(1);
    expect(String(summaries[0].detail)).toContain("2 more");
    const individual = lines.filter((entry) => !summaries.includes(entry));
    expect(individual.length).toBeGreaterThanOrEqual(10);
    expect(individual.length).toBeLessThanOrEqual(11);
    expect(lines.length).toBeLessThanOrEqual(12);
  });
});
