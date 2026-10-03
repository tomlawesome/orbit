import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/*
 * #1151 W2-R4: readDueNext (and six siblings — readHome, readInboxScreen,
 * readSettingsScreen, readAdminScreen, readHouseholdScreen, readBelt) build
 * their screen from `Promise.all([readWorkspace(), readSession(), ...])`.
 * Every other read in that array was already wrapped in its own
 * `.catch(...)` — additive, so a route that cannot answer costs the reader
 * that one field, never the screen. `readSession()` was the one exception:
 * unguarded beside guarded neighbours, so a session-endpoint hiccup threw
 * the whole Promise.all and blanked a screen whose workspace data had
 * already arrived.
 *
 * `fetch` is stubbed globally (workspace.js takes it from `globalThis.fetch`
 * directly rather than through an injected `deps` object, unlike
 * push/alerts.js), and the module is re-imported fresh per test — it caches
 * the session response in a module-level `sessionPromise`, which would
 * otherwise leak between tests.
 */

const WORKSPACE_BODY = {
  workspace: { households: [], activeHouseholdId: null, fixtureToday: "2026-10-03" },
};

/** @param {{ sessionOk: boolean }} opts */
function stubFetch({ sessionOk }) {
  vi.stubGlobal("fetch", vi.fn(async (url) => {
    const href = String(url);
    if (href.includes("/api/auth/session")) {
      return sessionOk
        ? new Response(JSON.stringify({ user: { id: "u1" }, csrfToken: "t" }), { status: 200 })
        : new Response("", { status: 503 });
    }
    if (href.includes("/api/workspace")) {
      return new Response(JSON.stringify(WORKSPACE_BODY), { status: 200 });
    }
    throw new Error(`unexpected fetch: ${href}`);
  }));
}

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("readDueNext", () => {
  it("still resolves, with a null user, when the session read fails", async () => {
    stubFetch({ sessionOk: false });
    const { readDueNext } = await import("../../web/src/lib/data/workspace.js");
    await expect(readDueNext()).resolves.toMatchObject({ user: null });
  });

  it("carries the real user through when the session read succeeds", async () => {
    stubFetch({ sessionOk: true });
    const { readDueNext } = await import("../../web/src/lib/data/workspace.js");
    await expect(readDueNext()).resolves.toMatchObject({ user: { id: "u1" } });
  });
});
