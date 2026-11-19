import { beforeEach, describe, expect, it, vi } from "vitest";

/*
 * #1901 (ruling 3, W-S1 / W-S2): a provider sign-in that hits the
 * change-password hold works out its destination the way the success path
 * does -- the invitation cookie first, else the transaction's returnTo -- and
 * seals that as the door's `returnTo`. The invitation cookie is NOT cleared:
 * /invite/[token] clears it. Harness as auth-callback-session-order.
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
  readInvitationCookie: vi.fn(),
  clearInvitationCookie: vi.fn(),
  issuePasswordChangeHold: vi.fn(),
  reportAuthCallbackFailure: vi.fn(),
}));

vi.mock("orbit/lib/auth/cookies", () => ({
  clearTransactionCookie: mocks.clearTransactionCookie,
  setSessionCookie: mocks.setSessionCookie,
  sessionCookieName: () => "orbit_session",
  transactionCookieName: () => "orbit_txn",
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
  isStepUpIntent: () => false,
  setStepUpProofCookie: vi.fn(),
}));
vi.mock("orbit/lib/auth/password-change-hold", () => ({ issuePasswordChangeHold: mocks.issuePasswordChangeHold }));
vi.mock("orbit/lib/auth/session", () => ({
  createSession: mocks.createSession,
  deleteSessionToken: mocks.deleteSessionToken,
}));
vi.mock("orbit/lib/env", () => ({ getAuthConfig: mocks.getAuthConfig }));
vi.mock("orbit/server/invitations/cookie", () => ({
  readInvitationCookie: mocks.readInvitationCookie,
  clearInvitationCookie: mocks.clearInvitationCookie,
}));
vi.mock("orbit/server/local-credentials", () => ({ linkIdentity: vi.fn() }));

/* Loaded after each resetModules, from the specifier the route uses, so instanceof holds. */
async function refusal(userId, at) {
  const { PasswordChangeRequiredError } = await import("orbit/lib/auth/errors");
  return new PasswordChangeRequiredError(userId, at);
}

const config = { oidc: { issuer: "https://idp.example" }, appUrl: "https://orbit.example" };
const REFUSED_AT = new Date("2026-11-19T09:00:00.000Z");

function event() {
  return {
    url: new URL("https://orbit.example/api/auth/callback?code=c&state=s"),
    cookies: { get: vi.fn(() => "txn-cookie"), set: vi.fn(), delete: vi.fn() },
    request: new Request("https://orbit.example/api/auth/callback", { headers: { "user-agent": "test" } }),
  };
}

async function callback() {
  const e = event();
  const { GET } = await import("../../web/src/routes/api/auth/callback/+server.js");
  return { response: await GET(e), e };
}

beforeEach(() => {
  vi.resetModules();
  for (const mock of Object.values(mocks)) mock.mockReset?.();
  mocks.getAuthConfig.mockReturnValue(config);
  mocks.openLoginTransaction.mockResolvedValue({ state: "s", returnTo: "/home" });
  mocks.constantTimeEqual.mockReturnValue(true);
  mocks.transactionKind.mockReturnValue("login");
  mocks.discoverProvider.mockResolvedValue({});
  mocks.completeAuthorization.mockResolvedValue({
    identity: { issuer: "https://idp.example", subject: "s1", email: "p@example.invalid", emailVerified: true, displayName: "P", avatarUrl: null },
    idToken: "t",
  });
  mocks.provisionIdentity.mockResolvedValue({ id: "u1", disabledAt: null });
  mocks.createSession.mockImplementation(async () => { throw await refusal("u1", REFUSED_AT); });
  mocks.issuePasswordChangeHold.mockResolvedValue({ refusedAt: REFUSED_AT.toISOString(), expiresAt: "2026-11-19T09:10:00.000Z" });
  mocks.readInvitationCookie.mockReturnValue(null);
});

describe("GET /api/auth/callback on the change-password hold (#1901 W-S1, W-S2)", () => {
  it("seals the invitation as the door's returnTo and leaves the invitation cookie for /invite to clear", async () => {
    mocks.readInvitationCookie.mockReturnValue("inv tok/1");
    const { response, e } = await callback();

    expect(response.status).toBe(303);
    const door = new URL(String(response.headers.get("location")));
    expect(door.pathname).toBe("/login");
    expect(door.searchParams.get("password")).toBe("new");
    expect(door.searchParams.get("refusedAt")).toBe(REFUSED_AT.toISOString());
    expect(door.searchParams.get("returnTo")).toBe("/invite/inv%20tok%2F1");
    expect(mocks.clearInvitationCookie).not.toHaveBeenCalled();
    expect(e.cookies.delete).not.toHaveBeenCalled();
  });

  it("seals the transaction's returnTo when there is no invitation cookie", async () => {
    mocks.openLoginTransaction.mockResolvedValue({ state: "s", returnTo: "/household/7" });
    const { response } = await callback();

    expect(response.status).toBe(303);
    const door = new URL(String(response.headers.get("location")));
    expect(door.searchParams.get("password")).toBe("new");
    expect(door.searchParams.get("returnTo")).toBe("/household/7");
  });
});
