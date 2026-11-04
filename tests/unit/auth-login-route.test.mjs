import { beforeEach, describe, expect, it, vi } from "vitest";

/*
 * `GET /api/auth/login` (#735 port, ADR-0022 §2): starts the OIDC
 * authorization-code flow. Signed out by design, so no session or CSRF.
 * Contract: 503 auth_not_configured with no provider; while the instance is
 * unclaimed the provider is unreachable without the claim proof (403
 * bootstrap_required) and the transaction records `bootstrap: true`; otherwise
 * a hand-built 302 (not 303) to the provider with a no-store header, a sealed
 * transaction cookie, fresh state/nonce/verifier, and a returnTo that can only
 * be an application-relative path (never an open redirect).
 */
const mocks = vi.hoisted(() => ({
  getAuthConfig: vi.fn(),
  isClaimed: vi.fn(),
  hasClaimProof: vi.fn(),
  discoverProvider: vi.fn(),
  createAuthorizationUrl: vi.fn(),
  sealLoginTransaction: vi.fn(),
  setTransactionCookie: vi.fn(),
  assertKeyUsable: vi.fn(),
  noteRefusedSignIn: vi.fn(),
}));

vi.mock("orbit/lib/env", () => ({ getAuthConfig: mocks.getAuthConfig }));
vi.mock("orbit/lib/auth/bootstrap", () => ({ isClaimed: mocks.isClaimed, hasClaimProof: mocks.hasClaimProof }));
vi.mock("orbit/lib/auth/oidc", () => ({
  discoverProvider: mocks.discoverProvider,
  createAuthorizationUrl: mocks.createAuthorizationUrl,
}));
vi.mock("orbit/lib/auth/crypto", async (importOriginal) => ({
  ...(await importOriginal()),
  sealLoginTransaction: mocks.sealLoginTransaction,
}));
vi.mock("orbit/lib/auth/cookies", () => ({ setTransactionCookie: mocks.setTransactionCookie }));
vi.mock("orbit/server/key-state", () => ({ assertKeyUsable: mocks.assertKeyUsable, noteRefusedSignIn: mocks.noteRefusedSignIn }));

const { GET } = await import("../../web/src/routes/api/auth/login/+server.js");
const { KeyUnavailableError } = await import("orbit/lib/errors");

const config = { appUrl: new URL("https://orbit.example"), oidc: { issuer: "https://idp.example" } };

function event(search = "") {
  return {
    cookies: { get: vi.fn() },
    route: { id: "/api/auth/login" },
    url: new URL(`https://orbit.example/api/auth/login${search}`),
    request: new Request(`https://orbit.example/api/auth/login${search}`),
  };
}

beforeEach(() => {
  for (const m of Object.values(mocks)) m.mockReset();
  mocks.getAuthConfig.mockReturnValue(config);
  mocks.isClaimed.mockResolvedValue(true);
  mocks.discoverProvider.mockResolvedValue({ authorization_endpoint: "https://idp.example/auth" });
  mocks.sealLoginTransaction.mockResolvedValue("sealed");
  mocks.createAuthorizationUrl.mockReturnValue(new URL("https://idp.example/auth?state=x"));
});

describe("GET /api/auth/login", () => {
  it("redirects a signed-out visitor to the provider with a 302, no-store, and a sealed transaction cookie", async () => {
    const e = event();
    const response = await GET(e);
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("https://idp.example/auth?state=x");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(mocks.setTransactionCookie).toHaveBeenCalledWith(e.cookies, "sealed", config);
    const transaction = mocks.sealLoginTransaction.mock.calls[0][0];
    expect(transaction).toMatchObject({ returnTo: "/" });
    expect(transaction.bootstrap).toBeUndefined();
    for (const field of ["state", "nonce", "codeVerifier"]) expect(transaction[field].length).toBeGreaterThanOrEqual(16);
    expect(new Set([transaction.state, transaction.nonce, transaction.codeVerifier]).size).toBe(3);
  });

  it("uses fresh secrets on every attempt", async () => {
    await GET(event());
    await GET(event());
    expect(mocks.sealLoginTransaction.mock.calls[0][0].state).not.toBe(mocks.sealLoginTransaction.mock.calls[1][0].state);
  });

  it("carries an application-relative returnTo through the sealed transaction", async () => {
    await GET(event("?returnTo=%2Fhouseholds%2F1"));
    expect(mocks.sealLoginTransaction.mock.calls[0][0].returnTo).toBe("/households/1");
  });

  it.each(["https://evil.example/", "//evil.example/", "/\\evil.example", "evil"])("collapses the off-site returnTo %s to the front door", async (bad) => {
    await GET(event(`?returnTo=${encodeURIComponent(bad)}`));
    expect(mocks.sealLoginTransaction.mock.calls[0][0].returnTo).toBe("/");
  });

  it("answers 503 auth_not_configured when no provider is configured, and starts nothing", async () => {
    mocks.getAuthConfig.mockReturnValue({ ...config, oidc: undefined });
    const response = await GET(event());
    expect(response.status).toBe(503);
    expect((await response.json()).error.code).toBe("auth_not_configured");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(mocks.discoverProvider).not.toHaveBeenCalled();
    expect(mocks.setTransactionCookie).not.toHaveBeenCalled();
  });

  it("refuses 403 bootstrap_required on an unclaimed instance without the claim proof (ADR-0022 §2)", async () => {
    mocks.isClaimed.mockResolvedValue(false);
    mocks.hasClaimProof.mockResolvedValue(false);
    const response = await GET(event());
    expect(response.status).toBe(403);
    expect((await response.json()).error.code).toBe("bootstrap_required");
    expect(mocks.discoverProvider).not.toHaveBeenCalled();
    expect(mocks.setTransactionCookie).not.toHaveBeenCalled();
  });

  it("lets an unclaimed instance's claimant through and marks the transaction bootstrap", async () => {
    mocks.isClaimed.mockResolvedValue(false);
    mocks.hasClaimProof.mockResolvedValue(true);
    const response = await GET(event());
    expect(response.status).toBe(302);
    expect(mocks.sealLoginTransaction.mock.calls[0][0].bootstrap).toBe(true);
  });

  it("answers 502 when the provider cannot be discovered, with no cookie set", async () => {
    const { AuthError } = await import("orbit/lib/auth/errors");
    mocks.discoverProvider.mockRejectedValue(new AuthError("discovery_failed", "down", 502));
    const response = await GET(event());
    expect(response.status).toBe(502);
    expect(mocks.setTransactionCookie).not.toHaveBeenCalled();
  });

  it("answers the bounded 503 and logs the refused sign-in while the encryption key is unusable (#1405)", async () => {
    mocks.assertKeyUsable.mockImplementation(() => {
      throw new KeyUnavailableError();
    });
    const response = await GET(event());
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "encryption_key_unavailable" });
    expect(mocks.noteRefusedSignIn).toHaveBeenCalledTimes(1);
    expect(mocks.discoverProvider).not.toHaveBeenCalled();
  });
});
