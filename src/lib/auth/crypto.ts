import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { EncryptJWT, base64url, jwtDecrypt } from "jose";
import type { AuthConfig } from "@/lib/env";
import { AuthError } from "@/lib/auth/errors";

const TRANSACTION_ISSUER = "orbit";
const TRANSACTION_AUDIENCE = "oidc-login-transaction";
const LOGIN_TRANSACTION_TTL_SECONDS = 600;

export interface LoginTransaction {
  state: string;
  nonce: string;
  codeVerifier: string;
  returnTo: string;
  /**
   * Set only by `GET /api/auth/login` while the instance is unclaimed and the
   * caller presented a valid claim cookie (ADR-0022 §2). The callback learns
   * the claim from this sealed value rather than from anything the browser can
   * write, so a returning provider response cannot promote itself.
   */
  bootstrap?: boolean;
  /**
   * Set only by `POST /api/auth/step-up/start` (ADR-0023 §5): the id of the
   * session being re-challenged, and what it is being re-challenged for. The
   * callback mints a proof bound to exactly this pair, so a step-up taken for
   * one action on one session cannot be spent on another.
   */
  stepUpSessionId?: string;
  intent?: string;
  /**
   * Set only by `POST /api/auth/link/oidc/start` (ADR-0023 §6): the id of the
   * user the returning identity is to be linked to. It is sealed here, by the
   * route that already checked the session and re-challenged the person, so
   * the callback binds the new `external_identities` row to that user and
   * never to anything on the request — a link target a browser could write
   * would let a returning provider response attach an identity to somebody
   * else's account.
   */
  linkUserId?: string;
  /**
   * The `max_age` the authorization request carries. A step-up sends `0`,
   * which asks the provider to authenticate the person again now; its
   * presence is also what turns on the `auth_time` freshness rule in
   * `validateIdTokenClaims`.
   */
  maxAge?: number;
}

/**
 * What the callback should do with a transaction it has just opened. Slice 5
 * lands `login` and `bootstrap`, slice 7 `step-up`, slice 10 `link`
 * (ADR-0023 §6), so the decision stays in one function rather than spreading
 * across route bodies.
 */
export type LoginTransactionKind = "login" | "bootstrap" | "step-up" | "link";

export function transactionKind(transaction: LoginTransaction): LoginTransactionKind {
  if (transaction.bootstrap === true) return "bootstrap";
  if (typeof transaction.stepUpSessionId === "string" && transaction.stepUpSessionId.length > 0) return "step-up";
  /* A link is decided after the step-up, so a transaction carrying both halves
     is a step-up: proving who you are can never quietly attach an identity. No
     route seals both, and this is what keeps that true if one ever tries. */
  if (typeof transaction.linkUserId === "string" && transaction.linkUserId.length > 0) return "link";
  return "login";
}

export function randomUrlSafe(byteLength = 32): string {
  return base64url.encode(randomBytes(byteLength));
}

export function createPkceChallenge(codeVerifier: string): string {
  return base64url.encode(createHash("sha256").update(codeVerifier, "ascii").digest());
}

export function hashSessionToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function createCsrfToken(sessionToken: string, secret: string): string {
  return base64url.encode(createHmac("sha256", secret).update(`csrf:${sessionToken}`, "utf8").digest());
}

export function constantTimeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function transactionKey(secret: string): Uint8Array {
  return createHash("sha256").update(`oidc-transaction:${secret}`, "utf8").digest();
}

/**
 * The generic short-lived proof (ADR-0022 §1): a JWE sealed under
 * `SESSION_SECRET` with a fixed issuer and a caller-chosen audience, which is
 * the extension point every other short-lived proof hangs off — the login
 * transaction below, the claim cookie (`bootstrap-claim`), and later the
 * step-up proof. The audience is what keeps them from being interchangeable:
 * a value sealed for one is refused by every other opener.
 *
 * Nothing secret should be put in a payload: it is encrypted, but it travels
 * in a cookie, and a proof exists to say a check already passed.
 */
export async function sealProof(
  payload: Record<string, unknown>,
  audience: string,
  ttlSeconds: number,
  config: AuthConfig,
): Promise<string> {
  return new EncryptJWT({ ...payload })
    .setProtectedHeader({ alg: "dir", enc: "A256GCM" })
    .setIssuer(TRANSACTION_ISSUER)
    .setAudience(audience)
    .setIssuedAt()
    .setExpirationTime(`${ttlSeconds}s`)
    .encrypt(transactionKey(config.sessionSecret));
}

/**
 * Opens a proof sealed by {@link sealProof} for exactly this audience.
 * Throws the underlying `jose` error; each caller decides what its own
 * failure means, because "expired claim cookie" and "forged login
 * transaction" are not the same answer to a browser.
 */
export async function openProof(
  value: string,
  audience: string,
  config: AuthConfig,
): Promise<Record<string, unknown>> {
  const { payload } = await jwtDecrypt(value, transactionKey(config.sessionSecret), {
    issuer: TRANSACTION_ISSUER,
    audience,
    clockTolerance: 5,
  });
  return payload as Record<string, unknown>;
}

export async function sealLoginTransaction(transaction: LoginTransaction, config: AuthConfig): Promise<string> {
  return sealProof({ ...transaction }, TRANSACTION_AUDIENCE, LOGIN_TRANSACTION_TTL_SECONDS, config);
}

export async function openLoginTransaction(value: string, config: AuthConfig): Promise<LoginTransaction> {
  try {
    const payload = await openProof(value, TRANSACTION_AUDIENCE, config);
    const fields = [payload.state, payload.nonce, payload.codeVerifier, payload.returnTo];
    if (!fields.every((field) => typeof field === "string" && field.length > 0)) {
      throw new Error("Login transaction claims are incomplete");
    }
    return {
      state: payload.state as string,
      nonce: payload.nonce as string,
      codeVerifier: payload.codeVerifier as string,
      returnTo: payload.returnTo as string,
      /* Only the literal `true` carries; anything else is absent, so a
         transaction sealed without a claim can never open as one. */
      ...(payload.bootstrap === true ? { bootstrap: true } : {}),
      /* Same rule for the step-up fields: each one carries only when it has
         the type this process sealed, so a partially-formed payload opens as
         an ordinary login rather than as a step-up with a missing half. */
      ...(typeof payload.stepUpSessionId === "string" && payload.stepUpSessionId.length > 0
        ? { stepUpSessionId: payload.stepUpSessionId }
        : {}),
      ...(typeof payload.intent === "string" && payload.intent.length > 0 ? { intent: payload.intent } : {}),
      ...(typeof payload.linkUserId === "string" && payload.linkUserId.length > 0
        ? { linkUserId: payload.linkUserId }
        : {}),
      ...(typeof payload.maxAge === "number" && Number.isFinite(payload.maxAge) ? { maxAge: payload.maxAge } : {}),
    };
  } catch (error) {
    throw new AuthError("invalid_state", "The sign-in transaction is invalid or has expired", 400, { cause: error });
  }
}

export function safeReturnPath(value: string | null): string {
  // A leading "\" is normalized to "/" by WHATWG URL parsing on special schemes,
  // so "/\evil.com" resolves to the external origin "https://evil.com/" once
  // joined with appUrl in the callback route. Backslashes have no legitimate use
  // in an application-relative path, so any occurrence is rejected outright.
  if (!value || !value.startsWith("/") || value.startsWith("//") || /[\u0000-\u001f\\]/.test(value)) return "/";
  return value;
}
