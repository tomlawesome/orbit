import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { fixtureApi } from "../support/fixture-api.mjs";

/*
 * tests/support/fixture-api.mjs stands in for a fixtures instance in the
 * happy-dom page tests (#1613, ADR-0039). Several of its bodies are retyped
 * from the routes' inline `fixture` handlers rather than imported, so this
 * pins them: for every route it answers, the body the stand-in gives must
 * deep-equal what the route's own handler answers under ORBIT_FIXTURES=1.
 * Without it, a route's fixture changing (the workspace's `fixtureToday`
 * envelope did, #1357) would leave the page tests on stale data.
 */
vi.mock("orbit/server/maintenance", () => ({ assertOutsideMaintenance: vi.fn() }));
vi.mock("orbit/lib/env", () => ({ getAuthConfig: vi.fn().mockReturnValue({}) }));
vi.mock("orbit/lib/auth/session", () => ({ requireSession: vi.fn(), assertCsrf: vi.fn() }));

const routeModules = import.meta.glob("../../web/src/routes/api/**/+server.js");
/** @type {Map<string, any>} route modules by folder, filled once in beforeAll */
const loaded = new Map();
/** @param {string} dir the route's folder under web/src/routes/api */
const routeOf = (dir) => loaded.get(dir);

const ROUTES = /** @type {const} */ ([
  ["/api/auth/session", "auth/session"],
  ["/api/workspace", "workspace"],
  ["/api/join-requests", "join-requests"],
  ["/api/imap-inbox", "imap-inbox"],
  ["/api/admin/users", "admin/users"],
  ["/api/admin/mailbox", "admin/mailbox"],
  ["/api/admin/contact", "admin/contact"],
  ["/api/admin/upload-limit", "admin/upload-limit"],
  ["/api/admin/mail-limit", "admin/mail-limit"],
]);

const HOUSEHOLD_ROUTES = /** @type {const} */ ([
  ["members", "members"],
  ["invitations", "invitations"],
]);

/*
 * The first import of the routes is cold (a full module graph, compiled on a
 * busy host), so it is paid once here under a long timeout, not inside the
 * first test's 5 s (#1719, agent-infra#108).
 */
beforeAll(async () => {
  const dirs = [...ROUTES.map(([, dir]) => dir), ...HOUSEHOLD_ROUTES.map(([, dir]) => `households/[householdId]/${dir}`)];
  for (const dir of dirs) loaded.set(dir, await routeModules[`../../web/src/routes/api/${dir}/+server.js`]());
}, 120_000);

const event = (/** @type {Record<string, string>} */ params = {}, path = "/") => ({
  cookies: { get: () => undefined, set: () => {} },
  params,
  url: new URL(path, "http://localhost"),
  request: new Request(new URL(path, "http://localhost")),
});

describe("fixture-api bodies match the routes' fixture handlers", () => {
  afterEach(() => vi.unstubAllEnvs());

  for (const [path, dir] of ROUTES) {
    it(`GET ${path}`, async () => {
      vi.stubEnv("ORBIT_FIXTURES", "1");
      const { GET } = routeOf(dir);
      const route = await GET(event({}, path));
      expect(route.status).toBe(200);
      const standIn = await fixtureApi().fetch(path);
      expect(standIn.status).toBe(200);
      expect(await standIn.json()).toEqual(await route.json());
    });
  }

  for (const [what, dir] of HOUSEHOLD_ROUTES) {
    for (const id of ["hh-harlow-1", "hh-seaside-4551", "hh-unknown"]) {
      it(`GET /api/households/${id}/${what}`, async () => {
        vi.stubEnv("ORBIT_FIXTURES", "1");
        const { GET } = routeOf(`households/[householdId]/${dir}`);
        const path = `/api/households/${id}/${what}`;
        const route = await GET(event({ householdId: id }, path));
        const standIn = await fixtureApi().fetch(path);
        expect(standIn.status).toBe(route.status);
        expect(await standIn.json()).toEqual(await route.json());
      });
    }
  }
});
