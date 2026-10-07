import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/*
 * #1264: every gated screen is `no-store`, set once in the `handle` hook.
 *
 * Without it a browser may keep a signed-in page in its back/forward cache,
 * and Back after sign-out shows household content without asking the server.
 * The hook is the right place because it is also where the session gate
 * lives: a screen added tomorrow is gated, and therefore uncached, with its
 * author doing nothing. Open screens and the API are deliberately untouched
 * here -- the API sets its own headers per route.
 *
 * Plain ESM once `orbit/...` is aliased (vitest.config.ts); same pattern as
 * tests/unit/hooks-server-init.test.mjs.
 */
const COLD_IMPORT_TIMEOUT_MS = 30_000;

const mocks = vi.hoisted(() => ({
  readSession: vi.fn(),
  readEffectiveMaintenance: vi.fn(),
}));

vi.mock("orbit/lib/auth/session", () => ({ readSession: mocks.readSession }));
vi.mock("orbit/lib/env", () => ({ getAuthConfig: () => ({}) }));
vi.mock("orbit/server/maintenance", () => ({
  readEffectiveMaintenance: mocks.readEffectiveMaintenance,
}));
vi.mock("orbit/server/workspace-repository", () => ({
  hasOnwardHousehold: vi.fn().mockResolvedValue(true),
}));

const SESSION = { user: { id: "u1", isInstanceAdmin: false }, activeHouseholdId: "h1" };

/** A request for a route id, answered by a fake `resolve` like SvelteKit's:
 *  a 200 page that already carries an ETag and its own cache-control. */
async function handleRoute(routeId, { cacheControl = "max-age=3600" } = {}) {
  const { handle } = await import("../../web/src/hooks.server.js");
  const event = {
    route: { id: routeId },
    url: new URL(`http://orbit.test${routeId}`),
    cookies: {},
    locals: {},
    fetch: vi.fn(),
  };
  const resolve = vi.fn(
    async () =>
      new Response("page", {
        status: 200,
        headers: { etag: 'W/"abc"', ...(cacheControl ? { "cache-control": cacheControl } : {}) },
      }),
  );
  const response = await handle({ event, resolve });
  return { response, resolve };
}

describe("hooks.server handle: cache-control on gated screens (#1264)", () => {
  beforeAll(async () => {
    await import("../../web/src/hooks.server.js");
  }, COLD_IMPORT_TIMEOUT_MS);

  beforeEach(() => {
    vi.resetModules();
    mocks.readSession.mockReset();
    mocks.readSession.mockResolvedValue(SESSION);
    mocks.readEffectiveMaintenance.mockReset();
    mocks.readEffectiveMaintenance.mockResolvedValue({ effectivelyActive: false, expectedEndAt: null });
  });

  it.each(["/home", "/settings", "/item/[itemId]", "/administration", "/household"])(
    "sends no-store on the gated screen %s",
    async (routeId) => {
      const { response, resolve } = await handleRoute(routeId);
      expect(resolve).toHaveBeenCalledTimes(1);
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
    },
    COLD_IMPORT_TIMEOUT_MS,
  );

  it("sends no-store even when the page set no cache-control of its own", async () => {
    const { response } = await handleRoute("/home", { cacheControl: null });
    expect(response.headers.get("cache-control")).toBe("no-store");
  }, COLD_IMPORT_TIMEOUT_MS);

  it("drops the ETag, so a copy cached earlier cannot be revalidated into a 304", async () => {
    const { response } = await handleRoute("/home");
    expect(response.headers.get("etag")).toBeNull();
  }, COLD_IMPORT_TIMEOUT_MS);

  it("leaves open screens exactly as the page set them", async () => {
    const { response } = await handleRoute("/login");
    expect(response.headers.get("cache-control")).toBe("max-age=3600");
    expect(response.headers.get("etag")).toBe('W/"abc"');
  }, COLD_IMPORT_TIMEOUT_MS);

  it("leaves the API and unmatched paths to their own headers", async () => {
    for (const routeId of ["/api/items", null]) {
      const { response } = await handleRoute(routeId);
      expect(response.headers.get("cache-control")).toBe("max-age=3600");
    }
  }, COLD_IMPORT_TIMEOUT_MS);

  it("sends the signed-out reader to the door without serving the screen", async () => {
    mocks.readSession.mockResolvedValue(null);
    const { handle } = await import("../../web/src/hooks.server.js");
    const resolve = vi.fn();
    const event = {
      route: { id: "/home" },
      url: new URL("http://orbit.test/home"),
      cookies: {},
      locals: {},
      fetch: vi.fn(),
    };
    await expect(handle({ event, resolve })).rejects.toMatchObject({ status: 303 });
    expect(resolve).not.toHaveBeenCalled();
  }, COLD_IMPORT_TIMEOUT_MS);
});
