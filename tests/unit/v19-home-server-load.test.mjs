import { describe, expect, it, vi } from "vitest";

import { readHome } from "../../web/src/lib/data/workspace.js";
import { load } from "../../web/src/routes/home/+page.server.js";

/* #842: home used to fill its view only in onMount, so the server rendered no
   manifest and a reader without JavaScript got an empty screen. The read now
   also runs in the page's server `load`, through the fetch SvelteKit hands it
   — the one that resolves relative URLs against the app and carries the
   reader's cookies. What that costs the seam is a fetch parameter, and these
   pin that it is really used: a server load must never fall through to the
   process-wide `globalThis.fetch`, which has no cookies and no origin. */

/* No membership yet (§11): the shortest real HomeView, and enough to see all
   three reads happen. */
const WORKSPACE = { households: [], visibleHouseholds: [], householdLanding: "choose", fixtureToday: "2026-08-13" };
const SESSION = { csrfToken: "csrf-1", user: { id: "u-1", displayName: "Ada Lovelace" } };
const INBOX = { receipts: [], households: [], filed: [] };

const BODIES = {
  "/api/workspace": { workspace: WORKSPACE },
  "/api/auth/session": SESSION,
  "/api/imap-inbox": INBOX,
};

/**
 * A fetch that answers the three URLs home reads and records every call.
 *
 * @param {string[]} calls
 * @param {{ status?: number }} [options]
 */
function recordingFetch(calls, { status = 200 } = {}) {
  return async (/** @type {string} */ url) => {
    calls.push(url);
    const body = BODIES[url] ?? {};
    return new Response(JSON.stringify(status === 200 ? body : { error: { message: "no" } }), {
      status,
      headers: { "content-type": "application/json" },
    });
  };
}

/** Fails the test if anything reaches the global fetch while it is installed. */
function forbidGlobalFetch() {
  const spy = vi.fn(() => {
    throw new Error("the server load fell through to globalThis.fetch");
  });
  const original = globalThis.fetch;
  globalThis.fetch = /** @type {typeof globalThis.fetch} */ (/** @type {unknown} */ (spy));
  return { spy, restore: () => { globalThis.fetch = original; } };
}

describe("readHome(fetch)", () => {
  it("reads the workspace, the session and the inbox through the fetch it is given", async () => {
    const calls = [];
    const guard = forbidGlobalFetch();
    try {
      const view = await readHome(recordingFetch(calls));
      expect(calls.sort()).toEqual(["/api/auth/session", "/api/imap-inbox", "/api/workspace"]);
      expect(guard.spy).not.toHaveBeenCalled();
      expect(view.emptySky).toBe(true);
      expect(view.user?.displayName).toBe("Ada Lovelace");
    } finally {
      guard.restore();
    }
  });

  it("never serves a caller's session from the module cache", async () => {
    /* The cache in readSession lives as long as the page in a browser — and as
       long as the PROCESS on a server, where it would hand the next reader the
       previous reader's session and CSRF token. A caller with its own fetch
       gets its own read, every time. */
    const first = [];
    const second = [];
    await readHome(recordingFetch(first));
    await readHome(recordingFetch(second));
    expect(second).toContain("/api/auth/session");
  });
});

describe("home's server load", () => {
  it("hands the first render a view", async () => {
    const calls = [];
    const data = await load({ fetch: recordingFetch(calls) });
    expect(data.view?.emptySky).toBe(true);
    expect(data.fixtures).toBe(false);
    expect(calls).toContain("/api/workspace");
  });

  it("answers a null view rather than an error page when the read fails", async () => {
    const data = await load({ fetch: recordingFetch([], { status: 503 }) });
    expect(data.view).toBeNull();
  });
});
