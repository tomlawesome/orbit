import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/*
 * #1355 (two of the five Lows, spec: the 2026-11-01 note; origin the 2026-10-15
 * review note on #1439 #1440 #1442 and #1586 b1 W-R3).
 *
 * 3. A request already in flight when the sign-out starts can answer 401
 *    afterwards. json() must not answer that by sending the reader to
 *    /api/auth/login, which signs them straight back in while the provider
 *    session is live. (#1520/#1558 added the latch; these pin that it holds
 *    on every way a late 401 can arrive.)
 * 4. The latch is kept after a successful sign-out. If the page is then
 *    restored from the back/forward cache (`pageshow`, `persisted: true`) the
 *    document is the same one, the latch still on, so a genuine 401 on the
 *    restored page would never reach the login flow. A restored page clears it.
 *
 * Same shape as sign-out-held-bounce.test.mjs: a fresh copy of the module per
 * test (the latch is module-level), stubbed fetch and window.
 */
describe("sign-out and a late 401 (#1355)", () => {
  /** @type {import("vitest").Mock} */
  let assign;
  /** @type {EventTarget} */
  let win;

  /** @param {number} status @param {unknown} body */
  function reply(status, body) {
    return { ok: status >= 200 && status < 300, status, json: async () => body };
  }
  const unauthenticated = () => reply(401, { error: { message: "Sign in required", code: "unauthenticated" } });
  const LOGIN = "/api/auth/login?returnTo=%2Fsettings";

  /** @param {Record<string, () => unknown>} routes */
  function serve(routes) {
    vi.stubGlobal("fetch", vi.fn(async (url) => {
      const route = routes[url];
      if (!route) throw new Error(`unexpected fetch ${url}`);
      return route();
    }));
  }

  beforeEach(() => {
    vi.resetModules();
    assign = vi.fn();
    win = Object.assign(new EventTarget(), { location: { assign, pathname: "/settings" } });
    vi.stubGlobal("window", win);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("3: a 401 that arrives after the sign-out has finished does not send the reader to the login flow", async () => {
    serve({
      "/api/auth/session": () => reply(200, { csrfToken: "token" }),
      "/api/auth/logout": () => reply(200, { redirectTo: null }),
      "/api/auth/sessions": unauthenticated,
    });
    const { signOut, readSessions } = await import("../../web/src/lib/data/workspace.js");

    await expect(signOut()).resolves.toBeNull();
    await expect(readSessions()).rejects.toMatchObject({ status: 401 });

    expect(assign).not.toHaveBeenCalled();
  });

  it("3: a read already out when the sign-out starts, answering 401 after it began, does not sign the reader back in", async () => {
    /** @type {(value: unknown) => void} */
    let answerRead = () => {};
    const lateRead = new Promise((resolve) => { answerRead = resolve; });
    serve({
      "/api/auth/session": () => reply(200, { csrfToken: "token" }),
      "/api/auth/logout": () => reply(200, { redirectTo: null }),
      "/api/auth/sessions": () => lateRead.then(unauthenticated),
    });
    const { signOut, readSessions } = await import("../../web/src/lib/data/workspace.js");

    const inFlight = readSessions().catch((error) => error);
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledWith("/api/auth/sessions", expect.anything()));
    await expect(signOut()).resolves.toBeNull();
    answerRead(undefined);

    await expect(inFlight).resolves.toMatchObject({ status: 401 });
    expect(assign).not.toHaveBeenCalled();
  });

  it("4: a page restored from the back/forward cache (pageshow, persisted) lifts the sign-out hold, so a real 401 reaches the login flow", async () => {
    serve({
      "/api/auth/session": () => reply(200, { csrfToken: "token" }),
      "/api/auth/logout": () => reply(200, { redirectTo: null }),
      "/api/auth/sessions": unauthenticated,
    });
    const { signOut, readSessions } = await import("../../web/src/lib/data/workspace.js");

    await expect(signOut()).resolves.toBeNull();
    win.dispatchEvent(Object.assign(new Event("pageshow"), { persisted: true }));
    await expect(readSessions()).rejects.toMatchObject({ status: 401 });

    expect(assign).toHaveBeenCalledTimes(1);
    expect(assign).toHaveBeenCalledWith(LOGIN);
  });
});
