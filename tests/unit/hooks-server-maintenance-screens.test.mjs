import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/*
 * #526, ADR-0013 decisions 2, 3, 4: what a screen request is answered while an
 * operator's maintenance window is open, at the hook (web/src/hooks.server.js).
 * Moved here from tests/e2e/maintenance.spec.ts (#1612, ADR-0039): these are
 * status codes and headers of the server's own first answer, which need no
 * browser. What the maintenance screen looks like (its entries, the drawer,
 * accessibility, the phone width) stays in the browser.
 *
 * The blocked reader gets the maintenance screen AT THE URL THEY ASKED FOR,
 * rendered through `event.fetch("/maintenance")`: 503, never stored, no
 * validator, and `Retry-After` when the operator said when to come back. The
 * door and the way out (/login, /logout) stay open, an instance administrator
 * passes everywhere, and an ordinary member is shown the screen. The API is a
 * separate boundary with its own guard, proved in
 * tests/integration/maintenance-guard.test.ts.
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
/* The key gate reads the process's key verdict first; these cases are about
   something else, so the key is usable. */
vi.mock("orbit/server/key-state", () => ({ getKeyState: () => ({ verdict: "usable", heldKeyId: "a".repeat(24) }) }));
vi.mock("orbit/lib/logger", () => ({ log: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }));

const PAGE_HTML = "<!doctype html><title>Orbit</title><main>the page itself</main>";
const MAINTENANCE_HTML = "<!doctype html><title>Orbit</title><main>maintenance — back soon</main>";
const MESSAGE = "We are moving Orbit to new storage.";

const administrator = { user: { id: "user-admin", isInstanceAdmin: true }, activeHouseholdId: "household-1" };
const member = { user: { id: "user-member", isInstanceAdmin: false }, activeHouseholdId: "household-1" };

/** A GET for a screen, with the session cookie only when `signedIn`. */
function eventFor(id, signedIn = false) {
  return {
    route: { id },
    url: new URL(`http://orbit.invalid${id}`),
    request: new Request(`http://orbit.invalid${id}`),
    isDataRequest: false,
    locals: {},
    /* what SvelteKit's in-process fetch of /maintenance hands back; the real
       one carries a validator, which the hook must drop */
    fetch: vi.fn(async () => new Response(MAINTENANCE_HTML, {
      status: 200,
      headers: { "content-type": "text/html", etag: 'W/"maintenance-1"' },
    })),
    cookies: { get: vi.fn((name) => (signedIn && name === "orbit-session" ? "token" : undefined)), set: vi.fn(), delete: vi.fn() },
  };
}

async function handleRoute(id, signedIn = false) {
  const { handle } = await import("../../web/src/hooks.server.js");
  const event = eventFor(id, signedIn);
  const resolve = vi.fn(async () => new Response(PAGE_HTML, {
    status: 200,
    headers: { "content-type": "text/html", etag: 'W/"page-1"' },
  }));
  const response = await handle({ event, resolve });
  return { event, resolve, response };
}

/** The maintenance screen as the blocked reader gets it: asked for at /maintenance, answered 503 at the URL they typed. */
async function expectTheScreen({ event, resolve, response }) {
  expect(response.status).toBe(503);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.get("etag")).toBeNull();
  expect(await response.text()).toBe(MAINTENANCE_HTML);
  expect(event.fetch).toHaveBeenCalledWith("/maintenance");
  expect(resolve).not.toHaveBeenCalled();
}

describe("hooks.server handle: screens during a maintenance window (#526)", () => {
  beforeAll(async () => {
    await import("../../web/src/hooks.server.js");
  }, COLD_IMPORT_TIMEOUT_MS);

  beforeEach(() => {
    delete process.env.ORBIT_FIXTURES;
    for (const mock of Object.values(mocks)) mock.mockReset();
    mocks.readEffectiveMaintenance.mockResolvedValue({
      effectivelyActive: true,
      expectedEndAt: new Date(Date.now() + 45 * 60_000),
      message: MESSAGE,
    });
    mocks.readSession.mockResolvedValue(null);
    mocks.getAuthConfig.mockReturnValue({ secureCookies: false });
  });

  it("gives a signed-out reader the maintenance screen at the URL they asked for: 503, never cached, when to come back", async () => {
    const answered = await handleRoute("/home");

    await expectTheScreen(answered);
    expect(Number(answered.response.headers.get("retry-after"))).toBeGreaterThan(0);
    // Not redirected to /maintenance: a reload after the window closes lands them where they were.
    expect(answered.response.headers.get("location")).toBeNull();
  }, COLD_IMPORT_TIMEOUT_MS);

  it("omits Retry-After when the operator has not said when to come back", async () => {
    mocks.readEffectiveMaintenance.mockResolvedValue({ effectivelyActive: true, expectedEndAt: null });

    const answered = await handleRoute("/home");

    await expectTheScreen(answered);
    expect(answered.response.headers.get("retry-after")).toBeNull();
  }, COLD_IMPORT_TIMEOUT_MS);

  it("closes the arrival too: a stranger is not an administrator", async () => {
    const answered = await handleRoute("/");

    await expectTheScreen(answered);
  }, COLD_IMPORT_TIMEOUT_MS);

  it.each(["/login", "/logout"])("%s stays open: the door and the way out", async (id) => {
    const { event, resolve, response } = await handleRoute(id);

    expect(response.status).toBe(200);
    expect(await response.text()).toBe(PAGE_HTML);
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(event.fetch).not.toHaveBeenCalled();
    // Neither reads any state: no session is looked up for them.
    expect(mocks.readSession).not.toHaveBeenCalled();
  }, COLD_IMPORT_TIMEOUT_MS);

  it("answers /maintenance itself 503 with the same screen, its own render rather than a fetch of itself", async () => {
    const { event, resolve, response } = await handleRoute("/maintenance");

    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("etag")).toBeNull();
    expect(await response.text()).toBe(PAGE_HTML);
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(event.fetch).not.toHaveBeenCalled();
  }, COLD_IMPORT_TIMEOUT_MS);

  it("lets an instance administrator through: the screen is not what they get", async () => {
    mocks.readSession.mockResolvedValue(administrator);

    const { event, resolve, response } = await handleRoute("/home", true);

    expect(response.status).toBe(200);
    expect(await response.text()).toBe(PAGE_HTML);
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(event.fetch).not.toHaveBeenCalled();
  }, COLD_IMPORT_TIMEOUT_MS);

  it("shows an ordinary signed-in member the screen", async () => {
    mocks.readSession.mockResolvedValue(member);

    const answered = await handleRoute("/home", true);

    await expectTheScreen(answered);
    expect(mocks.readSession).toHaveBeenCalledTimes(1);
  }, COLD_IMPORT_TIMEOUT_MS);

  it("reopens the instance at the same URL once the window has ended: the ordinary sign-in gate takes over", async () => {
    mocks.readEffectiveMaintenance.mockResolvedValue({ effectivelyActive: false, expectedEndAt: null });

    // Signed out, so the door and not the eclipse: a thrown 303 to the sign-in, carrying where they were.
    await expect(handleRoute("/home")).rejects.toMatchObject({ status: 303, location: "/login?returnTo=%2Fhome" });
  }, COLD_IMPORT_TIMEOUT_MS);

  it("leaves the API to its own guard and envelope: the hook does not intercept /api/*", async () => {
    const { event, resolve, response } = await handleRoute("/api/workspace");

    expect(response.status).toBe(200);
    expect(await response.text()).toBe(PAGE_HTML);
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(event.fetch).not.toHaveBeenCalled();
    expect(mocks.readEffectiveMaintenance).not.toHaveBeenCalled();
  }, COLD_IMPORT_TIMEOUT_MS);
});
