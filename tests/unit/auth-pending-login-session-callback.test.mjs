import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/*
 * #1151 SR1-R7 (web half): `collectSignInApproval` now takes an optional
 * `mintSession` callback -- a callback that throws has its spend reverted
 * before the error propagates (src/server/sign-in-approvals.ts, same issue
 * number). This route used to spend the approval with no callback, then call
 * createSession separately: a crash between the two still stranded a
 * correctly approved sign-in, exactly the failure mode the callback exists
 * to close. The fix is wiring, not new logic, so this proves the wiring --
 * that createSession is reached only from inside the callback this route
 * hands to collectSignInApproval, never called on its own -- the same
 * module-boundary-mock pattern as tests/unit/auth-callback-session-order.test.mjs.
 */

const mocks = vi.hoisted(() => ({
  getAuthConfig: vi.fn(),
  assertSameOrigin: vi.fn(),
  createSession: vi.fn(),
  deleteSessionToken: vi.fn(),
  collectSignInApproval: vi.fn(),
  clearPendingSignInCookie: vi.fn(),
  setSessionCookie: vi.fn(),
  pendingSignInCookieName: vi.fn(() => "orbit_pending"),
  sessionCookieName: vi.fn(() => "orbit_session"),
}));

vi.mock("orbit/lib/auth/cookies", () => ({
  clearPendingSignInCookie: mocks.clearPendingSignInCookie,
  pendingSignInCookieName: mocks.pendingSignInCookieName,
  sessionCookieName: mocks.sessionCookieName,
  setSessionCookie: mocks.setSessionCookie,
}));
vi.mock("orbit/lib/auth/session", () => ({
  assertSameOrigin: mocks.assertSameOrigin,
  createSession: mocks.createSession,
  deleteSessionToken: mocks.deleteSessionToken,
}));
vi.mock("orbit/lib/env", () => ({ getAuthConfig: mocks.getAuthConfig }));
vi.mock("orbit/server/sign-in-approvals", () => ({ collectSignInApproval: mocks.collectSignInApproval }));

const config = { appUrl: "https://orbit.example" };

function event() {
  return {
    cookies: { get: vi.fn(() => "the-claim") },
    request: new Request("https://orbit.example/api/auth/local/login/pending", {
      method: "POST",
      headers: { "user-agent": "test", origin: config.appUrl },
    }),
  };
}

beforeEach(() => {
  vi.resetModules();
  for (const mock of Object.values(mocks)) mock.mockReset?.();
  mocks.getAuthConfig.mockReturnValue(config);
  mocks.pendingSignInCookieName.mockReturnValue("orbit_pending");
  mocks.sessionCookieName.mockReturnValue("orbit_session");
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("POST /api/auth/local/login/pending session minting (#1151 SR1-R7)", () => {
  it("passes session creation as collectSignInApproval's own mint callback, not a separate call", async () => {
    mocks.collectSignInApproval.mockImplementation(async (_claim, mintSession) => {
      // Exercises the callback the same way the real, already-fixed
      // collectSignInApproval does, so this proves the route hands it one
      // that actually mints a session rather than calling createSession
      // itself afterward.
      const session = await mintSession("u1");
      return { state: "approved", userId: "u1", session };
    });
    mocks.createSession.mockResolvedValue({ token: "new-token", expiresAt: new Date() });

    const { POST } = await import(
      "../../web/src/routes/api/auth/local/login/pending/+server.js"
    );
    const response = await POST(event());

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ state: "approved", authenticated: true });
    expect(mocks.collectSignInApproval).toHaveBeenCalledWith("the-claim", expect.any(Function));
    expect(mocks.createSession).toHaveBeenCalledWith("u1", config, "test");
    expect(mocks.setSessionCookie).toHaveBeenCalledWith(expect.anything(), "new-token", config);
  });

  it("never calls createSession outside the callback collectSignInApproval controls", async () => {
    // Standing in for a mint failure: the real collectSignInApproval reverts
    // the spend and rethrows (already proven in
    // src/server/sign-in-approvals.test.ts); from the route's side, all that
    // matters is that createSession is reached only through the callback,
    // so there is no second, uncoordinated call this revert cannot see.
    mocks.collectSignInApproval.mockImplementation(async (_claim, mintSession) => {
      await mintSession("u1").catch(() => {});
      throw new Error("database unavailable");
    });
    mocks.createSession.mockRejectedValue(new Error("database unavailable"));

    const { POST } = await import(
      "../../web/src/routes/api/auth/local/login/pending/+server.js"
    );
    // api()'s own errorResponse wrapper turns the rethrown failure into a
    // response rather than letting it escape -- the behaviour this test
    // cares about is the call shape underneath, not that mapping.
    const response = await POST(event());

    expect(response.status).toBeGreaterThanOrEqual(500);
    expect(mocks.createSession).toHaveBeenCalledTimes(1);
    expect(mocks.createSession).toHaveBeenCalledWith("u1", config, "test");
  });
});
