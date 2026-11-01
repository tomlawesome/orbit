import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/*
 * #1558 (follow-up to #1520): while this browser is ending its own session,
 * a 401 from an API read is held back rather than sent through the login flow.
 *
 *  - A revoke that itself answers 401 means the session was already over,
 *    which is what the reader asked for: it resolves, and does not bounce.
 *  - A 401 held during a sign-out that then fails is replayed once, so a
 *    session that really expired still reaches the login flow.
 *  - A sign-out that succeeds, or fails with no 401 held, does not bounce.
 *
 * Same shape as the #1520 tests in workspace-json.test.js: a fresh copy of the
 * module per test (the hold is module-level), stubbed fetch and window.
 */
describe("signing out and the held 401 bounce (#1558)", () => {
  /** @type {import("vitest").Mock} */
  let assign;

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
  const session = () => reply(200, { csrfToken: "token" });

  beforeEach(() => {
    vi.resetModules();
    assign = vi.fn();
    vi.stubGlobal("window", { location: { assign, pathname: "/settings" } });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("resolves null, with no bounce, when revoking this device's session answers 401", async () => {
    serve({
      "/api/auth/session": session,
      "/api/auth/sessions/mine/revoke": unauthenticated,
    });
    const { revokeSession } = await import("../../web/src/lib/data/workspace.js");

    await expect(revokeSession("mine", { own: true })).resolves.toBeNull();

    expect(assign).not.toHaveBeenCalled();
  });

  it("resolves null, with no bounce, when 'sign out of every device' answers 401", async () => {
    serve({
      "/api/auth/session": session,
      "/api/auth/sessions/revoke": unauthenticated,
    });
    const { signOutEverywhere } = await import("../../web/src/lib/data/workspace.js");

    await expect(signOutEverywhere()).resolves.toBeNull();

    expect(assign).not.toHaveBeenCalled();
  });

  it("bounces once, and still rejects, when a 401 was held and the sign-out then fails", async () => {
    /** @type {(value: unknown) => void} */
    let release = () => {};
    const held = new Promise((resolve) => { release = resolve; });
    serve({
      "/api/auth/session": session,
      "/api/auth/logout": () => held.then(() => reply(500, null)),
      "/api/auth/sessions": unauthenticated,
    });
    const { signOut, readSessions } = await import("../../web/src/lib/data/workspace.js");

    const leaving = signOut();
    const outcome = leaving.catch((error) => error);
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledWith("/api/auth/logout", expect.anything()));
    await expect(readSessions()).rejects.toMatchObject({ status: 401 });
    expect(assign).not.toHaveBeenCalled();
    release(undefined);

    await expect(leaving).rejects.toMatchObject({ message: "The session could not be ended" });
    await outcome;
    expect(assign).toHaveBeenCalledTimes(1);
    expect(assign).toHaveBeenCalledWith(LOGIN);
  });

  it("does not bounce at all when a 401 was held and the sign-out succeeds", async () => {
    /** @type {(value: unknown) => void} */
    let release = () => {};
    const held = new Promise((resolve) => { release = resolve; });
    serve({
      "/api/auth/session": session,
      "/api/auth/logout": () => held.then(() => reply(200, { redirectTo: null })),
      "/api/auth/sessions": unauthenticated,
    });
    const { signOut, readSessions } = await import("../../web/src/lib/data/workspace.js");

    const leaving = signOut();
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledWith("/api/auth/logout", expect.anything()));
    await expect(readSessions()).rejects.toMatchObject({ status: 401 });
    release(undefined);

    await expect(leaving).resolves.toBeNull();
    expect(assign).not.toHaveBeenCalled();
  });

  it("rejects without a bounce when the sign-out fails and no 401 was held", async () => {
    serve({
      "/api/auth/session": session,
      "/api/auth/logout": () => reply(500, null),
    });
    const { signOut } = await import("../../web/src/lib/data/workspace.js");

    await expect(signOut()).rejects.toMatchObject({ message: "The session could not be ended" });

    expect(assign).not.toHaveBeenCalled();
  });
});
