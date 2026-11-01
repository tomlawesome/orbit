/*
 * A fetch stand-in that answers the way a fixtures instance (ORBIT_FIXTURES=1)
 * does, for page mounts in happy-dom. The bodies are the ones the fixtures
 * instance serves: web/src/lib/data/fixtures/*.js, read here directly rather
 * than invented, so a page mounted in Vitest sees the data the rig's pages see.
 *
 *   const api = fixtureApi({ "GET /api/join-requests": () => ({ requests: [] }) });
 *   vi.stubGlobal("fetch", api.fetch);
 *   api.calls   every request made, as { method, path, body }
 *
 * An override is keyed "METHOD /path" (a `RegExp` source in place of the path
 * is not supported: use the exact path) and returns a body, or a Response for
 * a status of its own. Unlisted calls answer 404 in the shared error envelope.
 */
import { ADMIN_USERS_FIXTURE } from "../../web/src/lib/data/fixtures/admin.js";
import { INVITATIONS_FIXTURE, MEMBERS_FIXTURE } from "../../web/src/lib/data/fixtures/household.js";
import { INBOX_FIXTURE } from "../../web/src/lib/data/fixtures/inbox.js";
import { SESSION_FIXTURE, WORKSPACE_FIXTURE } from "../../web/src/lib/data/fixtures/workspace.js";

/** @param {unknown} body @param {number} [status] */
export const jsonResponse = (body, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { "content-type": "application/json", "cache-control": "no-store" },
});

/** The pending join request the fixtures instance serves (api/join-requests). */
export const FIXTURE_JOIN_REQUESTS = [{
  id: "jr-rob-seaside", householdId: "hh-seaside-4551", householdName: "Seaside Cottage",
  userId: "u-rob", displayName: "Rob Harlow", createdAt: "2026-08-11T12:00:00.000Z",
}];

/**
 * @param {Record<string, (call: { method: string, path: string, body: any, url: URL }) => unknown>} [overrides]
 */
export function fixtureApi(overrides = {}) {
  /** @type {{ method: string, path: string, body: any }[]} */
  const calls = [];
  /** @type {Record<string, (call: any) => unknown>} */
  const routes = {
    "GET /api/auth/session": () => structuredClone(SESSION_FIXTURE),
    "GET /api/workspace": () => ({ workspace: structuredClone(WORKSPACE_FIXTURE) }),
    "GET /api/join-requests": () => ({ requests: structuredClone(FIXTURE_JOIN_REQUESTS) }),
    "GET /api/imap-inbox": () => structuredClone(INBOX_FIXTURE),
    /* administration: what the fixtures instance answers; the rest (rotation,
       document health, recovery bundle, operations) it cannot, and a page
       that reads them treats that as "no card" */
    "GET /api/admin/users": () => structuredClone(ADMIN_USERS_FIXTURE),
    "GET /api/admin/mailbox": () => ({ mailbox: null }),
    "GET /api/admin/contact": () => ({ contact: { address: null, version: 1, updatedAt: null } }),
    "GET /api/admin/upload-limit": () => ({ uploadLimit: {
      maxBytes: 50 * 1_048_576, defaultBytes: 50 * 1_048_576, overrideBytes: null,
      minBytes: 1 * 1_048_576, ceilingBytes: 200 * 1_048_576, /* the bounds are the engine's; no card here reads them */
      version: 1, updatedAt: null } }),
    ...overrides,
  };
  /**
   * @param {string | URL | Request} input
   * @param {RequestInit} [init]
   */
  async function fetchStandIn(input, init = {}) {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, "http://localhost");
    const method = (init.method ?? "GET").toUpperCase();
    const body = typeof init.body === "string" && init.body ? JSON.parse(init.body) : undefined;
    const call = { method, path: url.pathname, body };
    calls.push(call);
    /** @type {((call: any) => unknown) | undefined} */
    let route = routes[`${method} ${url.pathname}`];
    /* a `*` in a key stands for one path segment: "GET /api/imap-inbox/*" */
    if (!route) {
      const key = Object.keys(routes).find((one) => one.includes("*")
        && new RegExp(`^${one.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replaceAll("*", "[^/]+")}$`).test(`${method} ${url.pathname}`));
      if (key) route = routes[key];
    }
    const household = /^\/api\/households\/([^/]+)\/(members|invitations)$/.exec(url.pathname);
    if (!route && method === "GET" && household) {
      const [, id, what] = household;
      route = what === "members"
        ? () => structuredClone(MEMBERS_FIXTURE[id] ?? { members: [], candidates: [] })
        : () => ({ invitations: structuredClone(INVITATIONS_FIXTURE[id] ?? []) });
    }
    if (!route) return jsonResponse({ error: { code: "not_found", message: `no fixture for ${method} ${url.pathname}` } }, 404);
    const answer = await route({ ...call, url });
    return answer instanceof Response ? answer : jsonResponse(answer);
  }
  return { fetch: fetchStandIn, calls };
}
