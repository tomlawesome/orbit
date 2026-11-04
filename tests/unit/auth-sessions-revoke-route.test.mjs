import { beforeEach, describe, expect, it, vi } from "vitest";

/*
 * The two sign-out-elsewhere routes (#468, #482, #1439):
 *   POST /api/auth/sessions/revoke               -- every session of the caller
 *   POST /api/auth/sessions/[sessionId]/revoke   -- one session of the caller
 * Both are `write()` routes: maintenance guard, a session, then CSRF (the real
 * assertCsrf runs). Scope comes from the session, never the request body. A
 * session that is someone else's looks exactly like one that never existed
 * (404 session_not_found), and revoking the caller's own session clears this
 * browser's cookie. Responses are no-store JSON.
 */
const mocks = vi.hoisted(() => ({
  getAuthConfig: vi.fn(),
  requireSession: vi.fn(),
  assertOutsideMaintenance: vi.fn(),
  revokeUserSessionsTakingOwn: vi.fn(),
  revokeSession: vi.fn(),
  providerLogoutFor: vi.fn(),
  assertKeyUsable: vi.fn(),
}));

vi.mock("orbit/lib/env", () => ({ getAuthConfig: mocks.getAuthConfig }));
vi.mock("orbit/lib/auth/session", async (importOriginal) => ({
  ...(await importOriginal()),
  requireSession: mocks.requireSession,
  revokeUserSessionsTakingOwn: mocks.revokeUserSessionsTakingOwn,
  revokeSession: mocks.revokeSession,
}));
vi.mock("orbit/server/maintenance", () => ({ assertOutsideMaintenance: mocks.assertOutsideMaintenance }));
vi.mock("orbit/lib/auth/provider-logout", () => ({ providerLogoutFor: mocks.providerLogoutFor }));
vi.mock("orbit/server/key-state", () => ({ assertKeyUsable: mocks.assertKeyUsable, noteRefusedSignIn: vi.fn() }));

const { POST: revokeAll } = await import("../../web/src/routes/api/auth/sessions/revoke/+server.js");
const { POST: revokeOne } = await import("../../web/src/routes/api/auth/sessions/[sessionId]/revoke/+server.js");
const { csrfTokenForSession } = await import("orbit/lib/auth/session");
const { AuthError } = await import("orbit/lib/auth/errors");
const { MaintenanceActiveError } = await import("orbit/lib/errors");

const config = {
  appUrl: new URL("https://orbit.example"),
  sessionSecret: "s".repeat(48),
  secureCookies: false,
  sessionTtlSeconds: 3600,
};
const session = { id: "s-own", token: "tok-own", user: { id: "u-1" } };

function event(sessionId, { csrf = csrfTokenForSession(session, config), origin = "https://orbit.example" } = {}) {
  const headers = { origin };
  if (csrf) headers["x-csrf-token"] = csrf;
  return {
    cookies: { get: vi.fn(), set: vi.fn() },
    params: sessionId === undefined ? {} : { sessionId },
    request: new Request("https://orbit.example/api/auth/sessions/revoke", { method: "POST", headers }),
  };
}
const cleared = (e) => e.cookies.set.mock.calls.some(([name, value, opts]) => name === "orbit-session" && value === "" && opts.maxAge === 0);

beforeEach(() => {
  for (const m of Object.values(mocks)) m.mockReset();
  mocks.getAuthConfig.mockReturnValue(config);
  mocks.requireSession.mockResolvedValue(session);
  mocks.revokeUserSessionsTakingOwn.mockResolvedValue({ revoked: 3, taken: "id-token" });
  mocks.revokeSession.mockResolvedValue("id-token");
  mocks.providerLogoutFor.mockResolvedValue(null);
});

describe.each([
  ["POST /api/auth/sessions/revoke", revokeAll, undefined, () => mocks.revokeUserSessionsTakingOwn],
  ["POST /api/auth/sessions/[sessionId]/revoke", revokeOne, "s-other", () => mocks.revokeSession],
])("%s access rules", (_name, POST, sessionId, action) => {
  it("refuses a signed-out caller with 401 and revokes nothing", async () => {
    mocks.requireSession.mockRejectedValue(new AuthError("session_required", "A valid session is required", 401));
    const response = await POST(event(sessionId));
    expect(response.status).toBe(401);
    expect((await response.json()).error.code).toBe("session_required");
    expect(action()).not.toHaveBeenCalled();
  });

  it("refuses a request with no CSRF token (403 csrf_failed) and revokes nothing", async () => {
    const response = await POST(event(sessionId, { csrf: "" }));
    expect(response.status).toBe(403);
    expect((await response.json()).error.code).toBe("csrf_failed");
    expect(action()).not.toHaveBeenCalled();
  });

  it("refuses a wrong CSRF token", async () => {
    const response = await POST(event(sessionId, { csrf: "not-the-token" }));
    expect(response.status).toBe(403);
    expect(action()).not.toHaveBeenCalled();
  });

  it("refuses a cross-origin form post even with a valid token", async () => {
    const response = await POST(event(sessionId, { origin: "https://evil.example" }));
    expect(response.status).toBe(403);
    expect(action()).not.toHaveBeenCalled();
  });

  it("answers the bounded 503 during maintenance, before looking at the session", async () => {
    mocks.assertOutsideMaintenance.mockRejectedValue(new MaintenanceActiveError(null));
    const response = await POST(event(sessionId));
    expect(response.status).toBe(503);
    expect(mocks.requireSession).not.toHaveBeenCalled();
    expect(action()).not.toHaveBeenCalled();
  });
});

describe("POST /api/auth/sessions/revoke (sign out of every device)", () => {
  it("revokes by the session's own user id, clears the cookie and answers the count, no-store", async () => {
    const e = event();
    const response = await revokeAll(e);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ revoked: 3, redirectTo: null });
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(mocks.revokeUserSessionsTakingOwn).toHaveBeenCalledWith("u-1", "s-own");
    expect(cleared(e)).toBe(true);
  });

  it("hands this browser to the provider's end-session URL, asked with the caller's own token", async () => {
    mocks.providerLogoutFor.mockResolvedValue(new URL("https://idp.example/end"));
    const response = await revokeAll(event());
    expect(await response.json()).toEqual({ revoked: 3, redirectTo: "https://idp.example/end" });
    const [, token, returnTo] = mocks.providerLogoutFor.mock.calls[0];
    expect(token).toBe("id-token");
    expect(returnTo.href).toBe("https://orbit.example/logout");
  });
});

describe("POST /api/auth/sessions/[sessionId]/revoke (sign out of one place)", () => {
  it("revokes another device's session for this user, leaving this browser's cookie alone", async () => {
    const e = event("s-other");
    const response = await revokeOne(e);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ revoked: true, redirectTo: null });
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(mocks.revokeSession).toHaveBeenCalledWith("u-1", "s-other");
    expect(cleared(e)).toBe(false);
    expect(mocks.providerLogoutFor).not.toHaveBeenCalled();
  });

  it("revoking the caller's own session clears the cookie and leaves through the provider", async () => {
    mocks.providerLogoutFor.mockResolvedValue(new URL("https://idp.example/end"));
    const e = event("s-own");
    const response = await revokeOne(e);
    expect(await response.json()).toEqual({ revoked: true, redirectTo: "https://idp.example/end" });
    expect(cleared(e)).toBe(true);
  });

  it("answers 404 session_not_found for a session that is not the caller's, and clears nothing", async () => {
    mocks.revokeSession.mockRejectedValue(new AuthError("session_not_found", "No such session", 404));
    const e = event("s-someone-elses");
    const response = await revokeOne(e);
    expect(response.status).toBe(404);
    expect((await response.json()).error.code).toBe("session_not_found");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(cleared(e)).toBe(false);
  });
});
