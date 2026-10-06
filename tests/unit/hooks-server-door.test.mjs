import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/*
 * #1252: hooks.server.js's `handle`, for route id `/` only.
 *
 * A signed-in member who refreshed `/` used to be served the sign-in door and
 * handed on to /home only once the browser had asked GET /api/auth/session --
 * long enough to see the door. `/` now decides on the server: a session that
 * already belongs somewhere is answered 303 to /home before any HTML is sent;
 * every other case is the door exactly as before. Both answers are never
 * cached, because the same address now means two things.
 *
 * Same shape as tests/unit/hooks-server-init.test.mjs: the hook is a plain ESM
 * module once `orbit/...`, `$app/environment` and `$env/dynamic/private` are
 * aliased (vitest.config.ts), and its cold transform is paid once in
 * `beforeAll` so no assertion times the compiler (#868).
 */
const COLD_IMPORT_TIMEOUT_MS = 30_000;

const mocks = vi.hoisted(() => ({
  readSession: vi.fn(),
  getAuthConfig: vi.fn(),
  hasOnwardHousehold: vi.fn(),
  readEffectiveMaintenance: vi.fn(),
}));

vi.mock("orbit/lib/auth/session", () => ({ readSession: mocks.readSession }));
vi.mock("orbit/lib/env", () => ({ getAuthConfig: mocks.getAuthConfig }));
vi.mock("orbit/server/workspace-repository", () => ({ hasOnwardHousehold: mocks.hasOnwardHousehold }));
vi.mock("orbit/server/maintenance", () => ({ readEffectiveMaintenance: mocks.readEffectiveMaintenance }));
vi.mock("orbit/lib/logger", () => ({ log: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }));

/* The real cookie name, off the real helper: secureCookies is false below. */
const INVITED = "orbit-invited";
const DOOR_HTML = "<!doctype html><title>Orbit</title><div class=signin-stage></div>";

const member = { user: { id: "user-1", isInstanceAdmin: false }, activeHouseholdId: "household-1" };
const adrift = { user: { id: "user-2", isInstanceAdmin: false }, activeHouseholdId: null };

/** A request for `/`, with whatever cookies the browser would send. */
function eventFor(cookies = {}, id = "/") {
  return {
    route: { id },
    url: new URL(`http://orbit.invalid${id}`),
    isDataRequest: false,
    locals: {},
    fetch: vi.fn(),
    cookies: {
      get: vi.fn((name) => cookies[name]),
      set: vi.fn(),
      delete: vi.fn(),
    },
  };
}

function doorResolver() {
  return vi.fn(async () => new Response(DOOR_HTML, { status: 200, headers: { "content-type": "text/html" } }));
}

async function handleRoot(event) {
  const { handle } = await import("../../web/src/hooks.server.js");
  const resolve = doorResolver();
  const response = await handle({ event, resolve });
  return { response, resolve };
}

async function expectTheDoor(response, resolve, event) {
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.text()).toBe(DOOR_HTML);
  expect(resolve).toHaveBeenCalledTimes(1);
  /* The door's load returns only `fixtures`; nothing about the reader may
     reach it, or its HTML would differ with and without a cookie. */
  expect(event.locals.session).toBeUndefined();
}

describe("hooks.server handle at `/` (#1252)", () => {
  beforeAll(async () => {
    await import("../../web/src/hooks.server.js");
  }, COLD_IMPORT_TIMEOUT_MS);

  beforeEach(() => {
    delete process.env.ORBIT_FIXTURES;
    for (const mock of Object.values(mocks)) mock.mockReset();
    mocks.readEffectiveMaintenance.mockResolvedValue({ effectivelyActive: false, expectedEndAt: null });
    mocks.getAuthConfig.mockReturnValue({ secureCookies: false });
  });

  it("answers a member with an active household 303 to /home, never cached, before any HTML", async () => {
    mocks.readSession.mockResolvedValue(member);
    const event = eventFor({ "orbit-session": "token" });

    const { response, resolve } = await handleRoot(event);

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/home");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(resolve).not.toHaveBeenCalled();
    expect(mocks.readSession).toHaveBeenCalledTimes(1);
    expect(mocks.hasOnwardHousehold).not.toHaveBeenCalled();
    expect(event.locals.session).toBeUndefined();
  }, COLD_IMPORT_TIMEOUT_MS);

  it("answers a member with no active household but an onward one 303 to /home", async () => {
    mocks.readSession.mockResolvedValue(adrift);
    mocks.hasOnwardHousehold.mockResolvedValue(true);
    const event = eventFor({ "orbit-session": "token" });

    const { response, resolve } = await handleRoot(event);

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/home");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(resolve).not.toHaveBeenCalled();
    expect(mocks.hasOnwardHousehold).toHaveBeenCalledWith("user-2", false);
  }, COLD_IMPORT_TIMEOUT_MS);

  it("serves the door to a session that belongs nowhere", async () => {
    mocks.readSession.mockResolvedValue(adrift);
    mocks.hasOnwardHousehold.mockResolvedValue(false);
    const event = eventFor({ "orbit-session": "token" });

    const { response, resolve } = await handleRoot(event);

    await expectTheDoor(response, resolve, event);
  }, COLD_IMPORT_TIMEOUT_MS);

  it("serves the door with no session or a stale one", async () => {
    mocks.readSession.mockResolvedValue(null);
    const event = eventFor();

    const { response, resolve } = await handleRoot(event);

    await expectTheDoor(response, resolve, event);
  }, COLD_IMPORT_TIMEOUT_MS);

  it("serves the door when the session read throws (database unreachable)", async () => {
    mocks.readSession.mockRejectedValue(new Error("connect ECONNREFUSED"));
    const event = eventFor({ "orbit-session": "token" });

    const { response, resolve } = await handleRoot(event);

    await expectTheDoor(response, resolve, event);
  }, COLD_IMPORT_TIMEOUT_MS);

  it("serves the door when the membership check throws", async () => {
    mocks.readSession.mockResolvedValue(adrift);
    mocks.hasOnwardHousehold.mockRejectedValue(new Error("connect ECONNREFUSED"));
    const event = eventFor({ "orbit-session": "token" });

    const { response, resolve } = await handleRoot(event);

    await expectTheDoor(response, resolve, event);
  }, COLD_IMPORT_TIMEOUT_MS);

  it("serves the door when auth is unconfigured (backend starting)", async () => {
    mocks.getAuthConfig.mockImplementation(() => {
      throw new Error("auth_unconfigured");
    });
    mocks.readSession.mockResolvedValue(member);
    const event = eventFor({ "orbit-session": "token" });

    const { response, resolve } = await handleRoot(event);

    await expectTheDoor(response, resolve, event);
  }, COLD_IMPORT_TIMEOUT_MS);

  it("serves the door to a member carrying the invited-landing cookie, and leaves the cookie alone", async () => {
    mocks.readSession.mockResolvedValue(member);
    const event = eventFor({ "orbit-session": "token", [INVITED]: "1" });

    const { response, resolve } = await handleRoot(event);

    await expectTheDoor(response, resolve, event);
    /* GET /api/auth/session reads and clears it, so the arrival still plays
       once; the hook may only look. */
    expect(event.cookies.set).not.toHaveBeenCalled();
    expect(event.cookies.delete).not.toHaveBeenCalled();
  }, COLD_IMPORT_TIMEOUT_MS);

  it("leaves every other gated route as it was: the session goes on locals", async () => {
    mocks.readSession.mockResolvedValue(member);
    const event = eventFor({ "orbit-session": "token" }, "/home");

    const { response, resolve } = await handleRoot(event);

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBeNull();
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(event.locals.session).toBe(member);
  }, COLD_IMPORT_TIMEOUT_MS);
});
