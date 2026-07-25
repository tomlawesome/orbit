import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { describe, expect, it } from "vitest";
import type { AuthConfig } from "../env";
import {
  createAuthorizationUrl,
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
};

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
