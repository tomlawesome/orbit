import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/*
 * #1405: hooks.server.js's `handle` while Orbit holds no usable encryption
 * key. Every screen answers 503 with the one explanatory screen, at the URL
 * that was asked for, and nothing about the reader is looked at: no session
 * (administrators get no way round), no maintenance read. Only the goodbye
 * (/logout) is left alone, because it reads nothing and anyone may leave.
 * Unknown (the self-test has not run) is treated exactly as unusable: a gate
 * that fails open before the verdict exists is a gate with a hole at startup.
 *
 * Same shape as tests/unit/hooks-server-door.test.mjs, whose cold-import
 * handling and request double this copies.
 */
const COLD_IMPORT_TIMEOUT_MS = 30_000;

const mocks = vi.hoisted(() => ({
  readSession: vi.fn(),
  getAuthConfig: vi.fn(),
  hasOnwardHousehold: vi.fn(),
  readEffectiveMaintenance: vi.fn(),
  getKeyState: vi.fn(),
}));

vi.mock("orbit/lib/auth/session", () => ({ readSession: mocks.readSession }));
vi.mock("orbit/lib/env", () => ({ getAuthConfig: mocks.getAuthConfig }));
vi.mock("orbit/server/workspace-repository", () => ({ hasOnwardHousehold: mocks.hasOnwardHousehold }));
vi.mock("orbit/server/maintenance", () => ({ readEffectiveMaintenance: mocks.readEffectiveMaintenance }));
vi.mock("orbit/server/key-state", () => ({ getKeyState: mocks.getKeyState }));
vi.mock("orbit/lib/logger", () => ({ log: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }));

const SCREEN = "<!doctype html><title>Orbit</title><h1>locked</h1>";
const OWN_BODY = "<!doctype html><title>Orbit</title><h1>the maintenance route's own render</h1>";

const UNUSABLE = { verdict: "unusable", reason: "missing" };
const administrator = { user: { id: "admin-1", isInstanceAdmin: true }, activeHouseholdId: "household-1" };

/** A request for a screen, with the cookies the browser would send. */
function eventFor(id, cookies = {}) {
  const path = id.replace("[token]", "token-1");
  return {
    route: { id },
    url: new URL(`http://orbit.invalid${path}`),
    request: new Request(`http://orbit.invalid${path}`),
    isDataRequest: false,
    locals: {},
    /* what SvelteKit's in-process fetch of /maintenance would hand back */
    fetch: vi.fn(async () => new Response(SCREEN, {
      status: 200,
      headers: { "content-type": "text/html", etag: 'W/"screen-1"', "cache-control": "max-age=60" },
    })),
    cookies: {
      get: vi.fn((name) => cookies[name]),
      set: vi.fn(),
      delete: vi.fn(),
    },
  };
}

function resolver(body = OWN_BODY) {
  return vi.fn(async () => new Response(body, { status: 200, headers: { "content-type": "text/html", etag: 'W/"own-1"' } }));
}

async function handleWith(event, resolve = resolver()) {
  const { handle } = await import("../../web/src/hooks.server.js");
  const response = await handle({ event, resolve });
  return { response, resolve };
}

describe("hooks.server handle with no usable encryption key (#1405)", () => {
  beforeAll(async () => {
    await import("../../web/src/hooks.server.js");
  }, COLD_IMPORT_TIMEOUT_MS);

  beforeEach(() => {
    delete process.env.ORBIT_FIXTURES;
    for (const mock of Object.values(mocks)) mock.mockReset();
    mocks.getKeyState.mockReturnValue(UNUSABLE);
    mocks.readEffectiveMaintenance.mockResolvedValue({ effectivelyActive: false, expectedEndAt: null });
    mocks.getAuthConfig.mockReturnValue({ secureCookies: false });
  });

  it.each([
    "/",
    "/login",
    "/home",
    "/settings",
    "/invite/[token]",
    "/setup/[token]",
    "/approve/[token]",
    "/auth/error",
  ])("answers %s with the key screen, at that address, 503, never stored", async (id) => {
    const event = eventFor(id);

    const { response, resolve } = await handleWith(event);

    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("etag")).toBeNull();
    expect(response.headers.get("retry-after")).toBeNull();
    expect(await response.text()).toBe(SCREEN);
    expect(event.fetch).toHaveBeenCalledTimes(1);
    expect(String(event.fetch.mock.calls[0][0])).toBe("/maintenance");
    expect(resolve).not.toHaveBeenCalled();
    expect(mocks.readSession).not.toHaveBeenCalled();
    expect(mocks.readEffectiveMaintenance).not.toHaveBeenCalled();
    expect(mocks.hasOnwardHousehold).not.toHaveBeenCalled();
    expect(event.locals.session).toBeUndefined();
  }, COLD_IMPORT_TIMEOUT_MS);

  it("answers /maintenance with its own render, 503, rather than fetching itself", async () => {
    const event = eventFor("/maintenance");

    const { response, resolve } = await handleWith(event);

    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("etag")).toBeNull();
    expect(response.headers.get("retry-after")).toBeNull();
    expect(await response.text()).toBe(OWN_BODY);
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(event.fetch).not.toHaveBeenCalled();
    expect(mocks.readSession).not.toHaveBeenCalled();
  }, COLD_IMPORT_TIMEOUT_MS);

  it("leaves the goodbye alone: /logout is resolved unchanged and reads nothing", async () => {
    const event = eventFor("/logout");

    const { response, resolve } = await handleWith(event);

    expect(response.status).toBe(200);
    expect(await response.text()).toBe(OWN_BODY);
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(event.fetch).not.toHaveBeenCalled();
    expect(mocks.readSession).not.toHaveBeenCalled();
    expect(mocks.readEffectiveMaintenance).not.toHaveBeenCalled();
  }, COLD_IMPORT_TIMEOUT_MS);

  it("does not intercept the API, which has its own gate and its own envelope", async () => {
    const event = eventFor("/api/auth/session");

    const { response, resolve } = await handleWith(event);

    expect(response.status).toBe(200);
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(event.fetch).not.toHaveBeenCalled();
  }, COLD_IMPORT_TIMEOUT_MS);

  it("gives an instance administrator with a live session no way round", async () => {
    mocks.readSession.mockResolvedValue(administrator);
    const event = eventFor("/home", { "orbit-session": "token" });

    const { response, resolve } = await handleWith(event);

    expect(response.status).toBe(503);
    expect(resolve).not.toHaveBeenCalled();
    expect(mocks.readSession).not.toHaveBeenCalled();
  }, COLD_IMPORT_TIMEOUT_MS);

  it("treats a verdict that has not been taken yet as unusable", async () => {
    mocks.getKeyState.mockReturnValue({ verdict: "unknown" });
    const event = eventFor("/home");

    const { response, resolve } = await handleWith(event);

    expect(response.status).toBe(503);
    expect(resolve).not.toHaveBeenCalled();
    expect(mocks.readEffectiveMaintenance).not.toHaveBeenCalled();
  }, COLD_IMPORT_TIMEOUT_MS);

  it("answers with the key screen, no countdown, even while operator maintenance is also on", async () => {
    mocks.readEffectiveMaintenance.mockResolvedValue({
      effectivelyActive: true,
      expectedEndAt: new Date(Date.now() + 3_600_000),
    });
    mocks.readSession.mockResolvedValue(administrator);
    const event = eventFor("/home", { "orbit-session": "token" });

    const { response, resolve } = await handleWith(event);

    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBeNull();
    expect(await response.text()).toBe(SCREEN);
    expect(resolve).not.toHaveBeenCalled();
    expect(mocks.readEffectiveMaintenance).not.toHaveBeenCalled();
    expect(mocks.readSession).not.toHaveBeenCalled();
  }, COLD_IMPORT_TIMEOUT_MS);

  it("leaves the fixture harness alone, which never boots and has no key", async () => {
    process.env.ORBIT_FIXTURES = "1";
    const event = eventFor("/home");

    const { response, resolve } = await handleWith(event);

    expect(response.status).toBe(200);
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(event.fetch).not.toHaveBeenCalled();
  }, COLD_IMPORT_TIMEOUT_MS);

  it("does nothing new when the key is usable: the maintenance read and the session gate go on as before", async () => {
    mocks.getKeyState.mockReturnValue({ verdict: "usable", heldKeyId: "a".repeat(24) });
    mocks.readSession.mockResolvedValue(administrator);
    const event = eventFor("/home", { "orbit-session": "token" });

    const { response, resolve } = await handleWith(event);

    expect(response.status).toBe(200);
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(mocks.readEffectiveMaintenance).toHaveBeenCalledTimes(1);
    expect(event.locals.session).toBe(administrator);
    expect(event.fetch).not.toHaveBeenCalled();
  }, COLD_IMPORT_TIMEOUT_MS);
});
