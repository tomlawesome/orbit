import { beforeEach, describe, expect, it, vi } from "vitest";

import { themePreferenceSchema } from "../../src/lib/preferences";

/*
 * #1462: `skyDriver`, the per-user choice of what sets a planet's distance
 * from the sun: "due" (the due date, the default) or "warning" (the due date
 * less the warning offset). PUT /api/preferences takes it with the other
 * preference fields, whole as with labelDays; the session carries it back.
 *
 * Fixed for the build: the field is `skyDriver` in the request body, in the
 * response's `preference`, and on the session's `user`; the column is
 * `sky_driver` (`userPreferences.skyDriver` in drizzle). The route is tested
 * with the database stood in for, as preferences-label-days.test.mjs does.
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
          stored = { ...base, ...(stored ?? {}), ...set, ...values, skyDriver: set.skyDriver ?? values.skyDriver ?? stored?.skyDriver ?? "due" };
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
  theme: "afterdark", textSize: "comfortable", emailNotifications: true, pushNotifications: true, labelDays: 30, ...extra,
});

beforeEach(() => {
  vi.unstubAllEnvs();
  for (const m of Object.values(mocks)) m.mockReset();
  mocks.getAuthConfig.mockReturnValue(config);
  mocks.requireSession.mockResolvedValue(session);
});

describe("PUT /api/preferences skyDriver", () => {
  it.each(["due", "warning"])("accepts %s and stores it", async (skyDriver) => {
    const { writes } = stubDatabase();
    const response = await put(whole({ skyDriver }));
    expect(response.status).toBe(200);
    expect(writes).toHaveLength(1);
    expect(writes[0].skyDriver).toBe(skyDriver);
  });

  it("reads a stored value back in the answer", async () => {
    stubDatabase();
    const response = await put(whole({ skyDriver: "warning" }));
    expect((await response.json()).preference.skyDriver).toBe("warning");
  });

  it("defaults to \"due\" when the body leaves it out, and stores that", async () => {
    const { writes } = stubDatabase();
    const response = await put(whole({}));
    expect(response.status).toBe(200);
    expect(writes[0].skyDriver).toBe("due");
    expect((await response.json()).preference.skyDriver).toBe("due");
  });

  it.each([
    ["soon", "soon"],
    ["an empty string", ""],
    ["null", null],
    ["the number 1", 1],
  ])("rejects %s with a 422 validation_failed and writes nothing", async (_label, skyDriver) => {
    const { writes } = stubDatabase();
    const response = await put(whole({ skyDriver }));
    expect(response.status).toBe(422);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = await response.json();
    expect(body.error.code).toBe("validation_failed");
    expect(body.error.issues.some((/** @type {any} */ i) => i.path?.includes("skyDriver"))).toBe(true);
    expect(writes).toEqual([]);
  });

  it("still answers theme, text size, both channel flags and the label days beside it", async () => {
    stubDatabase();
    const response = await put(whole({ theme: "dawn", textSize: "large", emailNotifications: false, labelDays: 7, skyDriver: "warning" }));
    expect((await response.json()).preference).toEqual({
      theme: "dawn", textSize: "large", emailNotifications: false, pushNotifications: true, labelDays: 7, skyDriver: "warning",
    });
  });
});

describe("the preference schema", () => {
  it("defaults skyDriver to \"due\" when the body leaves it out", () => {
    expect(themePreferenceSchema.parse({ theme: "afterdark" }).skyDriver).toBe("due");
  });

  it("takes \"due\" and \"warning\" and nothing else", () => {
    expect(themePreferenceSchema.safeParse({ theme: "afterdark", skyDriver: "due" }).success).toBe(true);
    expect(themePreferenceSchema.safeParse({ theme: "afterdark", skyDriver: "warning" }).success).toBe(true);
    for (const bad of ["soon", "", "Due", null, 1]) {
      expect(themePreferenceSchema.safeParse({ theme: "afterdark", skyDriver: bad }).success, String(bad)).toBe(false);
    }
  });
});

describe("savePreferences carries skyDriver", () => {
  /** @type {Array<{ url: string, init: any }>} */
  let calls;
  const sessionAnswer = {
    csrfToken: "csrf-fresh",
    user: { themeId: "dawn", textSize: "standard", emailNotifications: false, pushNotifications: true, labelDays: 120, skyDriver: "warning" },
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

  it("sends the picked skyDriver with the rest of the body", async () => {
    const { savePreferences } = await import("../../web/src/lib/data/workspace.js");
    await savePreferences({ skyDriver: "due" });
    expect(JSON.parse(puts()[0].init.body)).toEqual({
      theme: "dawn", textSize: "standard", emailNotifications: false, pushNotifications: true, labelDays: 120, skyDriver: "due",
    });
  });

  it("keeps the session's stored skyDriver when only the theme is picked", async () => {
    const { savePreferences } = await import("../../web/src/lib/data/workspace.js");
    await savePreferences({ theme: "clouds" });
    expect(JSON.parse(puts()[0].init.body).skyDriver).toBe("warning");
  });

  it("sends \"due\" when the session carries none (a user with no row)", async () => {
    sessionAnswer.user = { ...sessionAnswer.user, skyDriver: undefined };
    const { savePreferences } = await import("../../web/src/lib/data/workspace.js");
    await savePreferences({ theme: "clouds" });
    expect(JSON.parse(puts()[0].init.body).skyDriver).toBe("due");
  });
});
