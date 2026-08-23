import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthConfig } from "@/lib/env";
import { createCsrfToken } from "@/lib/auth/crypto";

/**
 * The reminder-timing endpoint's contract (#468). Only the database and the
 * auth config are stubbed: the session is read through the real
 * `readSession`, the body through the real `reminderPreferenceSchema`, and
 * the outbound-mail word through the real notification-worker environment
 * parser — so what these tests pin is the route's own behaviour rather than a
 * rehearsal of it. Modelled on the relay route's tests (#432).
 */

const config: AuthConfig = {
  appUrl: new URL("https://orbit.example"),
  sessionSecret: "reminders-route-session-secret-that-is-long-enough",
  sessionTtlSeconds: 3600,
  issuer: "https://issuer.reminders.example.invalid/",
  clientId: "reminders-client",
  clientSecret: "reminders-client-secret",
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
  cancelled: [] as Array<Record<string, unknown>>,
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

function writeStub() {
  return {
    insert: () => ({
      values: (values: Record<string, unknown>) => ({
        onConflictDoUpdate: async ({ set }: { set: Record<string, unknown> }) => {
          mocks.inserted.push({ values, set });
        },
      }),
    }),
    update: () => ({
      set: (values: Record<string, unknown>) => ({
        where: async () => { mocks.cancelled.push(values); },
      }),
    }),
  };
}

/* The guard has its own contract and integration tests (#523); these
   tests pin the route's own behaviour, so it always passes here. */
vi.mock("@/server/maintenance", () => ({ assertOutsideMaintenance: vi.fn(async () => {}) }));
vi.mock("@/db", () => ({
  getDb: () => ({
    select: () => queryStub(mocks.rows.shift() ?? []),
    delete: () => ({ where: async () => undefined }),
    transaction: async (run: (transaction: ReturnType<typeof writeStub>) => Promise<void>) => run(writeStub()),
  }),
}));
vi.mock("@/lib/env", () => ({ getAuthConfig: () => config }));

import { GET, PUT } from "./route";

const SESSION_TOKEN = "reminders-route-session-token";
const USER_ID = "22222222-2222-4222-8222-222222222222";
const OTHER_USER_ID = "33333333-3333-4333-8333-333333333333";
const SMTP_HOST = "smtp.reminders.example.invalid";
const SMTP_USER = "reminders-mailbox-user";
const SMTP_PASSWORD = "reminders-mailbox-password";

function sessionRow(userId: string, overrides: Record<string, unknown> = {}) {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    activeHouseholdId: null,
    expiresAt: new Date(Date.now() + 3_600_000),
    userId,
    email: "reminders@example.invalid",
    emailVerified: true,
    displayName: "Reminder Reader",
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
  return { emailNotifications: true, firstWarningDays: 14, finalWarningDays: 3, ...overrides };
}

type RequestOptions = Omit<RequestInit, "headers" | "signal"> & { headers?: Record<string, string> };

function signedIn(init: RequestOptions = {}): NextRequest {
  const request = new NextRequest("http://127.0.0.1:3000/api/settings/reminders", {
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

type RemindersBody = {
  reminders: {
    emailEnabled: boolean;
    firstWarningDays: number;
    finalWarningDays: number;
    firstWarning: string;
    finalWarning: string;
    outboundMail: string;
  };
};

async function read(rows: unknown[][]) {
  mocks.rows.splice(0, mocks.rows.length, ...rows);
  const response = await GET(signedIn());
  return { response, body: await response.json() as RemindersBody };
}

async function write(rows: unknown[][], body: unknown, init: RequestOptions = {}) {
  mocks.rows.splice(0, mocks.rows.length, ...rows);
  const response = await PUT(signedIn({ method: "PUT", body: JSON.stringify(body), ...init }));
  return { response, body: await response.json() as RemindersBody & { error?: { code: string; message: string } } };
}

beforeEach(() => {
  vi.stubEnv("SMTP_HOST", SMTP_HOST);
  vi.stubEnv("SMTP_USER", SMTP_USER);
  vi.stubEnv("SMTP_PASSWORD", SMTP_PASSWORD);
});

afterEach(() => {
  vi.unstubAllEnvs();
  mocks.rows.length = 0;
  mocks.inserted.length = 0;
  mocks.cancelled.length = 0;
});

describe("GET /api/settings/reminders", () => {
  it("answers the session's own timing in the screen's words, no-store", async () => {
    const { response, body } = await read([[sessionRow(USER_ID)], [preferenceRow()]]);

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(body.reminders).toEqual({
      emailEnabled: true,
      firstWarningDays: 14,
      finalWarningDays: 3,
      firstWarning: "14 days before closest approach",
      finalWarning: "3 days before",
      outboundMail: "configured",
    });
  });

  it("answers the column defaults for a user who has never chosen", async () => {
    const { body } = await read([[sessionRow(USER_ID)], []]);
    expect(body.reminders).toMatchObject({ emailEnabled: true, firstWarningDays: 14, finalWarningDays: 3 });
  });

  it("says a day, not days, and calls a zero-day final warning the day itself", async () => {
    const { body } = await read([
      [sessionRow(USER_ID)],
      [preferenceRow({ firstWarningDays: 1, finalWarningDays: 0 })],
    ]);
    expect(body.reminders.firstWarning).toBe("1 day before closest approach");
    expect(body.reminders.finalWarning).toBe("on the day");
  });

  it("reports outbound mail as a bounded word and never the operator's mailbox", async () => {
    const { body } = await read([[sessionRow(USER_ID)], [preferenceRow()]]);
    const raw = JSON.stringify(body);
    expect(body.reminders.outboundMail).toBe("configured");
    expect(raw).not.toContain(SMTP_HOST);
    expect(raw).not.toContain(SMTP_USER);
    expect(raw).not.toContain(SMTP_PASSWORD);
  });

  it("degrades an unresolvable outbound configuration to 'not configured', not a 500", async () => {
    // Half-set SMTP throws out of the environment parser; its message names
    // environment variables, which is the operator's surface, not this one's.
    vi.stubEnv("SMTP_USER", "");
    const { response, body } = await read([[sessionRow(USER_ID)], [preferenceRow()]]);
    expect(response.status).toBe(200);
    expect(body.reminders.outboundMail).toBe("not configured");
    expect(JSON.stringify(body)).not.toContain("SMTP_");
  });

  it("gives a second session its own timing, never the first session's", async () => {
    const first = await read([[sessionRow(USER_ID)], [preferenceRow()]]);
    const second = await read([
      [sessionRow(OTHER_USER_ID)],
      [preferenceRow({ emailEnabled: false, firstWarningDays: 30, finalWarningDays: 7 })],
    ]);
    expect(first.body.reminders.firstWarningDays).toBe(14);
    expect(second.body.reminders.firstWarningDays).toBe(30);
    // The request carries no user id at all, so there is nothing to substitute.
    expect(JSON.stringify(second.body)).not.toContain(USER_ID);
  });

  it("refuses a request without a session and says nothing else", async () => {
    mocks.rows.length = 0;
    const response = await GET(new NextRequest("http://127.0.0.1:3000/api/settings/reminders"));
    expect(response.status).toBe(401);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      error: { code: "session_required", message: "A valid session is required" },
    });
  });
});

describe("PUT /api/settings/reminders", () => {
  it("stores the pair against the session's own user and answers what is stored", async () => {
    const { response, body } = await write(
      [[sessionRow(USER_ID)], [preferenceRow({ emailNotifications: true, firstWarningDays: 30, finalWarningDays: 7 })]],
      { emailEnabled: true, firstWarningDays: 30, finalWarningDays: 7 },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(mocks.inserted).toHaveLength(1);
    const written = mocks.inserted[0] as WrittenRow;
    expect(written.values).toMatchObject({
      userId: USER_ID,
      emailNotifications: true,
      firstWarningDays: 30,
      finalWarningDays: 7,
    });
    expect(written.set).toMatchObject({ firstWarningDays: 30, finalWarningDays: 7 });
    expect(body.reminders).toMatchObject({
      firstWarningDays: 30,
      finalWarning: "7 days before",
    });
    // Nothing in the body may carry another user's id, and the write may not
    // take one from the request either.
    expect(JSON.stringify(written.values)).not.toContain(OTHER_USER_ID);
  });

  it("ignores a user id supplied in the body and writes the session's own", async () => {
    await write(
      [[sessionRow(USER_ID)], [preferenceRow()]],
      { userId: OTHER_USER_ID, emailEnabled: true, firstWarningDays: 14, finalWarningDays: 3 },
    );
    expect((mocks.inserted[0] as WrittenRow).values.userId).toBe(USER_ID);
  });

  it("cancels the caller's queued email when reminders are switched off", async () => {
    await write(
      [[sessionRow(USER_ID)], [preferenceRow({ emailNotifications: false })]],
      { emailEnabled: false, firstWarningDays: 14, finalWarningDays: 3 },
    );
    expect(mocks.cancelled).toEqual([expect.objectContaining({
      status: "cancelled",
      lastError: "Disabled in recipient preferences",
    })]);
  });

  it("leaves queued email alone when reminders stay on", async () => {
    await write(
      [[sessionRow(USER_ID)], [preferenceRow()]],
      { emailEnabled: true, firstWarningDays: 14, finalWarningDays: 3 },
    );
    expect(mocks.cancelled).toEqual([]);
  });

  it("refuses a final warning that would arrive before the first, and stores nothing", async () => {
    const { response, body } = await write(
      [[sessionRow(USER_ID)]],
      { emailEnabled: true, firstWarningDays: 3, finalWarningDays: 14 },
    );
    expect(response.status).toBe(422);
    expect(body.error?.code).toBe("validation_failed");
    expect(mocks.inserted).toEqual([]);
  });

  it("refuses offsets outside the supported window, and stores nothing", async () => {
    for (const invalid of [
      { emailEnabled: true, firstWarningDays: 0, finalWarningDays: 0 },
      { emailEnabled: true, firstWarningDays: 400, finalWarningDays: 3 },
      { emailEnabled: true, firstWarningDays: 14, finalWarningDays: -1 },
      { emailEnabled: true, firstWarningDays: 14.5, finalWarningDays: 3 },
      { emailEnabled: "yes", firstWarningDays: 14, finalWarningDays: 3 },
      { firstWarningDays: 14, finalWarningDays: 3 },
    ]) {
      const { response } = await write([[sessionRow(USER_ID)]], invalid);
      expect(response.status, JSON.stringify(invalid)).toBe(422);
    }
    expect(mocks.inserted).toEqual([]);
  });

  it("refuses a write without a CSRF token, and stores nothing", async () => {
    mocks.rows.splice(0, mocks.rows.length, [sessionRow(USER_ID)]);
    const request = new NextRequest("http://127.0.0.1:3000/api/settings/reminders", {
      method: "PUT",
      body: JSON.stringify({ emailEnabled: false, firstWarningDays: 14, finalWarningDays: 3 }),
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
    const request = new NextRequest("http://127.0.0.1:3000/api/settings/reminders", {
      method: "PUT",
      body: JSON.stringify({ emailEnabled: false, firstWarningDays: 14, finalWarningDays: 3 }),
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
    const response = await PUT(new NextRequest("http://127.0.0.1:3000/api/settings/reminders", {
      method: "PUT",
      body: JSON.stringify({ emailEnabled: true, firstWarningDays: 14, finalWarningDays: 3 }),
      headers: { origin: config.appUrl.origin, "sec-fetch-site": "same-origin" },
    }));
    expect(response.status).toBe(401);
    expect(mocks.inserted).toEqual([]);
  });
});
