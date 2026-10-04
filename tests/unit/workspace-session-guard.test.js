import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/*
 * #1151 W2-R4: readSettingsScreen (and its siblings — readHome,
 * readInboxScreen, readAdminScreen, readHouseholdScreen, readBelt) build
 * their screen from `Promise.all([readWorkspace(), readSession(), ...])`.
 * Every other read in that array was already wrapped in its own
 * `.catch(...)` — additive, so a route that cannot answer costs the reader
 * that one field, never the screen. `readSession()` was the one exception:
 * unguarded beside guarded neighbours, so a session-endpoint hiccup threw
 * the whole Promise.all and blanked a screen whose workspace data had
 * already arrived.
 *
 * `readDueNext` used to be this test's subject, but it was dead code (no
 * route ever called it, /due-next redirects to /home, #1151 W2-Q3) and was
 * removed; `readSettingsScreen` carries the same regression coverage.
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
    if (href.includes("/api/imap-inbox")) {
      return new Response(JSON.stringify({ receipts: [] }), { status: 200 });
    }
    if (href.includes("/api/settings/mail-relay")) {
      return new Response(JSON.stringify({ relay: {} }), { status: 200 });
    }
    if (href.includes("/api/settings/reminders")) {
      return new Response(JSON.stringify({}), { status: 200 });
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

describe("readSettingsScreen", () => {
  it("still resolves, with a null user, when the session read fails", async () => {
    stubFetch({ sessionOk: false });
    const { readSettingsScreen } = await import("../../web/src/lib/data/workspace.js");
    await expect(readSettingsScreen()).resolves.toMatchObject({ user: null });
  });

  it("carries the real user through when the session read succeeds", async () => {
    stubFetch({ sessionOk: true });
    const { readSettingsScreen } = await import("../../web/src/lib/data/workspace.js");
    await expect(readSettingsScreen()).resolves.toMatchObject({ user: { id: "u1" } });
  });
});
