import { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import type { AuthConfig } from "@/lib/env";
import { createCsrfToken } from "@/lib/auth/crypto";

/**
 * "Sign out of every device" (#468). Only the database and the auth config
 * are stubbed: the session is read through the real `readSession`, the CSRF
 * token through the real `createCsrfToken`, and the revocation through the
 * real `revokeUserSessions` — so what these tests pin is the route's own
 * behaviour. The proof that a revoked device's *next* request is refused
 * needs a real database and lives in
 * tests/integration/auth-session-contracts.test.ts.
 */

const config: AuthConfig = {
  appUrl: new URL("https://orbit.example"),
  sessionSecret: "revoke-route-session-secret-that-is-long-enough",
  sessionTtlSeconds: 3600,
  issuer: "https://issuer.revoke.example.invalid/",
  clientId: "revoke-client",
  clientSecret: "revoke-client-secret",
  callbackUrl: "https://orbit.example/api/auth/callback",
  scopes: "openid profile email",
  claims: { email: "email", emailVerified: "email_verified", name: "name", avatar: "picture" },
  secureCookies: true,
};

const mocks = vi.hoisted(() => ({
  rows: [] as unknown[][],
  /** The rows the revoking delete claims to have removed. */
  removed: [] as Array<{ id: string }>,
  /** Every condition a delete was scoped by, in order. */
  deleteConditions: [] as unknown[],
  audits: [] as Array<Record<string, unknown>>,
}));

function queryStub(rows: unknown[]): Record<string, unknown> {
  const chain: Record<string, unknown> = new Proxy({}, {
    get(_target, property) {
      if (property === "then") {
        return (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) =>
          Promise.resolve(rows).then(resolve, reject);
      }
      return () => chain;
    },
  });
  return chain;
}

function deleteStub() {
  return {
    where: (condition: unknown) => {
      mocks.deleteConditions.push(condition);
      return {
        returning: async () => mocks.removed,
        then: (resolve: (value: unknown) => unknown) => Promise.resolve(undefined).then(resolve),
      };
    },
  };
}

/* The guard has its own contract and integration tests (#523); these
   tests pin the route's own behaviour, so it always passes here. */
vi.mock("@/server/maintenance", () => ({ assertOutsideMaintenance: vi.fn(async () => {}) }));
vi.mock("@/db", () => ({
  getDb: () => ({
    select: () => queryStub(mocks.rows.shift() ?? []),
    delete: deleteStub,
    transaction: async (run: (transaction: {
      delete: typeof deleteStub;
      insert: () => { values: (values: Record<string, unknown>) => Promise<void> };
    }) => Promise<number>) => run({
      delete: deleteStub,
      insert: () => ({ values: async (values: Record<string, unknown>) => { mocks.audits.push(values); } }),
    }),
  }),
}));
vi.mock("@/lib/env", () => ({ getAuthConfig: () => config }));

import { POST } from "./route";

const SESSION_TOKEN = "revoke-route-session-token";
const OTHER_TOKEN = "revoke-route-other-device-token";
const USER_ID = "22222222-2222-4222-8222-222222222222";
const OTHER_USER_ID = "33333333-3333-4333-8333-333333333333";
const URL_UNDER_TEST = "http://127.0.0.1:3000/api/auth/sessions/revoke";

function sessionRow(userId: string, overrides: Record<string, unknown> = {}) {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    activeHouseholdId: null,
    expiresAt: new Date(Date.now() + 3_600_000),
    userId,
    email: "revoke@example.invalid",
    emailVerified: true,
    displayName: "Revoking Reader",
    avatarUrl: null,
    isInstanceAdmin: false,
    disabledAt: null,
    themeMode: "dark",
    themeId: "starchart",
    textSize: "comfortable",
    urgencyPalette: "themed",
    emailNotifications: true,
    pushNotifications: true,
    ...overrides,
  };
}

function signedIn(headers: Record<string, string> = {}, token = SESSION_TOKEN): NextRequest {
  const request = new NextRequest(URL_UNDER_TEST, {
    method: "POST",
    headers: {
      origin: config.appUrl.origin,
      "sec-fetch-site": "same-origin",
      "x-csrf-token": createCsrfToken(token, config.sessionSecret),
      ...headers,
    },
  });
  request.cookies.set("__Host-orbit-session", token);
  return request;
}

async function revoke(rows: unknown[][], removed: Array<{ id: string }>, request = signedIn()) {
  mocks.rows.splice(0, mocks.rows.length, ...rows);
  mocks.removed.splice(0, mocks.removed.length, ...removed);
  const response = await POST(request);
  return { response, body: await response.json() as { revoked?: number; error?: { code: string; message: string } } };
}

function renderedDeletes(): Array<{ sql: string; params: unknown[] }> {
  const dialect = new PgDialect();
  return mocks.deleteConditions.map((condition) => {
    const query = dialect.sqlToQuery(condition as SQL);
    return { sql: query.sql, params: query.params };
  });
}

afterEach(() => {
  mocks.rows.length = 0;
  mocks.removed.length = 0;
  mocks.deleteConditions.length = 0;
  mocks.audits.length = 0;
});

describe("POST /api/auth/sessions/revoke", () => {
  it("deletes every session of the caller's user — not just the caller's own", async () => {
    const { response, body } = await revoke(
      [[sessionRow(USER_ID)]],
      [{ id: "session-one" }, { id: "session-two" }, { id: "session-three" }],
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(body).toEqual({ revoked: 3 });

    // The scope is the user, so the caller's other devices go too. A delete
    // narrowed by session id or token hash would leave one alive.
    expect(renderedDeletes()).toEqual([
      { sql: '"sessions"."user_id" = $1', params: [USER_ID] },
    ]);
  });

  it("clears the caller's own cookie so this device stops presenting a dead token", async () => {
    const { response } = await revoke([[sessionRow(USER_ID)]], [{ id: "session-one" }]);
    const cookie = response.headers.get("set-cookie") ?? "";
    expect(cookie).toContain("__Host-orbit-session=;");
    expect(cookie).toContain("Max-Age=0");
    expect(response.headers.get("set-cookie")).toContain("HttpOnly");
  });

  it("takes its scope from the session, never from the request", async () => {
    const request = new NextRequest(`${URL_UNDER_TEST}?userId=${OTHER_USER_ID}`, {
      method: "POST",
      headers: {
        origin: config.appUrl.origin,
        "sec-fetch-site": "same-origin",
        "x-csrf-token": createCsrfToken(OTHER_TOKEN, config.sessionSecret),
      },
    });
    request.cookies.set("__Host-orbit-session", OTHER_TOKEN);

    await revoke([[sessionRow(USER_ID)]], [{ id: "session-one" }], request);
    expect(renderedDeletes()[0].params).toEqual([USER_ID]);
    expect(renderedDeletes()[0].params).not.toContain(OTHER_USER_ID);
  });

  it("records the revocation with ids and a count only, never a token", async () => {
    await revoke([[sessionRow(USER_ID)]], [{ id: "session-one" }, { id: "session-two" }]);
    expect(mocks.audits).toEqual([{
      householdId: null,
      actorUserId: USER_ID,
      entityType: "user",
      entityId: USER_ID,
      action: "sessions_revoked",
      changes: { sessions: 2 },
    }]);
    expect(JSON.stringify(mocks.audits)).not.toContain(SESSION_TOKEN);
  });

  it("reports a count without a token or an id in the body", async () => {
    const { body } = await revoke([[sessionRow(USER_ID)]], [{ id: "session-one" }]);
    const raw = JSON.stringify(body);
    expect(raw).not.toContain(SESSION_TOKEN);
    expect(raw).not.toContain(USER_ID);
    expect(raw).not.toContain("session-one");
  });

  it("refuses a request without a session, and revokes nothing", async () => {
    const { response, body } = await revoke([], [], new NextRequest(URL_UNDER_TEST, {
      method: "POST",
      headers: { origin: config.appUrl.origin, "sec-fetch-site": "same-origin" },
    }));
    expect(response.status).toBe(401);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(body).toEqual({ error: { code: "session_required", message: "A valid session is required" } });
    expect(mocks.deleteConditions).toEqual([]);
    expect(mocks.audits).toEqual([]);
  });

  it("refuses a request without a CSRF token, and revokes nothing", async () => {
    const request = new NextRequest(URL_UNDER_TEST, {
      method: "POST",
      headers: { origin: config.appUrl.origin, "sec-fetch-site": "same-origin" },
    });
    request.cookies.set("__Host-orbit-session", SESSION_TOKEN);

    const { response, body } = await revoke([[sessionRow(USER_ID)]], [{ id: "session-one" }], request);
    expect(response.status).toBe(403);
    expect(body).toEqual({ error: { code: "csrf_failed", message: "The CSRF token is missing or invalid" } });
    expect(mocks.deleteConditions).toEqual([]);
    expect(mocks.audits).toEqual([]);
  });

  it("refuses a cross-site post carrying a valid token, and revokes nothing", async () => {
    const request = signedIn({ origin: "https://elsewhere.example.invalid", "sec-fetch-site": "cross-site" });
    const { response, body } = await revoke([[sessionRow(USER_ID)]], [{ id: "session-one" }], request);
    expect(response.status).toBe(403);
    expect(body.error?.code).toBe("csrf_failed");
    expect(mocks.deleteConditions).toEqual([]);
  });

  it("refuses a disabled account's cookie, and revokes nothing beyond that dead session", async () => {
    // readSession deletes the presented token when the account is disabled;
    // that is one scoped delete, and it is not a revocation.
    const { response } = await revoke([[sessionRow(USER_ID, { disabledAt: new Date() })]], [{ id: "session-one" }]);
    expect(response.status).toBe(401);
    expect(renderedDeletes()).toEqual([
      { sql: '"sessions"."token_hash" = $1', params: [expect.any(String)] },
    ]);
    expect(mocks.audits).toEqual([]);
  });
});
