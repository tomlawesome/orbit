import { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AuthConfig } from "@/lib/env";
import { createCsrfToken } from "@/lib/auth/crypto";

/**
 * The first-run tour endpoint's contract (#751, slice 1 of #477). Only the
 * database and the auth config are stubbed: the session is read through the
 * real `readSession`, the body through the real `tourPreferenceSchema` — so
 * what these tests pin is the route's own behaviour rather than a rehearsal
 * of it. Modelled on the reminders route's tests (#468).
 */

const config: AuthConfig = {
  appUrl: new URL("https://orbit.example"),
  sessionSecret: "tour-route-session-secret-that-is-long-enough",
  sessionTtlSeconds: 3600,
  issuer: "https://issuer.tour.example.invalid/",
  clientId: "tour-client",
  clientSecret: "tour-client-secret",
  callbackUrl: "https://orbit.example/api/auth/callback",
  scopes: "openid profile email",
  claims: { email: "email", emailVerified: "email_verified", name: "name", avatar: "picture" },
  secureCookies: true,
};

type WrittenRow = { values: Record<string, unknown>; set: Record<string, unknown> | null };

/** Every query the route makes, answered in order from a queue of row sets. */
const mocks = vi.hoisted(() => ({
  rows: [] as unknown[][],
  inserted: [] as Array<{ values: Record<string, unknown>; set: Record<string, unknown> | null }>,
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

/* The guard has its own contract and integration tests (#523); these
   tests pin the route's own behaviour, so it always passes here. */
vi.mock("@/server/maintenance", () => ({ assertOutsideMaintenance: vi.fn(async () => {}) }));
vi.mock("@/db", () => ({
  getDb: () => ({
    select: () => queryStub(mocks.rows.shift() ?? []),
    insert: () => ({
      values: (values: Record<string, unknown>) => ({
        onConflictDoUpdate: async ({ set }: { set: Record<string, unknown> }) => {
          mocks.inserted.push({ values, set });
        },
      }),
    }),
  }),
}));
vi.mock("@/lib/env", () => ({ getAuthConfig: () => config }));

import { GET, PUT } from "./route";

const SESSION_TOKEN = "tour-route-session-token";
const USER_ID = "44444444-4444-4444-8444-444444444444";
const OTHER_USER_ID = "55555555-5555-4555-8555-555555555555";
const SEEN_AT = "2026-08-01T12:00:00.000Z";

function sessionRow(userId: string, overrides: Record<string, unknown> = {}) {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    activeHouseholdId: null,
    expiresAt: new Date(Date.now() + 3_600_000),
    userId,
    email: "tour@example.invalid",
    emailVerified: true,
    displayName: "Tour Reader",
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

function preferenceRow(overrides: Record<string, unknown> = {}) {
  return { tourSeenAt: null as Date | string | null, ...overrides };
}

type RequestOptions = Omit<RequestInit, "headers" | "signal"> & { headers?: Record<string, string> };

function signedIn(init: RequestOptions = {}): NextRequest {
  const request = new NextRequest("http://127.0.0.1:3000/api/settings/tour", {
    ...init,
    headers: {
      origin: config.appUrl.origin,
      "sec-fetch-site": "same-origin",
      "x-csrf-token": createCsrfToken(SESSION_TOKEN, config.sessionSecret),
      ...init.headers,
    },
  });
  request.cookies.set("__Host-orbit-session", SESSION_TOKEN);
  return request;
}

type TourBody = { tour: { tourSeenAt: string | null } };

async function read(rows: unknown[][]) {
  mocks.rows.splice(0, mocks.rows.length, ...rows);
  const response = await GET(signedIn());
  return { response, body: await response.json() as TourBody };
}

async function write(rows: unknown[][], body: unknown, init: RequestOptions = {}) {
  mocks.rows.splice(0, mocks.rows.length, ...rows);
  const response = await PUT(signedIn({ method: "PUT", body: JSON.stringify(body), ...init }));
  return { response, body: await response.json() as TourBody & { error?: { code: string; message: string } } };
}

afterEach(() => {
  mocks.rows.length = 0;
  mocks.inserted.length = 0;
});

describe("GET /api/settings/tour", () => {
  it("answers null for a user who has never seen the walk", async () => {
    const { response, body } = await read([[sessionRow(USER_ID)], [preferenceRow()]]);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(body.tour).toEqual({ tourSeenAt: null });
  });

  it("answers the stored timestamp, as an ISO string", async () => {
    const { body } = await read([[sessionRow(USER_ID)], [preferenceRow({ tourSeenAt: new Date(SEEN_AT) })]]);
    expect(body.tour).toEqual({ tourSeenAt: SEEN_AT });
  });

  it("answers null for a user who has never chosen at all (no preferences row)", async () => {
    const { body } = await read([[sessionRow(USER_ID)], []]);
    expect(body.tour).toEqual({ tourSeenAt: null });
  });

  it("gives a second session its own record, never the first session's", async () => {
    const first = await read([[sessionRow(USER_ID)], [preferenceRow({ tourSeenAt: new Date(SEEN_AT) })]]);
    const second = await read([[sessionRow(OTHER_USER_ID)], [preferenceRow()]]);
    expect(first.body.tour.tourSeenAt).toBe(SEEN_AT);
    expect(second.body.tour.tourSeenAt).toBeNull();
    expect(JSON.stringify(second.body)).not.toContain(USER_ID);
  });

  it("refuses a request without a session and says nothing else", async () => {
    mocks.rows.length = 0;
    const response = await GET(new NextRequest("http://127.0.0.1:3000/api/settings/tour"));
    expect(response.status).toBe(401);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      error: { code: "session_required", message: "A valid session is required" },
    });
  });
});

describe("PUT /api/settings/tour", () => {
  it("sets the timestamp against the session's own user and answers what is stored", async () => {
    const { response, body } = await write(
      [[sessionRow(USER_ID)], [preferenceRow({ tourSeenAt: new Date(SEEN_AT) })]],
      { tourSeenAt: SEEN_AT },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(mocks.inserted).toHaveLength(1);
    const written = mocks.inserted[0] as WrittenRow;
    expect(written.values.userId).toBe(USER_ID);
    expect(written.values.tourSeenAt).toBeInstanceOf(Date);
    expect((written.values.tourSeenAt as Date).toISOString()).toBe(SEEN_AT);
    expect(body.tour).toEqual({ tourSeenAt: SEEN_AT });
    // Nothing in the write may carry another user's id.
    expect(JSON.stringify(written.values)).not.toContain(OTHER_USER_ID);
  });

  it("clears the timestamp with an explicit null", async () => {
    const { response, body } = await write(
      [[sessionRow(USER_ID)], [preferenceRow({ tourSeenAt: null })]],
      { tourSeenAt: null },
    );
    expect(response.status).toBe(200);
    const written = mocks.inserted[0] as WrittenRow;
    expect(written.values.tourSeenAt).toBeNull();
    expect(written.set).toEqual({ tourSeenAt: null, updatedAt: expect.any(Date) });
    expect(body.tour).toEqual({ tourSeenAt: null });
  });

  it("ignores a user id supplied in the body and writes the session's own", async () => {
    await write(
      [[sessionRow(USER_ID)], [preferenceRow({ tourSeenAt: new Date(SEEN_AT) })]],
      { userId: OTHER_USER_ID, tourSeenAt: SEEN_AT },
    );
    expect((mocks.inserted[0] as WrittenRow).values.userId).toBe(USER_ID);
  });

  it("refuses a non-timestamp value, and stores nothing", async () => {
    for (const invalid of [
      { tourSeenAt: true },
      { tourSeenAt: 12345 },
      { tourSeenAt: "not-a-timestamp" },
      { tourSeenAt: "2026-08-01" },
      { tourSeenAt: {} },
      {},
    ]) {
      const { response, body } = await write([[sessionRow(USER_ID)]], invalid);
      expect(response.status, JSON.stringify(invalid)).toBe(422);
      expect(body.error?.code).toBe("validation_failed");
    }
    expect(mocks.inserted).toEqual([]);
  });

  it("refuses a write without a CSRF token, and stores nothing", async () => {
    mocks.rows.splice(0, mocks.rows.length, [sessionRow(USER_ID)]);
    const request = new NextRequest("http://127.0.0.1:3000/api/settings/tour", {
      method: "PUT",
      body: JSON.stringify({ tourSeenAt: SEEN_AT }),
      headers: { origin: config.appUrl.origin, "sec-fetch-site": "same-origin" },
    });
    request.cookies.set("__Host-orbit-session", SESSION_TOKEN);

    const response = await PUT(request);
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: { code: "csrf_failed", message: "The CSRF token is missing or invalid" },
    });
    expect(mocks.inserted).toEqual([]);
  });

  it("refuses a cross-site write even with a valid session, and stores nothing", async () => {
    mocks.rows.splice(0, mocks.rows.length, [sessionRow(USER_ID)]);
    const request = new NextRequest("http://127.0.0.1:3000/api/settings/tour", {
      method: "PUT",
      body: JSON.stringify({ tourSeenAt: SEEN_AT }),
      headers: {
        origin: "https://elsewhere.example.invalid",
        "sec-fetch-site": "cross-site",
        "x-csrf-token": createCsrfToken(SESSION_TOKEN, config.sessionSecret),
      },
    });
    request.cookies.set("__Host-orbit-session", SESSION_TOKEN);

    const response = await PUT(request);
    expect(response.status).toBe(403);
    expect(mocks.inserted).toEqual([]);
  });

  it("refuses a write without a session, and stores nothing", async () => {
    mocks.rows.length = 0;
    const response = await PUT(new NextRequest("http://127.0.0.1:3000/api/settings/tour", {
      method: "PUT",
      body: JSON.stringify({ tourSeenAt: SEEN_AT }),
      headers: { origin: config.appUrl.origin, "sec-fetch-site": "same-origin" },
    }));
    expect(response.status).toBe(401);
    expect(mocks.inserted).toEqual([]);
  });
});
