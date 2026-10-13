import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/*
 * #1316 (owner decision 2026-10-12, option 1a): `/approve/[token]` and
 * `/setup/[token]` are doors during maintenance, like `/login` and `/logout`.
 * They are how the operator gets back in (approving an administrator, setting
 * up the first account), so they must answer as themselves while the instance
 * is closed, not as the 503 maintenance screen. `/invite/[token]` stays
 * closed: it is the control.
 *
 * Same shape as tests/unit/hooks-server-door.test.mjs: readEffectiveMaintenance
 * says the instance is closed, there is no session and no cookies.
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

const PAGE_HTML = "<!doctype html><title>Orbit</title><main>the page itself</main>";
const MAINTENANCE_HTML = "<!doctype html><title>Orbit</title><main>closed for maintenance</main>";

function eventFor(id) {
  const path = id.replace("[token]", "tok-1");
  return {
    route: { id },
    url: new URL(`http://orbit.invalid${path}`),
    request: new Request(`http://orbit.invalid${path}`),
    isDataRequest: false,
    locals: {},
    fetch: vi.fn(async () => new Response(MAINTENANCE_HTML, { status: 200, headers: { "content-type": "text/html" } })),
    cookies: { get: vi.fn(() => undefined), set: vi.fn(), delete: vi.fn() },
  };
}

async function handleRoute(id) {
  const { handle } = await import("../../web/src/hooks.server.js");
  const event = eventFor(id);
  const resolve = vi.fn(async () => new Response(PAGE_HTML, { status: 200, headers: { "content-type": "text/html" } }));
  const response = await handle({ event, resolve });
  return { event, resolve, response };
}

describe("hooks.server handle: doors during maintenance (#1316)", () => {
  beforeAll(async () => {
    await import("../../web/src/hooks.server.js");
  }, COLD_IMPORT_TIMEOUT_MS);

  beforeEach(() => {
    delete process.env.ORBIT_FIXTURES;
    for (const mock of Object.values(mocks)) mock.mockReset();
    mocks.readEffectiveMaintenance.mockResolvedValue({ effectivelyActive: true, expectedEndAt: null });
    mocks.readSession.mockResolvedValue(null);
    mocks.getAuthConfig.mockReturnValue({ secureCookies: false });
  });

  it.each(["/approve/[token]", "/setup/[token]"])(
    "answers %s with its own resolved 200 page, never the maintenance screen",
    async (id) => {
      const { event, resolve, response } = await handleRoute(id);

      expect(response.status).not.toBe(503);
      expect(response.status).toBe(200);
      expect(await response.text()).toBe(PAGE_HTML);
      expect(resolve).toHaveBeenCalledTimes(1);
      expect(event.fetch).not.toHaveBeenCalledWith("/maintenance");
      expect(event.fetch).not.toHaveBeenCalled();
    },
    COLD_IMPORT_TIMEOUT_MS,
  );

  it("control: still answers /invite/[token] 503 with the maintenance screen", async () => {
    const { event, resolve, response } = await handleRoute("/invite/[token]");

    expect(response.status).toBe(503);
    expect(await response.text()).toBe(MAINTENANCE_HTML);
    expect(event.fetch).toHaveBeenCalledWith("/maintenance");
    expect(resolve).not.toHaveBeenCalled();
  }, COLD_IMPORT_TIMEOUT_MS);
});
