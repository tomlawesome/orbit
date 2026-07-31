import { createHash } from "node:crypto";
import { createRemoteJWKSet, base64url, jwtVerify, type JWTPayload } from "jose";
import { z } from "zod";
import type { AuthConfig } from "@/lib/env";
import { constantTimeEqual, createPkceChallenge, type LoginTransaction } from "@/lib/auth/crypto";
import { AuthError } from "@/lib/auth/errors";

const discoverySchema = z.object({
  issuer: z.url(),
  authorization_endpoint: z.url(),
  token_endpoint: z.url(),
  jwks_uri: z.url(),
  userinfo_endpoint: z.url().optional(),
  end_session_endpoint: z.url().optional(),
  code_challenge_methods_supported: z.array(z.string()),
  id_token_signing_alg_values_supported: z.array(z.string()).optional(),
});

const tokenResponseSchema = z.object({
  access_token: z.string().optional(),
  token_type: z.string().optional(),
  expires_in: z.number().optional(),
  id_token: z.string(),
});

export type OidcMetadata = z.infer<typeof discoverySchema>;

export interface VerifiedIdentity {
  issuer: string;
  subject: string;
  email: string;
  emailVerified: boolean;
  displayName: string;
  avatarUrl: string | null;
}

const metadataCache = new Map<string, { expiresAt: number; promise: Promise<OidcMetadata> }>();
const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();
const allowedIdTokenAlgorithms = new Set(["RS256", "RS384", "RS512", "PS256", "PS384", "PS512", "ES256", "ES384", "ES512", "EdDSA"]);

function assertHttpsEndpoint(value: string, label: string): void {
  if (new URL(value).protocol !== "https:") {
    throw new AuthError("discovery_failed", `${label} must use HTTPS`, 502);
  }
}

export async function discoverProvider(config: AuthConfig): Promise<OidcMetadata> {
  const cached = metadataCache.get(config.issuer);
  if (cached && cached.expiresAt > Date.now()) return cached.promise;

  const discoveryUrl = new URL(".well-known/openid-configuration", config.issuer.endsWith("/") ? config.issuer : `${config.issuer}/`);
  const promise = (async () => {
    try {
      const response = await fetch(discoveryUrl, {
        headers: { Accept: "application/json" },
        cache: "no-store",
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) throw new Error(`Discovery returned HTTP ${response.status}`);
      const metadata = discoverySchema.parse(await response.json());
      if (metadata.issuer !== config.issuer) throw new Error("Discovered issuer does not exactly match OIDC_ISSUER");
      assertHttpsEndpoint(metadata.authorization_endpoint, "Authorization endpoint");
      assertHttpsEndpoint(metadata.token_endpoint, "Token endpoint");
      assertHttpsEndpoint(metadata.jwks_uri, "JWKS endpoint");
      if (metadata.userinfo_endpoint) assertHttpsEndpoint(metadata.userinfo_endpoint, "UserInfo endpoint");
      if (metadata.end_session_endpoint) assertHttpsEndpoint(metadata.end_session_endpoint, "Logout endpoint");
      if (!metadata.code_challenge_methods_supported.includes("S256")) {
        throw new Error("Provider does not advertise S256 PKCE support");
      }
      return metadata;
    } catch (error) {
      metadataCache.delete(config.issuer);
      throw new AuthError("discovery_failed", "The OpenID provider configuration could not be validated", 502, { cause: error });
    }
  })();

  metadataCache.set(config.issuer, { expiresAt: Date.now() + 3_600_000, promise });
  return promise;
}

export function createAuthorizationUrl(config: AuthConfig, metadata: OidcMetadata, transaction: LoginTransaction): URL {
  const url = new URL(metadata.authorization_endpoint);
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("redirect_uri", config.callbackUrl);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", config.scopes);
  url.searchParams.set("state", transaction.state);
  url.searchParams.set("nonce", transaction.nonce);
  url.searchParams.set("code_challenge", createPkceChallenge(transaction.codeVerifier));
  url.searchParams.set("code_challenge_method", "S256");
  return url;
}

async function exchangeCode(config: AuthConfig, metadata: OidcMetadata, code: string, codeVerifier: string) {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: config.callbackUrl,
    code_verifier: codeVerifier,
  });
  const encodedClient = encodeURIComponent(config.clientId);
  const encodedSecret = encodeURIComponent(config.clientSecret);

  try {
    const response = await fetch(metadata.token_endpoint, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: `Basic ${Buffer.from(`${encodedClient}:${encodedSecret}`).toString("base64")}`,
      },
      body,
      cache: "no-store",
      signal: AbortSignal.timeout(10_000),
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(`Token endpoint returned HTTP ${response.status}`);
    return tokenResponseSchema.parse(payload);
  } catch (error) {
    throw new AuthError("token_exchange_failed", "The authorization code could not be exchanged", 502, { cause: error });
  }
}

function validateAccessTokenHash(accessToken: string, tokenHash: string, algorithm: string): void {
  const bits = Number.parseInt(algorithm.slice(-3), 10);
  if (![256, 384, 512].includes(bits)) throw new Error("Unsupported ID-token hash algorithm");
  const digest = createHash(`sha${bits}`).update(accessToken, "ascii").digest();
  const expected = base64url.encode(digest.subarray(0, digest.length / 2));
  if (!constantTimeEqual(expected, tokenHash)) throw new Error("Access-token hash does not match");
}

export async function verifyIdToken(
  config: AuthConfig,
  metadata: OidcMetadata,
  idToken: string,
  accessToken: string | undefined,
  expectedNonce: string,
  verificationKey?: Parameters<typeof jwtVerify>[1],
): Promise<JWTPayload> {
  try {
    let key = verificationKey;
    if (!key) {
      let remoteKeys = jwksCache.get(metadata.jwks_uri);
      if (!remoteKeys) {
        remoteKeys = createRemoteJWKSet(new URL(metadata.jwks_uri), { timeoutDuration: 5_000, cooldownDuration: 30_000 });
        jwksCache.set(metadata.jwks_uri, remoteKeys);
      }
      key = remoteKeys;
    }
    const advertisedAlgorithms = metadata.id_token_signing_alg_values_supported?.filter((algorithm) => allowedIdTokenAlgorithms.has(algorithm));
    const algorithms = advertisedAlgorithms?.length ? advertisedAlgorithms : [...allowedIdTokenAlgorithms];
    const { payload, protectedHeader } = await jwtVerify(idToken, key, {
      issuer: config.issuer,
      audience: config.clientId,
      algorithms,
      clockTolerance: 5,
    });

    validateIdTokenClaims(payload, expectedNonce, config.clientId);
    if (typeof payload.at_hash === "string") {
      if (!accessToken) throw new Error("ID token contains at_hash without an access token");
      validateAccessTokenHash(accessToken, payload.at_hash, protectedHeader.alg);
    }
    return payload;
  } catch (error) {
    throw new AuthError("invalid_id_token", "The ID token failed signature or claim validation", 401, { cause: error });
  }
}

export function validateIdTokenClaims(payload: JWTPayload, expectedNonce: string, clientId: string): void {
  if (!payload.sub || payload.nonce !== expectedNonce) throw new Error("Subject or nonce is invalid");
  if (payload.azp && payload.azp !== clientId) throw new Error("Authorized party does not match client");
  if (Array.isArray(payload.aud) && payload.aud.length > 1 && payload.azp !== clientId) {
    throw new Error("Multi-audience token is missing the expected authorized party");
  }
}

async function fetchUserInfo(metadata: OidcMetadata, accessToken: string, expectedSubject: string): Promise<Record<string, unknown>> {
  if (!metadata.userinfo_endpoint) return {};
  try {
    const response = await fetch(metadata.userinfo_endpoint, {
      headers: { Accept: "application/json", Authorization: `Bearer ${accessToken}` },
      cache: "no-store",
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`UserInfo returned HTTP ${response.status}`);
    const profile = z.record(z.string(), z.unknown()).parse(await response.json());
    if (profile.sub !== expectedSubject) throw new Error("UserInfo subject does not match ID token");
    return profile;
  } catch (error) {
    throw new AuthError("provider_error", "The OpenID profile could not be validated", 502, { cause: error });
  }
}

function claimString(claims: Record<string, unknown>, name: string): string | undefined {
  const value = claims[name];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function profileFromClaims(config: AuthConfig, claims: Record<string, unknown>): VerifiedIdentity {
  const subject = claimString(claims, "sub");
  const email = claimString(claims, config.claims.email)?.toLowerCase();
  if (!subject) throw new AuthError("invalid_id_token", "The ID token has no usable subject", 401);
  if (!email || !z.email().safeParse(email).success) {
    throw new AuthError("missing_email", "The identity provider did not supply a usable email address", 403);
  }

  const displayName = claimString(claims, config.claims.name)
    ?? claimString(claims, "preferred_username")
    ?? email.split("@")[0];
  const avatar = claimString(claims, config.claims.avatar);

  return {
    issuer: config.issuer,
    subject,
    email,
    emailVerified: claims[config.claims.emailVerified] === true,
    displayName,
    avatarUrl: avatar && z.url().safeParse(avatar).success ? avatar : null,
  };
}

export async function completeAuthorization(
  config: AuthConfig,
  metadata: OidcMetadata,
  code: string,
  transaction: LoginTransaction,
): Promise<VerifiedIdentity> {
  const tokens = await exchangeCode(config, metadata, code, transaction.codeVerifier);
  const idClaims = await verifyIdToken(config, metadata, tokens.id_token, tokens.access_token, transaction.nonce);
  const userInfo = tokens.access_token ? await fetchUserInfo(metadata, tokens.access_token, idClaims.sub as string) : {};
  return profileFromClaims(config, { ...idClaims, ...userInfo, sub: idClaims.sub });
}

export function createProviderLogoutUrl(config: AuthConfig, metadata: OidcMetadata): URL | null {
  if (!metadata.end_session_endpoint) return null;
  const url = new URL(metadata.end_session_endpoint);
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("post_logout_redirect_uri", config.appUrl.href);
  return url;
}
