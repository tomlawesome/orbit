import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/*
 * The signed-out boundary for screens (#789), moved from
 * tests/e2e/signed-out.spec.ts (#1612, ADR-0039): hooks.server.js's `handle`
 * is a plain ESM module once its imports are aliased, so the gate's decisions
 * need no browser and no stack.
 *
 * The API refuses a signed-out request itself (web/src/lib/server/api.js, and
 * tests/integration/authorization-matrix.test.ts); the screens are gated by
 * this hook, and it fails CLOSED:
 *   - a gated screen answers 303 to the door before any of it is rendered
 *     (`resolve` is never called: a 200 here is the bug);
 *   - the address asked for travels as `returnTo`, query string included;
 *   - no screen has to be remembered: a route nobody has heard of is gated too;
 *   - a forged cookie, and a session lookup that fails, are refused exactly
 *     like no cookie, so a stranger learns nothing about which it was;
 *   - the door, the goodbye and the arrival stay reachable.
 *
 * Same shape as tests/unit/hooks-server-maintenance-doors.test.mjs.
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
vi.mock("orbit/server/key-state", () => ({ getKeyState: () => ({ verdict: "usable", heldKeyId: "a".repeat(24) }) }));
vi.mock("orbit/lib/logger", () => ({ log: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }));

const PAGE_HTML = "<!doctype html><title>Orbit</title><main>the page itself</main>";

/** A GET for `path` (matched as route `id`), carrying whatever cookies the browser would send. */
function eventFor(id, path = id, cookies = {}) {
  return {
    route: { id },
    url: new URL(`http://orbit.invalid${path}`),
    request: new Request(`http://orbit.invalid${path}`),
    isDataRequest: false,
    locals: {},
    fetch: vi.fn(),
    cookies: { get: vi.fn((name) => cookies[name]), set: vi.fn(), delete: vi.fn() },
  };
}

async function handleRoute(event) {
  const { handle } = await import("../../web/src/hooks.server.js");
  const resolve = vi.fn(async () => new Response(PAGE_HTML, { status: 200, headers: { "content-type": "text/html" } }));
  const outcome = await handle({ event, resolve }).then(
    (response) => ({ response }),
    (thrown) => ({ thrown }),
  );
  return { resolve, ...outcome };
}

/** SvelteKit's redirect() throws; this is what the hook hands the framework. */
function expectRedirect({ resolve, response, thrown }, location) {
  expect(response, "the screen was answered instead of redirected").toBeUndefined();
  expect(thrown).toMatchObject({ status: 303, location });
  expect(resolve, "the screen was rendered before the redirect").not.toHaveBeenCalled();
}

describe("hooks.server handle: the signed-out boundary (#789)", () => {
  beforeAll(async () => {
    await import("../../web/src/hooks.server.js");
  }, COLD_IMPORT_TIMEOUT_MS);

  beforeEach(() => {
    delete process.env.ORBIT_FIXTURES;
    for (const mock of Object.values(mocks)) mock.mockReset();
    mocks.readEffectiveMaintenance.mockResolvedValue({ effectivelyActive: false, expectedEndAt: null });
    mocks.readSession.mockResolvedValue(null);
    mocks.getAuthConfig.mockReturnValue({ secureCookies: false });
  });

  /* /about is here by name too (#1256): a signed-out visitor is not served it, and
     its API's 401 is in tests/unit/about-route.test.mjs. */
  it.each(["/settings", "/about"])("redirects the gated screen %s to the door on the server, before any of it is sent", async (id) => {
    expectRedirect(await handleRoute(eventFor(id)), `/login?returnTo=${encodeURIComponent(id)}`);
  }, COLD_IMPORT_TIMEOUT_MS);

  it("gates a second screen the same way, and one no list has ever heard of: the gate is the default", async () => {
    expectRedirect(await handleRoute(eventFor("/administration")), "/login?returnTo=%2Fadministration");
    expectRedirect(await handleRoute(eventFor("/a-screen-added-tomorrow")), "/login?returnTo=%2Fa-screen-added-tomorrow");
  }, COLD_IMPORT_TIMEOUT_MS);

  it("carries the query string to the door", async () => {
    expectRedirect(await handleRoute(eventFor("/inbox", "/inbox?filter=due")), "/login?returnTo=%2Finbox%3Ffilter%3Ddue");
  }, COLD_IMPORT_TIMEOUT_MS);

  it("refuses a junk session cookie exactly like no cookie at all", async () => {
    const junk = { "orbit-session": "not-a-real-session", "__Host-orbit-session": "not-a-real-session" };
    const bare = await handleRoute(eventFor("/settings"));
    const forged = await handleRoute(eventFor("/settings", "/settings", junk));

    expectRedirect(forged, "/login?returnTo=%2Fsettings");
    expect(forged.thrown).toEqual(bare.thrown);
    /* the cookie was looked at, not skipped: the lookup is what said no */
    expect(mocks.readSession).toHaveBeenCalledTimes(2);
  }, COLD_IMPORT_TIMEOUT_MS);

  it("answers a session lookup that fails (unreachable database, unconfigured provider) the same way", async () => {
    mocks.readSession.mockRejectedValue(new Error("database away"));

    expectRedirect(await handleRoute(eventFor("/settings")), "/login?returnTo=%2Fsettings");
  }, COLD_IMPORT_TIMEOUT_MS);

  it.each(["/", "/login", "/logout"])("%s stays reachable signed out", async (id) => {
    const { response, resolve, thrown } = await handleRoute(eventFor(id));

    expect(thrown).toBeUndefined();
    expect(response.status).toBe(200);
    expect(resolve).toHaveBeenCalledTimes(1);
  }, COLD_IMPORT_TIMEOUT_MS);
});
