import { beforeEach, describe, expect, it, vi } from "vitest";

import { themePreferenceSchema } from "../../src/lib/preferences";

/*
 * #1463: two more per-user preferences, wired like skyDriver.
 *  - `planetSize`: "cost" (default) or "importance"; column `planet_size`.
 *  - `importanceOfferDismissed`: boolean, default false; column
 *    `importance_offer_dismissed`. Set by "not now" on the one-time pass.
 * Both travel in the PUT body, the response's `preference`, the session's
 * `user`, and savePreferences' whole body. The database is stood in for.
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
  const base = { id: "x", themeId: "afterdark", textSize: "comfortable", emailNotifications: true, pushNotifications: true, labelDays: 30, skyDriver: "due", planetSize: "cost", importanceOfferDismissed: false };
  const db = {
    transaction: async (/** @type {(tx: any) => Promise<void>} */ run) => run(db),
    insert: () => ({
      values: (/** @type {Record<string, any>} */ values) => ({
        onConflictDoUpdate: async (/** @type {{ set: Record<string, any> }} */ { set }) => {
          writes.push(values);
          stored = { ...base, ...(stored ?? {}), ...set, ...values };
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
  theme: "afterdark", textSize: "comfortable", emailNotifications: true, pushNotifications: true, labelDays: 30, skyDriver: "due", ...extra,
});

beforeEach(() => {
  vi.unstubAllEnvs();
  for (const m of Object.values(mocks)) m.mockReset();
  mocks.getAuthConfig.mockReturnValue(config);
  mocks.requireSession.mockResolvedValue(session);
});


describe("PUT /api/preferences planetSize", () => {
  it.each(["cost", "importance"])("accepts %s and stores it", async (planetSize) => {
    const { writes } = stubDatabase();
    const response = await put(whole({ planetSize }));
    expect(response.status).toBe(200);
    expect(writes[0].planetSize).toBe(planetSize);
    expect((await response.json()).preference.planetSize).toBe(planetSize);
  });

  it("defaults to \"cost\" when the body leaves it out, and stores that", async () => {
    const { writes } = stubDatabase();
    const response = await put(whole({}));
    expect(response.status).toBe(200);
    expect(writes[0].planetSize).toBe("cost");
    expect((await response.json()).preference.planetSize).toBe("cost");
  });

  it.each([["size", "big"], ["an empty string", ""], ["null", null], ["the number 1", 1], ["wrong case", "Cost"]])(
    "rejects %s with a 422 validation_failed and writes nothing", async (_label, planetSize) => {
      const { writes } = stubDatabase();
      const response = await put(whole({ planetSize }));
      expect(response.status).toBe(422);
      const body = await response.json();
      expect(body.error.code).toBe("validation_failed");
      expect(body.error.issues.some((/** @type {any} */ i) => i.path?.includes("planetSize"))).toBe(true);
      expect(writes).toEqual([]);
    });
});

describe("PUT /api/preferences importanceOfferDismissed", () => {
  it.each([true, false])("accepts %s and stores it", async (importanceOfferDismissed) => {
    const { writes } = stubDatabase();
    const response = await put(whole({ importanceOfferDismissed }));
    expect(response.status).toBe(200);
    expect(writes[0].importanceOfferDismissed).toBe(importanceOfferDismissed);
    expect((await response.json()).preference.importanceOfferDismissed).toBe(importanceOfferDismissed);
  });

  it("defaults to false when the body leaves it out", async () => {
    const { writes } = stubDatabase();
    const response = await put(whole({}));
    expect(response.status).toBe(200);
    expect(writes[0].importanceOfferDismissed).toBe(false);
    expect((await response.json()).preference.importanceOfferDismissed).toBe(false);
  });

  it.each([["the string true", "true"], ["the number 1", 1], ["null", null], ["an empty string", ""]])(
    "rejects %s with a 422 validation_failed and writes nothing", async (_label, importanceOfferDismissed) => {
      const { writes } = stubDatabase();
      const response = await put(whole({ importanceOfferDismissed }));
      expect(response.status).toBe(422);
      const body = await response.json();
      expect(body.error.code).toBe("validation_failed");
      expect(body.error.issues.some((/** @type {any} */ i) => i.path?.includes("importanceOfferDismissed"))).toBe(true);
      expect(writes).toEqual([]);
    });
});

describe("the preference schema", () => {
  it("defaults planetSize to cost and importanceOfferDismissed to false", () => {
    const parsed = themePreferenceSchema.parse({ theme: "afterdark" });
    expect(parsed.planetSize).toBe("cost");
    expect(parsed.importanceOfferDismissed).toBe(false);
  });

  it("takes cost and importance for planetSize and nothing else", () => {
    for (const ok of ["cost", "importance"]) expect(themePreferenceSchema.safeParse({ theme: "afterdark", planetSize: ok }).success).toBe(true);
    for (const bad of ["big", "", "Cost", null, 1]) expect(themePreferenceSchema.safeParse({ theme: "afterdark", planetSize: bad }).success, String(bad)).toBe(false);
  });

  it("takes only booleans for importanceOfferDismissed", () => {
    for (const ok of [true, false]) expect(themePreferenceSchema.safeParse({ theme: "afterdark", importanceOfferDismissed: ok }).success).toBe(true);
    for (const bad of ["true", 1, null, ""]) expect(themePreferenceSchema.safeParse({ theme: "afterdark", importanceOfferDismissed: bad }).success, String(bad)).toBe(false);
  });
});

describe("savePreferences carries both", () => {
  /** @type {Array<{ url: string, init: any }>} */
  let calls;
  const sessionAnswer = {
    csrfToken: "csrf-fresh",
    user: { themeId: "dawn", textSize: "standard", emailNotifications: false, pushNotifications: true, labelDays: 120, skyDriver: "warning", planetSize: "importance", importanceOfferDismissed: true },
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
  const bodyOf = () => JSON.parse(puts()[0].init.body);

  it("sends the picked planetSize with the whole body", async () => {
    const { savePreferences } = await import("../../web/src/lib/data/workspace.js");
    await savePreferences({ planetSize: "cost" });
    expect(bodyOf()).toEqual({
      theme: "dawn", textSize: "standard", emailNotifications: false, pushNotifications: true, labelDays: 120, skyDriver: "warning", planetSize: "cost", importanceOfferDismissed: true,
    });
  });

  it("keeps the stored planetSize and dismissal when only the theme is picked", async () => {
    const { savePreferences } = await import("../../web/src/lib/data/workspace.js");
    await savePreferences({ theme: "clouds" });
    expect(bodyOf().planetSize).toBe("importance");
    expect(bodyOf().importanceOfferDismissed).toBe(true);
  });

  it("sends importanceOfferDismissed: true when the offer is dismissed", async () => {
    sessionAnswer.user = { ...sessionAnswer.user, importanceOfferDismissed: false };
    const { savePreferences } = await import("../../web/src/lib/data/workspace.js");
    await savePreferences({ importanceOfferDismissed: true });
    expect(bodyOf().importanceOfferDismissed).toBe(true);
  });

  it("sends the defaults when the session carries none", async () => {
    sessionAnswer.user = { ...sessionAnswer.user, planetSize: undefined, importanceOfferDismissed: undefined };
    const { savePreferences } = await import("../../web/src/lib/data/workspace.js");
    await savePreferences({ theme: "clouds" });
    expect(bodyOf().planetSize).toBe("cost");
    expect(bodyOf().importanceOfferDismissed).toBe(false);
  });
});
