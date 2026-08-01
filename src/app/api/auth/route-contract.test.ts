import { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AuthConfig } from "@/lib/env";
import { transactionCookieName } from "@/lib/auth/cookies";
import { sealLoginTransaction } from "@/lib/auth/crypto";

const config: AuthConfig = {
  appUrl: new URL("https://orbit.example"),
  sessionSecret: "route-contract-session-secret-that-is-long-enough",
  sessionTtlSeconds: 3600,
  issuer: "https://issuer.route-contract.example.invalid/",
  clientId: "route-contract-client",
  clientSecret: "route-contract-client-secret",
  callbackUrl: "https://orbit.example/api/auth/callback",
  scopes: "openid profile email",
  claims: { email: "email", emailVerified: "email_verified", name: "name", avatar: "picture" },
  secureCookies: true,
};

const providerMetadata = {
  issuer: config.issuer,
  authorization_endpoint: "https://issuer.route-contract.example.invalid/authorize",
  token_endpoint: "https://issuer.route-contract.example.invalid/token",
  jwks_uri: "https://issuer.route-contract.example.invalid/jwks",
  code_challenge_methods_supported: ["S256"],
};

const credentialSentinel = "callback-credential-sentinel";
const identitySentinel = "callback-identity-sentinel@example.invalid";

type CallbackMocks = {
  AuthError: typeof import("@/lib/auth/errors").AuthError;
  discoverProvider: ReturnType<typeof vi.fn>;
  completeAuthorization: ReturnType<typeof vi.fn>;
  provisionIdentity: ReturnType<typeof vi.fn>;
  createSession: ReturnType<typeof vi.fn>;
  deleteSessionToken: ReturnType<typeof vi.fn>;
  reportAuthProviderDiscoveryFailure: ReturnType<typeof vi.fn>;
  reportAuthTokenExchangeFailure: ReturnType<typeof vi.fn>;
};

async function loadCallbackRoute(): Promise<{ GET: typeof import("./callback/route").GET; mocks: CallbackMocks }> {
  vi.resetModules();
  const mocks: CallbackMocks = {
    AuthError: (await import("@/lib/auth/errors")).AuthError,
    discoverProvider: vi.fn(),
    completeAuthorization: vi.fn(),
    provisionIdentity: vi.fn(),
    createSession: vi.fn(),
    deleteSessionToken: vi.fn(),
    reportAuthProviderDiscoveryFailure: vi.fn(),
    reportAuthTokenExchangeFailure: vi.fn(),
  };
  vi.doMock("@/lib/env", () => ({ getAuthConfig: () => config }));
  vi.doMock("@/lib/auth/oidc", () => ({
    completeAuthorization: mocks.completeAuthorization,
    createAuthorizationUrl: vi.fn(),
    createProviderLogoutUrl: vi.fn(),
    discoverProvider: mocks.discoverProvider,
  }));
  vi.doMock("@/lib/auth/provision", () => ({ provisionIdentity: mocks.provisionIdentity }));
  vi.doMock("@/lib/auth/observability", () => ({
    reportAuthConfiguration: vi.fn(),
    reportAuthProviderDiscoveryFailure: mocks.reportAuthProviderDiscoveryFailure,
    reportAuthTokenExchangeFailure: mocks.reportAuthTokenExchangeFailure,
  }));
  vi.doMock("@/lib/auth/session", () => ({
    createSession: mocks.createSession,
    deleteSessionToken: mocks.deleteSessionToken,
  }));
  const route = await import("./callback/route");
  return { GET: route.GET, mocks };
}

async function loadLoginRoute(): Promise<{
  GET: typeof import("./login/route").GET;
  AuthError: typeof import("@/lib/auth/errors").AuthError;
  discoverProvider: ReturnType<typeof vi.fn>;
}> {
  vi.resetModules();
  const AuthError = (await import("@/lib/auth/errors")).AuthError;
  const discoverProvider = vi.fn();
  vi.doMock("@/lib/env", () => ({ getAuthConfig: () => config }));
  vi.doMock("@/lib/auth/oidc", () => ({
    createAuthorizationUrl: vi.fn(),
    discoverProvider,
  }));
  const route = await import("./login/route");
  return { GET: route.GET, AuthError, discoverProvider };
}

async function loadLogoutRoute(): Promise<{
  POST: typeof import("./logout/route").POST;
  deleteSessionToken: ReturnType<typeof vi.fn>;
  clearSessionCookie: ReturnType<typeof vi.fn>;
}> {
  vi.resetModules();
  const deleteSessionToken = vi.fn();
  const clearSessionCookie = vi.fn();
  vi.doMock("@/lib/env", () => ({ getAuthConfig: () => config }));
  vi.doMock("@/lib/auth/cookies", () => ({ clearSessionCookie }));
  vi.doMock("@/lib/auth/oidc", () => ({
    createProviderLogoutUrl: () => new URL("https://issuer.route-contract.example.invalid/logout"),
    discoverProvider: vi.fn().mockResolvedValue(providerMetadata),
  }));
  vi.doMock("@/lib/auth/session", () => ({
    assertCsrf: vi.fn(),
    assertSameOrigin: vi.fn(),
    deleteSessionToken,
    readSession: vi.fn().mockResolvedValue({ token: "opaque-session-token" }),
  }));
  const route = await import("./logout/route");
  return { POST: route.POST, deleteSessionToken, clearSessionCookie };
}

async function transactionCookie(state = "expected-state"): Promise<string> {
  return sealLoginTransaction({
    state,
    nonce: "expected-nonce",
    codeVerifier: "expected-code-verifier",
    returnTo: "/",
  }, config);
}

function callbackRequest(query: string, sealedTransaction?: string): NextRequest {
  const headers = sealedTransaction
    ? { cookie: `${transactionCookieName(config)}=${sealedTransaction}` }
    : undefined;
  return new NextRequest(`https://orbit.example/api/auth/callback${query}`, { headers });
}

function expectCallbackFailure(response: Response, code: string): void {
  expect(response.status).toBe(303);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(new URL(response.headers.get("location") ?? "https://invalid.example/")).toEqual(
    new URL(`/auth/error?code=${code}`, config.appUrl),
  );
  expect(response.headers.get("set-cookie")).toContain(`${transactionCookieName(config)}=`);
  expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("authentication callback and login route contracts", () => {
  it.each([
    ["provider decline", () => callbackRequest("?error=access_denied&error_description=provider-secret-sentinel"), "provider_error"],
    ["missing transaction", () => callbackRequest("?code=authorization-code-sentinel&state=state"), "invalid_request"],
    ["tampered transaction", () => callbackRequest("?code=authorization-code-sentinel&state=expected-state", "tampered-transaction-sentinel"), "invalid_state"],
  ])("maps %s to a cleared bounded callback failure", async (_label, requestFactory, code) => {
    const { GET, mocks } = await loadCallbackRoute();
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const response = await GET(requestFactory());

    expectCallbackFailure(response, code);
    expect(mocks.createSession).not.toHaveBeenCalled();
    expect(mocks.provisionIdentity).not.toHaveBeenCalled();
    expect(errorLog).toHaveBeenCalledTimes(1);
    expect(errorLog.mock.calls[0]).toEqual([
      "Orbit authentication callback failed",
      { code, status: code === "provider_error" ? 401 : 400 },
    ]);
    expect(JSON.stringify(errorLog.mock.calls)).not.toContain(credentialSentinel);
    expect(JSON.stringify(errorLog.mock.calls)).not.toContain(identitySentinel);
    expect(mocks.reportAuthProviderDiscoveryFailure).not.toHaveBeenCalled();
    expect(mocks.reportAuthTokenExchangeFailure).not.toHaveBeenCalled();
  });

  it("rejects a mismatched transaction state without creating a session", async () => {
    const { GET, mocks } = await loadCallbackRoute();
    const sealed = await transactionCookie("expected-state");
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const response = await GET(callbackRequest("?code=authorization-code-sentinel&state=other-state", sealed));

    expectCallbackFailure(response, "invalid_state");
    expect(mocks.createSession).not.toHaveBeenCalled();
    expect(mocks.provisionIdentity).not.toHaveBeenCalled();
    expect(errorLog.mock.calls[0]).toEqual([
      "Orbit authentication callback failed",
      { code: "invalid_state", status: 400 },
    ]);
  });

  it.each([
    ["discovery", "discovery_failed", "discovery_failed"],
    ["token exchange", "token_exchange_failed", "token_exchange_failed"],
    ["UserInfo", "provider_error", "provider_error"],
  ])("maps %s failure to a cleared no-session redirect", async (_label, failureCode, redirectCode) => {
    const { GET, mocks } = await loadCallbackRoute();
    const sealed = await transactionCookie();
    if (failureCode === "discovery_failed") {
      mocks.discoverProvider.mockRejectedValue(new mocks.AuthError(
        "discovery_failed",
        "The OpenID provider configuration could not be validated",
        502,
        { cause: new Error(credentialSentinel) },
      ));
    } else {
      mocks.discoverProvider.mockResolvedValue(providerMetadata);
      mocks.completeAuthorization.mockRejectedValue(new mocks.AuthError(
        failureCode as "token_exchange_failed" | "provider_error",
        "The provider response could not be validated",
        502,
        { cause: new Error(`${credentialSentinel}:${identitySentinel}`) },
      ));
    }
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const response = await GET(callbackRequest("?code=authorization-code-sentinel&state=expected-state", sealed));

    expectCallbackFailure(response, redirectCode);
    expect(mocks.provisionIdentity).not.toHaveBeenCalled();
    expect(mocks.createSession).not.toHaveBeenCalled();
    expect(errorLog.mock.calls[0]).toEqual([
      "Orbit authentication callback failed",
      { code: redirectCode, status: 502 },
    ]);
    expect(JSON.stringify(errorLog.mock.calls)).not.toContain(credentialSentinel);
    expect(JSON.stringify(errorLog.mock.calls)).not.toContain(identitySentinel);
    if (failureCode === "discovery_failed") {
      expect(mocks.reportAuthProviderDiscoveryFailure).toHaveBeenCalledOnce();
      expect(mocks.reportAuthTokenExchangeFailure).not.toHaveBeenCalled();
    } else if (failureCode === "token_exchange_failed") {
      expect(mocks.reportAuthTokenExchangeFailure).toHaveBeenCalledOnce();
      expect(mocks.reportAuthProviderDiscoveryFailure).not.toHaveBeenCalled();
    } else {
      expect(mocks.reportAuthProviderDiscoveryFailure).not.toHaveBeenCalled();
      expect(mocks.reportAuthTokenExchangeFailure).not.toHaveBeenCalled();
    }
  });

  it("returns a bounded no-store login error when discovery fails", async () => {
    const { GET, AuthError, discoverProvider } = await loadLoginRoute();
    discoverProvider.mockRejectedValue(new AuthError(
      "discovery_failed",
      "The OpenID provider configuration could not be validated",
      502,
    ));

    const response = await GET(new NextRequest("https://orbit.example/api/auth/login?returnTo=/"));

    expect(response.status).toBe(502);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      error: {
        code: "discovery_failed",
        message: "The OpenID provider configuration could not be validated",
      },
    });
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  it("returns the provider logout target to an authenticated browser request without following it", async () => {
    const { POST, deleteSessionToken, clearSessionCookie } = await loadLogoutRoute();

    const response = await POST(new NextRequest("https://orbit.example/api/auth/logout", {
      method: "POST",
      headers: {
        accept: "application/json",
        origin: config.appUrl.origin,
        "x-csrf-token": "csrf-token",
      },
    }));

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      redirectTo: "https://issuer.route-contract.example.invalid/logout",
    });
    expect(deleteSessionToken).toHaveBeenCalledWith("opaque-session-token");
    expect(clearSessionCookie).toHaveBeenCalledOnce();
  });
});
