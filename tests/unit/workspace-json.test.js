import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { WorkspaceError, json } from "../../web/src/lib/data/workspace.js";

/*
 * #1151 W2-R3: `json()` is the one place every caller in workspace.js decodes
 * a fetch response. A non-2xx with an unparseable body already fell back to
 * a generic "could not be reached" WorkspaceError — but a 2xx with an
 * unparseable body (a proxy restart, a cached offline page a service worker
 * answered with status 200, anything that isn't the real route) used to
 * return `null` straight through, and every caller dereferences that
 * immediately, so the reader saw their own bare TypeError instead of a
 * message naming the real problem.
 *
 * Fakes rather than a real Response: only `ok`, `status` and `json()` are
 * ever read.
 */

/** @param {{ ok: boolean, status: number, body: unknown, parseFails?: boolean }} shape */
function fakeResponse({ ok, status, body, parseFails = false }) {
  return {
    ok,
    status,
    json: async () => {
      if (parseFails) throw new SyntaxError("Unexpected end of JSON input");
      return body;
    },
  };
}

describe("json() on a 2xx response", () => {
  it("returns the decoded body when it parses", async () => {
    const response = fakeResponse({ ok: true, status: 200, body: { hello: "world" } });
    await expect(json(response)).resolves.toEqual({ hello: "world" });
  });

  it("raises the same 'could not be reached' error a non-2xx with no body raises, rather than returning null", async () => {
    const response = fakeResponse({ ok: true, status: 200, parseFails: true });
    await expect(json(response)).rejects.toBeInstanceOf(WorkspaceError);
    await expect(json(response)).rejects.toMatchObject({
      message: "Orbit could not be reached (200)",
      status: 200,
    });
  });
});

describe("json() on a non-2xx response", () => {
  it("throws a WorkspaceError carrying the server's own message and code", async () => {
    const response = fakeResponse({
      ok: false,
      status: 422,
      body: { error: { message: "That name is taken", code: "name_taken" } },
    });
    await expect(json(response)).rejects.toMatchObject({
      message: "That name is taken",
      status: 422,
      code: "name_taken",
    });
  });

  it("falls back to a generic message when the body cannot be read at all", async () => {
    const response = fakeResponse({ ok: false, status: 502, parseFails: true });
    await expect(json(response)).rejects.toMatchObject({
      message: "Orbit could not be reached (502)",
      status: 502,
    });
  });
  it("says a bare 413 was a size refusal, not that Orbit could not be reached (#1284)", async () => {
    const response = fakeResponse({ ok: false, status: 413, parseFails: true });
    await expect(json(response)).rejects.toMatchObject({
      message: "That file is larger than this Orbit accepts",
      status: 413,
      code: "document_too_large",
    });
  });
});

/*
 * #1316 P-S11 / P-S12: `signOut()` must work when the session is dead (401
 * on the session read) or the cached CSRF token is stale (it must re-read
 * the session rather than reuse the cached promise).
 *
 * workspace.js keeps the session promise at module level, so each test
 * imports a fresh copy of the module.
 */
describe("signOut() against a dead or stale session (#1316)", () => {
  /** @type {import("vitest").Mock} */
  let assign;

  /** @param {number} status @param {unknown} body */
  function reply(status, body) {
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    };
  }

  beforeEach(() => {
    vi.resetModules();
    assign = vi.fn();
    vi.stubGlobal("window", { location: { assign, pathname: "/household/settings" } });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("signs out without the login redirect or a CSRF header when the session read answers 401", async () => {
    const calls = [];
    vi.stubGlobal("fetch", vi.fn(async (url, init) => {
      calls.push({ url, init });
      if (url === "/api/auth/session") {
        return reply(401, { error: { message: "Sign in required", code: "unauthenticated" } });
      }
      return reply(200, { redirectTo: null });
    }));
    const { signOut } = await import("../../web/src/lib/data/workspace.js");

    await expect(signOut()).resolves.toBeNull();

    expect(assign).not.toHaveBeenCalled();
    const logout = calls.find((c) => c.url === "/api/auth/logout");
    expect(logout).toBeDefined();
    expect(logout?.init?.method).toBe("POST");
    expect(logout?.init?.headers?.["x-csrf-token"]).toBeUndefined();
  });

  it("sends the freshly read CSRF token, not the cached one", async () => {
    let token = "A";
    const calls = [];
    vi.stubGlobal("fetch", vi.fn(async (url, init) => {
      calls.push({ url, init });
      if (url === "/api/auth/session") return reply(200, { csrfToken: token });
      return reply(200, { redirectTo: null });
    }));
    const { readSession, signOut } = await import("../../web/src/lib/data/workspace.js");

    await expect(readSession()).resolves.toMatchObject({ csrfToken: "A" });
    token = "B";
    await signOut();

    const logout = calls.find((c) => c.url === "/api/auth/logout");
    expect(logout?.init?.headers?.["x-csrf-token"]).toBe("B");
  });

  it("still signs out with the cached CSRF token when the session read answers 503", async () => {
    let sessionDown = false;
    const calls = [];
    vi.stubGlobal("fetch", vi.fn(async (url, init) => {
      calls.push({ url, init });
      if (url === "/api/auth/session") {
        return sessionDown
          ? reply(503, { error: { message: "Unavailable", code: "unavailable" } })
          : reply(200, { csrfToken: "A" });
      }
      return reply(200, { redirectTo: null });
    }));
    const { readSession, signOut } = await import("../../web/src/lib/data/workspace.js");

    await expect(readSession()).resolves.toMatchObject({ csrfToken: "A" });
    sessionDown = true;

    await expect(signOut()).resolves.toBeNull();
    const logout = calls.find((c) => c.url === "/api/auth/logout");
    expect(logout?.init?.method).toBe("POST");
    expect(logout?.init?.headers?.["x-csrf-token"]).toBe("A");
    expect(assign).not.toHaveBeenCalled();
  });

  it("still sends the sign-out, without a CSRF header, when the session read cannot be made and nothing is cached", async () => {
    const calls = [];
    vi.stubGlobal("fetch", vi.fn(async (url, init) => {
      calls.push({ url, init });
      if (url === "/api/auth/session") throw new TypeError("Failed to fetch");
      return reply(200, { redirectTo: null });
    }));
    const { signOut } = await import("../../web/src/lib/data/workspace.js");

    await expect(signOut()).resolves.toBeNull();
    const logout = calls.find((c) => c.url === "/api/auth/logout");
    expect(logout?.init?.method).toBe("POST");
    expect(logout?.init?.headers?.["x-csrf-token"]).toBeUndefined();
  });

  it.each([
    ["the session read answers 401", 401],
    ["the session read answers 200", 200],
  ])("clears the cached session once signed out, when %s", async (_label, status) => {
    let signedOut = false;
    const calls = [];
    vi.stubGlobal("fetch", vi.fn(async (url, init) => {
      calls.push({ url, init });
      if (url === "/api/auth/session") {
        if (signedOut && status === 401) {
          return reply(401, { error: { message: "Sign in required", code: "unauthenticated" } });
        }
        return reply(200, { csrfToken: "A" });
      }
      return reply(200, { redirectTo: null });
    }));
    const { readSession, signOut } = await import("../../web/src/lib/data/workspace.js");

    await readSession();
    signedOut = true;
    await signOut();
    const before = calls.filter((c) => c.url === "/api/auth/session").length;

    await readSession().catch(() => null);
    expect(calls.filter((c) => c.url === "/api/auth/session")).toHaveLength(before + 1);
  });

  it("still rejects with a 403 WorkspaceError when the logout POST is refused", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url) => {
      if (url === "/api/auth/session") return reply(200, { csrfToken: "A" });
      return reply(403, { error: { message: "CSRF failed", code: "csrf_failed" } });
    }));
    const { signOut, WorkspaceError: FreshError } = await import("../../web/src/lib/data/workspace.js");

    const failure = await signOut().catch((error) => error);
    expect(failure).toBeInstanceOf(FreshError);
    expect(failure.status).toBe(403);
  });
});

/*
 * #1316: a household an import has closed answers every read with a 409
 * `household_import_in_progress`. A browser screen already standing in that
 * household reloads, so it draws the closed-household notice a fresh load
 * draws; the WorkspaceError is still thrown so pending callers settle while
 * the reload takes over. Nothing else reloads, and the server never does.
 */
describe("json() on a 409 from a household an import has closed (#1316)", () => {
  const importMessage = "This household's owner is bringing in an archive. Come back when it's finished.";

  /** @type {import("vitest").Mock} */
  let assign;
  /** @type {import("vitest").Mock} */
  let reload;

  /** @param {number} status @param {unknown} body */
  function failure(status, body) {
    return fakeResponse({ ok: false, status, body });
  }

  beforeEach(() => {
    assign = vi.fn();
    reload = vi.fn();
    vi.stubGlobal("window", { location: { assign, reload, pathname: "/household/settings" } });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("rejects with the WorkspaceError and reloads the page exactly once, without navigating", async () => {
    const response = failure(409, {
      error: { code: "household_import_in_progress", message: importMessage },
    });

    const error = await json(response).catch((caught) => caught);

    expect(error).toBeInstanceOf(WorkspaceError);
    expect(error).toMatchObject({
      status: 409,
      code: "household_import_in_progress",
      message: importMessage,
    });
    expect(reload).toHaveBeenCalledTimes(1);
    expect(assign).not.toHaveBeenCalled();
  });

  it("does not reload for a 409 carrying any other code", async () => {
    const response = failure(409, {
      error: { code: "household_deletion_pending", message: "This household is being deleted" },
    });

    await expect(json(response)).rejects.toMatchObject({
      status: 409,
      code: "household_deletion_pending",
    });
    expect(reload).not.toHaveBeenCalled();
    expect(assign).not.toHaveBeenCalled();
  });

  it("sends a 401 into the login journey and does not reload", async () => {
    const response = failure(401, {
      error: { code: "unauthenticated", message: "Sign in required" },
    });

    await expect(json(response)).rejects.toMatchObject({ status: 401, code: "unauthenticated" });
    expect(assign).toHaveBeenCalledTimes(1);
    expect(assign).toHaveBeenCalledWith(
      `/api/auth/login?returnTo=${encodeURIComponent("/household/settings")}`,
    );
    expect(reload).not.toHaveBeenCalled();
  });

  it("still rejects with the same WorkspaceError, and no ReferenceError, when there is no window (server side)", async () => {
    vi.unstubAllGlobals();
    expect(typeof window).toBe("undefined");
    const response = failure(409, {
      error: { code: "household_import_in_progress", message: importMessage },
    });

    const error = await json(response).catch((caught) => caught);

    expect(error).not.toBeInstanceOf(ReferenceError);
    expect(error).toBeInstanceOf(WorkspaceError);
    expect(error).toMatchObject({
      status: 409,
      code: "household_import_in_progress",
      message: importMessage,
    });
  });
});
