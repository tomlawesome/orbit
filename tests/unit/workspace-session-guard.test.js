import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/*
 * #1151 W2-R4: readSettingsScreen (and its siblings — readHome,
 * readInboxScreen, readAdminScreen, readHouseholdScreen) build
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

describe("#1789 W-R1: the duplicate alert's workspace read is bounded", () => {
  beforeEach(() => vi.resetModules());
  afterEach(() => vi.unstubAllGlobals());

  it("readDueReckoning's read of a stalled /api/workspace is aborted after a bounded time, so it cannot hold the lane forever", async () => {
    // AbortSignal.timeout runs on a native timer the fake clock cannot move, so
    // it is replaced by a signal the test fires, and the delay it was asked for is kept.
    const controller = new AbortController();
    const asked = /** @type {number[]} */ ([]);
    vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
      asked.push(ms);
      return controller.signal;
    });
    let seen = /** @type {AbortSignal | undefined} */ (undefined);
    vi.stubGlobal("fetch", vi.fn((url, init) => {
      if (!String(url).includes("/api/workspace")) throw new Error(`unexpected fetch: ${String(url)}`);
      seen = init?.signal;
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      });
    }));
    try {
      const { readDueReckoning } = await import("../../web/src/lib/data/workspace.js");
      let settled = false;
      const outcome = readDueReckoning().then(() => "resolved", () => "rejected").finally(() => { settled = true; });
      await Promise.resolve();
      expect(seen, "the read carries a signal").toBe(controller.signal);
      expect(asked, "the signal is a timeout signal").toHaveLength(1);
      expect(asked[0]).toBeGreaterThan(0);
      expect(asked[0]).toBeLessThanOrEqual(60_000);
      expect(settled, "the stalled read is still waiting before the timeout").toBe(false);
      controller.abort();
      await expect(outcome).resolves.toBe("rejected");
    } finally {
      vi.restoreAllMocks();
    }
  });
});
