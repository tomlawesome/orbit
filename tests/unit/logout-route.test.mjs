import { beforeEach, describe, expect, it, vi } from "vitest";

/*
 * `POST /api/auth/logout`'s contract (#735 port, #1316 decision 26a, #1405):
 * signing out must work from a broken session, so
 *   - with a session it takes the full CSRF check, without one only the
 *     same-origin check (a dead session must never trap someone signed in);
 *   - it is the one route open while the encryption key is unusable;
 *   - the session row (and the provider token sealed on it) is taken before
 *     anything that can fail, and the cookie is always cleared;
 *   - a JSON caller gets `{ redirectTo }`, a form post a 303; both no-store.
 * The real session helpers (assertCsrf, assertSameOrigin) run; only reading and
 * deleting the stored session, and the provider hand-off, are stubbed.
 */
const mocks = vi.hoisted(() => ({
  getAuthConfig: vi.fn(),
  readSession: vi.fn(),
  takeSessionIdToken: vi.fn(),
  providerLogoutFor: vi.fn(),
  assertKeyUsable: vi.fn(),
}));

vi.mock("orbit/lib/env", () => ({ getAuthConfig: mocks.getAuthConfig }));
vi.mock("orbit/lib/auth/session", async (importOriginal) => ({
  ...(await importOriginal()),
  readSession: mocks.readSession,
  takeSessionIdToken: mocks.takeSessionIdToken,
}));
vi.mock("orbit/lib/auth/provider-logout", () => ({ providerLogoutFor: mocks.providerLogoutFor }));
vi.mock("orbit/server/key-state", () => ({ assertKeyUsable: mocks.assertKeyUsable, noteRefusedSignIn: vi.fn() }));

const { POST } = await import("../../web/src/routes/api/auth/logout/+server.js");
const { csrfTokenForSession } = await import("orbit/lib/auth/session");

const config = {
  appUrl: new URL("https://orbit.example"),
  sessionSecret: "s".repeat(48),
  secureCookies: true,
  sessionTtlSeconds: 3600,
};
const session = { id: "s-1", token: "tok-1", user: { id: "u-1" } };

const csrf = async () => csrfTokenForSession(session, config);

function event({ headers = {}, search = "" } = {}) {
  return {
    cookies: { get: vi.fn(), set: vi.fn() },
    url: new URL(`https://orbit.example/api/auth/logout${search}`),
    request: new Request(`https://orbit.example/api/auth/logout${search}`, {
      method: "POST",
      headers: { origin: "https://orbit.example", ...headers },
    }),
  };
}

const cleared = (e) => e.cookies.set.mock.calls.some(([name, value, opts]) => /orbit-session$/u.test(name) && value === "" && opts.maxAge === 0);

describe("POST /api/auth/logout", () => {
  beforeEach(() => {
    for (const m of Object.values(mocks)) m.mockReset();
    mocks.getAuthConfig.mockReturnValue(config);
    mocks.readSession.mockResolvedValue(session);
    mocks.takeSessionIdToken.mockResolvedValue("id-token");
    mocks.providerLogoutFor.mockResolvedValue(null);
  });

  it("with a session and a valid CSRF token: clears the cookie and 303s to the app, no-store", async () => {
    const e = event({ headers: { "x-csrf-token": await csrf() } });
    const response = await POST(e);
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("https://orbit.example/");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(mocks.takeSessionIdToken).toHaveBeenCalledWith("tok-1");
    expect(cleared(e)).toBe(true);
  });

  it("with a session but a missing CSRF token: 403 csrf_failed and the session is not taken", async () => {
    const e = event();
    const response = await POST(e);
    expect(response.status).toBe(403);
    expect((await response.json()).error.code).toBe("csrf_failed");
    expect(mocks.takeSessionIdToken).not.toHaveBeenCalled();
    expect(cleared(e)).toBe(false);
  });

  it("with no session, a same-origin request still signs out (no CSRF token needed)", async () => {
    mocks.readSession.mockResolvedValue(null);
    const e = event();
    const response = await POST(e);
    expect(response.status).toBe(303);
    expect(mocks.takeSessionIdToken).toHaveBeenCalledWith(undefined);
    expect(cleared(e)).toBe(true);
  });

  it("with no session, a cross-origin request is refused 403", async () => {
    mocks.readSession.mockResolvedValue(null);
    const response = await POST(event({ headers: { origin: "https://evil.example" } }));
    expect(response.status).toBe(403);
    expect(mocks.takeSessionIdToken).not.toHaveBeenCalled();
  });

  it("with no session, a cross-site fetch-metadata header is refused even from the right origin", async () => {
    mocks.readSession.mockResolvedValue(null);
    const response = await POST(event({ headers: { "sec-fetch-site": "cross-site" } }));
    expect(response.status).toBe(403);
  });

  it("with no session and no origin header at all: refused 403", async () => {
    mocks.readSession.mockResolvedValue(null);
    const e = event();
    e.request = new Request("https://orbit.example/api/auth/logout", { method: "POST" });
    expect((await POST(e)).status).toBe(403);
  });

  it("a JSON caller gets the provider's end-session URL, or null when there is none", async () => {
    mocks.providerLogoutFor.mockResolvedValue(new URL("https://idp.example/end"));
    const withProvider = await POST(event({ headers: { "x-csrf-token": await csrf(), accept: "application/json" } }));
    expect(withProvider.status).toBe(200);
    expect(await withProvider.json()).toEqual({ redirectTo: "https://idp.example/end" });
    expect(withProvider.headers.get("cache-control")).toBe("no-store");

    mocks.providerLogoutFor.mockResolvedValue(null);
    const without = await POST(event({ headers: { "x-csrf-token": await csrf(), accept: "application/json" } }));
    expect(await without.json()).toEqual({ redirectTo: null });
  });

  it("a JSON caller's provider hand-back defaults to the /logout goodbye; a form post's to the front door", async () => {
    await POST(event({ headers: { "x-csrf-token": await csrf(), accept: "application/json" } }));
    expect(mocks.providerLogoutFor.mock.calls[0][2].href).toBe("https://orbit.example/logout");
    await POST(event({ headers: { "x-csrf-token": await csrf() } }));
    expect(mocks.providerLogoutFor.mock.calls[1][2].href).toBe("https://orbit.example/");
  });

  it("a form post goes to the provider's URL when there is one", async () => {
    mocks.providerLogoutFor.mockResolvedValue(new URL("https://idp.example/end?x=1"));
    const response = await POST(event({ headers: { "x-csrf-token": await csrf() } }));
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("https://idp.example/end?x=1");
  });

  it("never sends the signed-out person to another origin through returnTo (open redirect)", async () => {
    for (const bad of ["https://evil.example/", "//evil.example/", "/\\evil.example"]) {
      mocks.providerLogoutFor.mockClear();
      const response = await POST(event({ headers: { "x-csrf-token": await csrf() }, search: `?returnTo=${encodeURIComponent(bad)}` }));
      expect(new URL(response.headers.get("location")).origin).toBe("https://orbit.example");
    }
  });

  it("stays open while the encryption key is unusable (#1405): the key gate is never consulted", async () => {
    const { KeyUnavailableError } = await import("orbit/lib/errors");
    mocks.assertKeyUsable.mockImplementation(() => {
      throw new KeyUnavailableError();
    });
    const e = event({ headers: { "x-csrf-token": await csrf() } });
    const response = await POST(e);
    expect(response.status).toBe(303);
    expect(cleared(e)).toBe(true);
  });

  it("an unexpected failure after the row is taken still answers an error envelope, no-store", async () => {
    mocks.providerLogoutFor.mockRejectedValue(new Error("boom"));
    const response = await POST(event({ headers: { "x-csrf-token": await csrf() } }));
    expect(response.status).toBeGreaterThanOrEqual(500);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(mocks.takeSessionIdToken).toHaveBeenCalled();
  });
});
