import { beforeEach, describe, expect, it, vi } from "vitest";

import { themePreferenceSchema } from "../../src/lib/preferences";

/*
 * #1461: `labelDays`, the per-user number of days within which a planet shows
 * its name. An integer 0..365, default 30. PUT /api/preferences takes it with
 * the other preference fields; the session carries it back (the front end
 * loads it through readSession, as it does theme and text size).
 *
 * Fixed for the build: the field is `labelDays` in the request body, in the
 * response's `preference`, and on the session's `user`; the column is
 * `label_days` (`userPreferences.labelDays` in drizzle). The route is tested
 * with the database stood in for, as the other route tests stand their engine in.
 */
const mocks = vi.hoisted(() => ({
  getAuthConfig: vi.fn(),
  requireSession: vi.fn(),
  assertOutsideMaintenance: vi.fn(),
  assertKeyUsable: vi.fn(),
  getDb: vi.fn(),
}));

vi.mock("orbit/lib/env", () => ({ getAuthConfig: mocks.getAuthConfig }));
vi.mock("orbit/lib/auth/session", async (importOriginal) => ({ ...(await importOriginal()), requireSession: mocks.requireSession }));
vi.mock("orbit/server/maintenance", () => ({ assertOutsideMaintenance: mocks.assertOutsideMaintenance }));
vi.mock("orbit/server/key-state", () => ({ assertKeyUsable: mocks.assertKeyUsable, noteRefusedSignIn: vi.fn() }));
vi.mock("orbit/db", () => ({ getDb: mocks.getDb }));

const { PUT } = await import("../../web/src/routes/api/preferences/+server.js");
const { csrfTokenForSession } = await import("orbit/lib/auth/session");

const config = { appUrl: new URL("https://orbit.example"), sessionSecret: "s".repeat(48) };
const session = { id: "s-1", token: "tok-1", user: { id: "user-1" } };

/** A stand-in database that keeps the row the route writes and reads it back. */
function stubDatabase() {
  /** @type {Record<string, any> | null} */
  let stored = null;
  /** @type {Array<Record<string, any>>} */
  const writes = [];
  const base = { id: "x", themeId: "afterdark", textSize: "comfortable", emailNotifications: true, pushNotifications: true, labelDays: 30, skyDriver: "due" };
  const db = {
    transaction: async (/** @type {(tx: any) => Promise<void>} */ run) => run(db),
    insert: () => ({
      values: (/** @type {Record<string, any>} */ values) => ({
        onConflictDoUpdate: async (/** @type {{ set: Record<string, any> }} */ { set }) => {
          writes.push(values);
          stored = { ...base, ...(stored ?? {}), ...set, ...values, labelDays: set.labelDays ?? values.labelDays ?? stored?.labelDays ?? 30 };
        },
      }),
    }),
    update: () => ({ set: () => ({ where: async () => undefined }) }),
    select: () => ({ from: () => ({ where: () => ({ limit: async () => [stored ?? base] }) }) }),
  };
  mocks.getDb.mockReturnValue(db);
  return { writes };
}

function put(/** @type {unknown} */ body) {
  return PUT({
    cookies: {},
    route: { id: "/api/preferences" },
    request: new Request("https://orbit.example/api/preferences", {
      method: "PUT",
      headers: {
        origin: "https://orbit.example",
        "content-type": "application/json",
        "x-csrf-token": csrfTokenForSession(session, config),
      },
      body: JSON.stringify(body),
    }),
  });
}
const whole = (/** @type {Record<string, unknown>} */ extra) => ({
  theme: "afterdark", textSize: "comfortable", emailNotifications: true, pushNotifications: true, ...extra,
});

beforeEach(() => {
  vi.unstubAllEnvs();
  for (const m of Object.values(mocks)) m.mockReset();
  mocks.getAuthConfig.mockReturnValue(config);
  mocks.requireSession.mockResolvedValue(session);
});

describe("PUT /api/preferences labelDays", () => {
  it.each([0, 30, 365])("accepts %i and stores it", async (labelDays) => {
    const { writes } = stubDatabase();
    const response = await put(whole({ labelDays }));
    expect(response.status).toBe(200);
    expect(writes).toHaveLength(1);
    expect(writes[0].labelDays).toBe(labelDays);
  });

  it("reads a stored value back in the answer", async () => {
    stubDatabase();
    const response = await put(whole({ labelDays: 90 }));
    expect((await response.json()).preference.labelDays).toBe(90);
  });

  it.each([
    ["-1", -1],
    ["366", 366],
    ["30.5", 30.5],
    ['"30"', "30"],
    ["null", null],
  ])("rejects %s with a 422 validation_failed and writes nothing", async (_label, labelDays) => {
    const { writes } = stubDatabase();
    const response = await put(whole({ labelDays }));
    expect(response.status).toBe(422);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = await response.json();
    expect(body.error.code).toBe("validation_failed");
    expect(body.error.issues.some((/** @type {any} */ i) => i.path?.includes("labelDays"))).toBe(true);
    expect(writes).toEqual([]);
  });

  it("leaves the other fields behaving as before: a bad theme is still refused", async () => {
    const { writes } = stubDatabase();
    const response = await put(whole({ theme: "not-a-pack", labelDays: 30 }));
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(response.status).toBeLessThan(500);
    expect(writes).toEqual([]);
  });

  it("still answers theme, text size and both channel flags", async () => {
    stubDatabase();
    const response = await put(whole({ theme: "dawn", textSize: "large", emailNotifications: false, labelDays: 7 }));
    expect((await response.json()).preference).toEqual({
      theme: "dawn", textSize: "large", emailNotifications: false, pushNotifications: true, labelDays: 7, skyDriver: "due",
    });
  });
});

describe("the preference schema", () => {
  it("defaults labelDays to 30 when the body leaves it out", () => {
    expect(themePreferenceSchema.parse({ theme: "afterdark" }).labelDays).toBe(30);
  });

  it("takes 0 and 365 at the ends and refuses a step past either", () => {
    expect(themePreferenceSchema.safeParse({ theme: "afterdark", labelDays: 0 }).success).toBe(true);
    expect(themePreferenceSchema.safeParse({ theme: "afterdark", labelDays: 365 }).success).toBe(true);
    expect(themePreferenceSchema.safeParse({ theme: "afterdark", labelDays: -1 }).success).toBe(false);
    expect(themePreferenceSchema.safeParse({ theme: "afterdark", labelDays: 366 }).success).toBe(false);
  });
});

describe("savePreferences carries labelDays", () => {
  /** @type {Array<{ url: string, init: any }>} */
  let calls;
  const sessionAnswer = {
    csrfToken: "csrf-fresh",
    user: { themeId: "dawn", textSize: "standard", emailNotifications: false, pushNotifications: true, labelDays: 120 },
  };

  beforeEach(() => {
    vi.resetModules();
    calls = [];
    vi.stubGlobal("fetch", vi.fn(async (/** @type {string} */ url, init = {}) => {
      calls.push({ url: String(url), init });
      if (String(url) === "/api/auth/session") return new Response(JSON.stringify(sessionAnswer), { status: 200 });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }));
  });

  const puts = () => calls.filter((c) => c.url === "/api/preferences");

  it("sends the picked labelDays with the rest of the body", async () => {
    const { savePreferences } = await import("../../web/src/lib/data/workspace.js");
    await savePreferences({ labelDays: 365 });
    expect(JSON.parse(puts()[0].init.body)).toEqual({
      theme: "dawn", textSize: "standard", emailNotifications: false, pushNotifications: true, labelDays: 365, skyDriver: "due",
    });
  });

  it("sends 0 as 0, not as the default", async () => {
    const { savePreferences } = await import("../../web/src/lib/data/workspace.js");
    await savePreferences({ labelDays: 0 });
    expect(JSON.parse(puts()[0].init.body).labelDays).toBe(0);
  });

  it("keeps the session's stored labelDays when only the theme is picked", async () => {
    const { savePreferences } = await import("../../web/src/lib/data/workspace.js");
    await savePreferences({ theme: "clouds" });
    expect(JSON.parse(puts()[0].init.body).labelDays).toBe(120);
  });

  it("sends 30 when the session carries none (a user with no row)", async () => {
    sessionAnswer.user = { ...sessionAnswer.user, labelDays: undefined };
    const { savePreferences } = await import("../../web/src/lib/data/workspace.js");
    await savePreferences({ theme: "clouds" });
    expect(JSON.parse(puts()[0].init.body).labelDays).toBe(30);
  });
});
