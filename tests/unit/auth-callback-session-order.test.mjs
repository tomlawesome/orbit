import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/*
 * #1151 A1-R6: the callback route deleted the browser's previous session
 * token BEFORE creating the replacement. If `createSession` then fails --
 * a transient database error is the obvious one -- the old session is
 * already gone and no new one exists: a sign-in attempt that hit a blip
 * signs the reader OUT of the session they already had, with nothing to
 * show for it but the ordinary error screen.
 *
 * Every collaborator is mocked at its own module boundary (same pattern as
 * tests/unit/system-status-route.test.mjs), so this proves the route's own
 * ordering rather than the OIDC exchange, provisioning or the session store
 * underneath it.
 */

const mocks = vi.hoisted(() => ({
  getAuthConfig: vi.fn(),
  openLoginTransaction: vi.fn(),
  constantTimeEqual: vi.fn(),
  transactionKind: vi.fn(),
  discoverProvider: vi.fn(),
  completeAuthorization: vi.fn(),
  provisionIdentity: vi.fn(),
  createSession: vi.fn(),
  deleteSessionToken: vi.fn(),
  clearTransactionCookie: vi.fn(),
  setSessionCookie: vi.fn(),
  sessionCookieName: vi.fn(() => "orbit_session"),
  transactionCookieName: vi.fn(() => "orbit_txn"),
  readInvitationCookie: vi.fn(() => null),
  reportAuthCallbackFailure: vi.fn(),
}));

vi.mock("orbit/lib/auth/cookies", () => ({
  clearTransactionCookie: mocks.clearTransactionCookie,
  setSessionCookie: mocks.setSessionCookie,
  sessionCookieName: mocks.sessionCookieName,
  transactionCookieName: mocks.transactionCookieName,
}));
vi.mock("orbit/lib/auth/bootstrap", () => ({ clearClaimCookie: vi.fn() }));
vi.mock("orbit/lib/auth/crypto", () => ({
  openLoginTransaction: mocks.openLoginTransaction,
  constantTimeEqual: mocks.constantTimeEqual,
  transactionKind: mocks.transactionKind,
}));
vi.mock("orbit/lib/auth/observability", () => ({ reportAuthCallbackFailure: mocks.reportAuthCallbackFailure }));
vi.mock("orbit/lib/auth/oidc", () => ({
  discoverProvider: mocks.discoverProvider,
  completeAuthorization: mocks.completeAuthorization,
}));
vi.mock("orbit/lib/auth/provision", () => ({ provisionIdentity: mocks.provisionIdentity }));
vi.mock("orbit/lib/auth/recent-auth", () => ({
  completeStepUp: vi.fn(),
  isStepUpIntent: vi.fn(() => false),
  setStepUpProofCookie: vi.fn(),
}));
vi.mock("orbit/lib/auth/session", () => ({
  createSession: mocks.createSession,
  deleteSessionToken: mocks.deleteSessionToken,
}));
vi.mock("orbit/lib/env", () => ({ getAuthConfig: mocks.getAuthConfig }));
vi.mock("orbit/server/invitations/cookie", () => ({ readInvitationCookie: mocks.readInvitationCookie }));
vi.mock("orbit/server/local-credentials", () => ({ linkIdentity: vi.fn() }));

const config = { oidc: { issuer: "https://idp.example" }, appUrl: "https://orbit.example" };

function event() {
  return {
    url: new URL("https://orbit.example/api/auth/callback?code=c&state=s"),
    cookies: { get: vi.fn(() => "txn-cookie") },
    request: new Request("https://orbit.example/api/auth/callback", { headers: { "user-agent": "test" } }),
  };
}

beforeEach(() => {
  vi.resetModules();
  for (const mock of Object.values(mocks)) mock.mockReset?.();
  mocks.getAuthConfig.mockReturnValue(config);
  mocks.openLoginTransaction.mockResolvedValue({ state: "s", returnTo: "/home" });
  mocks.constantTimeEqual.mockReturnValue(true);
  mocks.transactionKind.mockReturnValue("login");
  mocks.discoverProvider.mockResolvedValue({});
  mocks.completeAuthorization.mockResolvedValue({});
  mocks.provisionIdentity.mockResolvedValue({ id: "u1", disabledAt: null });
  mocks.readInvitationCookie.mockReturnValue(null);
  mocks.sessionCookieName.mockReturnValue("orbit_session");
  mocks.transactionCookieName.mockReturnValue("orbit_txn");
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("GET /api/auth/callback session replacement (#1151 A1-R6)", () => {
  it("leaves the previous session alone when creating the replacement fails", async () => {
    mocks.createSession.mockRejectedValue(new Error("database unavailable"));

    const { GET } = await import("../../web/src/routes/api/auth/callback/+server.js");
    const response = await GET(event());

    expect(response.status).toBe(303);
    expect(String(response.headers.get("location"))).toContain("/auth/error");
    expect(mocks.deleteSessionToken).not.toHaveBeenCalled();
  });

  it("still replaces the session on an ordinary successful sign-in", async () => {
    mocks.createSession.mockResolvedValue({ token: "new-token", expiresAt: new Date() });

    const { GET } = await import("../../web/src/routes/api/auth/callback/+server.js");
    const response = await GET(event());

    expect(response.status).toBe(303);
    expect(mocks.createSession).toHaveBeenCalled();
    expect(mocks.deleteSessionToken).toHaveBeenCalled();
  });
});
