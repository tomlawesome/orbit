import { randomUUID } from "node:crypto";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AuthConfig } from "../env";
import {
  createAuthorizationUrl,
  completeAuthorization,
  discoverProvider,
  profileFromClaims,
  validateIdTokenClaims,
  verifyIdToken,
  type OidcMetadata,
} from "./oidc";

const config: AuthConfig = {
  appUrl: new URL("https://orbit.example"),
  sessionSecret: "test-secret-that-is-at-least-thirty-two-characters",
  sessionTtlSeconds: 3600,
  issuer: "https://auth.example/application/o/orbit/",
  clientId: "orbit",
  clientSecret: "secret",
  callbackUrl: "https://orbit.example/api/auth/callback",
  scopes: "openid profile email",
  claims: { email: "email", emailVerified: "email_verified", name: "name", avatar: "picture" },
  secureCookies: true,
};

const metadata: OidcMetadata = {
  issuer: config.issuer,
  authorization_endpoint: "https://auth.example/authorize",
  token_endpoint: "https://auth.example/token",
  jwks_uri: "https://auth.example/jwks",
  code_challenge_methods_supported: ["S256"],
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("OIDC validation", () => {
  it("creates an authorization-code request with state, nonce, and S256 PKCE", () => {
    const url = createAuthorizationUrl(config, metadata, {
      state: "state-value",
      nonce: "nonce-value",
      codeVerifier: "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk",
      returnTo: "/",
    });
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("state")).toBe("state-value");
    expect(url.searchParams.get("nonce")).toBe("nonce-value");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
  });

  it("rejects an invalid nonce or authorized party", () => {
    expect(() => validateIdTokenClaims({ sub: "subject", aud: "orbit", nonce: "wrong" }, "expected", "orbit")).toThrow();
    expect(() => validateIdTokenClaims({ sub: "subject", aud: ["orbit", "other"], nonce: "expected", azp: "other" }, "expected", "orbit")).toThrow();
  });

  it("rejects invalid issuer, audience, signature, and expiry", async () => {
    const trusted = await generateKeyPair("RS256");
    const attacker = await generateKeyPair("RS256");
    const publicJwk = { ...await exportJWK(trusted.publicKey), alg: "RS256", kid: "primary", use: "sig" };
    const trustedKeys = createLocalJWKSet({ keys: [publicJwk] });
    const now = Math.floor(Date.now() / 1000);

    const sign = (
      privateKey: CryptoKey,
      issuer = config.issuer,
      audience = config.clientId,
      expiration = now + 300,
    ) => new SignJWT({ nonce: "expected-nonce" })
      .setProtectedHeader({ alg: "RS256", kid: "primary" })
      .setIssuer(issuer)
      .setAudience(audience)
      .setSubject("immutable-subject")
      .setIssuedAt(now)
      .setExpirationTime(expiration)
      .sign(privateKey);

    await expect(verifyIdToken(
      config,
      metadata,
      await sign(trusted.privateKey),
      undefined,
      "expected-nonce",
      trustedKeys,
    )).resolves.toMatchObject({ sub: "immutable-subject" });

    const invalidTokens = await Promise.all([
      sign(trusted.privateKey, "https://attacker.example/"),
      sign(trusted.privateKey, config.issuer, "another-client"),
      sign(attacker.privateKey),
      sign(trusted.privateKey, config.issuer, config.clientId, now - 60),
    ]);
    for (const token of invalidTokens) {
      await expect(verifyIdToken(
        config,
        metadata,
        token,
        undefined,
        "expected-nonce",
        trustedKeys,
      )).rejects.toMatchObject({ code: "invalid_id_token" });
    }
  });

  it("maps mutable profile claims without changing issuer/subject identity", () => {
    expect(profileFromClaims(config, {
      sub: "immutable-subject",
      email: "USER@example.com",
      email_verified: true,
      name: "Updated Name",
      picture: "https://images.example/avatar.png",
    })).toEqual({
      issuer: config.issuer,
      subject: "immutable-subject",
      email: "user@example.com",
      emailVerified: true,
      displayName: "Updated Name",
      avatarUrl: "https://images.example/avatar.png",
    });
  });
});

function uniqueIssuer(): string {
  return `https://issuer-${randomUUID()}.example.invalid/`;
}

function discoveryDocument(issuer: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    issuer,
    authorization_endpoint: `${issuer}authorize`,
    token_endpoint: `${issuer}token`,
    jwks_uri: `${issuer}jwks`,
    code_challenge_methods_supported: ["S256"],
    ...overrides,
  };
}

async function expectDiscoveryFailure(document: unknown, issuer = uniqueIssuer()): Promise<void> {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(document), {
    headers: { "content-type": "application/json" },
  })));
  await expect(discoverProvider({ ...config, issuer })).rejects.toMatchObject({
    code: "discovery_failed",
    status: 502,
  });
}

describe("OIDC discovery and provider failure contracts", () => {
  it("rejects issuer mismatch, insecure endpoints, and missing or unsupported S256", async () => {
    const issuer = uniqueIssuer();
    await expectDiscoveryFailure(discoveryDocument("https://different.example.invalid/"));
    await expectDiscoveryFailure(discoveryDocument(issuer, { authorization_endpoint: "http://insecure.example.invalid/authorize" }), issuer);
    await expectDiscoveryFailure(discoveryDocument(issuer, { code_challenge_methods_supported: undefined }), issuer);
    await expectDiscoveryFailure(discoveryDocument(issuer, { code_challenge_methods_supported: ["plain"] }), issuer);
  });

  it.each([
    ["HTTP failure", () => new Response(JSON.stringify({ error: "unavailable" }), { status: 503 })],
    ["network failure", () => Promise.reject(new Error("discovery-network-sentinel"))],
    ["timeout", () => Promise.reject(new DOMException("The operation was aborted", "TimeoutError"))],
    ["invalid JSON", () => new Response("{", { status: 200 })],
  ])("maps discovery %s to a bounded error", async (_label, responseFactory) => {
    const issuer = uniqueIssuer();
    vi.stubGlobal("fetch", vi.fn().mockImplementation(responseFactory));
    await expect(discoverProvider({ ...config, issuer })).rejects.toMatchObject({
      code: "discovery_failed",
      status: 502,
      message: "The OpenID provider configuration could not be validated",
    });
  });

  it.each([
    ["HTTP failure", () => new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 })],
    ["timeout", () => Promise.reject(new DOMException("The operation was aborted", "TimeoutError"))],
    ["invalid body", () => new Response(JSON.stringify({ access_token: "opaque-token-sentinel" }), { status: 200 })],
  ])("maps token endpoint %s to a bounded error", async (_label, responseFactory) => {
    const issuer = uniqueIssuer();
    const providerMetadata = {
      ...metadata,
      issuer,
      token_endpoint: `${issuer}token`,
    };
    vi.stubGlobal("fetch", vi.fn().mockImplementation(responseFactory));
    await expect(completeAuthorization({ ...config, issuer }, providerMetadata, "authorization-code-sentinel", {
      state: "state",
      nonce: "nonce",
      codeVerifier: "verifier",
      returnTo: "/",
    })).rejects.toMatchObject({
      code: "token_exchange_failed",
      status: 502,
      message: "The authorization code could not be exchanged",
    });
  });

  async function signedProviderFixture() {
    const issuer = uniqueIssuer();
    const providerMetadata: OidcMetadata = {
      ...metadata,
      issuer,
      jwks_uri: `${issuer}jwks`,
      token_endpoint: `${issuer}token`,
      userinfo_endpoint: `${issuer}userinfo`,
    };
    const { privateKey, publicKey } = await generateKeyPair("RS256");
    const publicJwk = { ...await exportJWK(publicKey), alg: "RS256", kid: "primary", use: "sig" };
    const idToken = await new SignJWT({
      nonce: "nonce",
      email: "user@example.invalid",
      email_verified: true,
    })
      .setProtectedHeader({ alg: "RS256", kid: "primary" })
      .setIssuer(issuer)
      .setAudience(config.clientId)
      .setSubject("immutable-subject")
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(privateKey);
    return { providerMetadata, idToken, jwks: { keys: [publicJwk] } };
  }

  it.each([
    ["HTTP failure", () => new Response(JSON.stringify({ error: "invalid_token" }), { status: 401 })],
    ["invalid body", () => new Response("{", { status: 200 })],
    ["subject mismatch", () => new Response(JSON.stringify({ sub: "different-subject" }), { status: 200 })],
  ])("maps UserInfo %s to a bounded error without provider values", async (_label, userInfoResponse) => {
    const { providerMetadata, idToken, jwks } = await signedProviderFixture();
    const fetchMock = vi.fn().mockImplementation((input: string | URL) => {
      const url = String(input);
      if (url === providerMetadata.token_endpoint) {
        return Promise.resolve(new Response(JSON.stringify({
          access_token: "opaque-token-sentinel",
          token_type: "Bearer",
          id_token: idToken,
        }), { headers: { "content-type": "application/json" } }));
      }
      if (url === providerMetadata.jwks_uri) {
        return Promise.resolve(new Response(JSON.stringify(jwks), { headers: { "content-type": "application/json" } }));
      }
      if (url === providerMetadata.userinfo_endpoint) return Promise.resolve(userInfoResponse());
      return Promise.reject(new Error("unexpected endpoint"));
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(completeAuthorization({ ...config, issuer: providerMetadata.issuer }, providerMetadata, "authorization-code-sentinel", {
      state: "state",
      nonce: "nonce",
      codeVerifier: "verifier",
      returnTo: "/",
    })).rejects.toMatchObject({
      code: "provider_error",
      status: 502,
      message: "The OpenID profile could not be validated",
    });
  });
});
