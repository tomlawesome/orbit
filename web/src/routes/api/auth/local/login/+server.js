import { sessionCookieName, setSessionCookie } from "orbit/lib/auth/cookies";
import { AuthError } from "orbit/lib/auth/errors";
import { authErrorResponse } from "orbit/lib/auth/http";
import { assertSameOrigin, createSession, deleteSessionToken } from "orbit/lib/auth/session";
import { getAuthConfig } from "orbit/lib/env";
import { verifyCredential } from "orbit/server/local-credentials";

import { api } from "$lib/server/api.js";

/**
 * Signs a local user in with an email address and a password (ADR-0023 §4).
 *
 * Signed out by design, so it takes the bare wrapper and asserts same-origin;
 * there is no session yet for a CSRF token to be derived from.
 *
 * There are exactly two failures. `credentials_invalid` answers an unknown
 * address, a wrong password, a disabled account and an account with no
 * password — one status, one body, one derivation's worth of time, so nobody
 * can ask this route whether an address has an Orbit account.
 * `too_many_attempts` answers the persisted per-credential backoff and a
 * saturated verification gate. Neither carries a field name, a count or a
 * remaining-time hint, because each of those would be the same question asked
 * more politely.
 *
 * A successful sign-in replaces the browser's previous session exactly as the
 * OIDC callback does.
 */
const INVALID_MESSAGE = "That email address and password do not match an Orbit account";

export const POST = api(
  async (event) => {
    const config = getAuthConfig();
    assertSameOrigin(event.request.headers, config);

    /** @type {Record<string, unknown>} */
    let body = {};
    try {
      const parsed = await event.request.json();
      if (parsed && typeof parsed === "object") body = /** @type {Record<string, unknown>} */ (parsed);
    } catch {
      /* A malformed body is a failed sign-in, answered exactly like one: the
         empty strings below still cost the decoy derivation, so a probe cannot
         be told apart from a genuine attempt by how long it took. */
    }
    const field = (/** @type {string} */ name) => (typeof body[name] === "string" ? String(body[name]) : "");

    const verdict = await verifyCredential(field("email"), field("password"));
    if (verdict.outcome === "throttled") {
      throw new AuthError("too_many_attempts", "Too many sign-in attempts; try again shortly", 429);
    }
    if (verdict.outcome !== "verified") {
      throw new AuthError("credentials_invalid", INVALID_MESSAGE, 401);
    }

    await deleteSessionToken(event.cookies.get(sessionCookieName(config)));
    let session;
    try {
      session = await createSession(verdict.userId, config, event.request.headers.get("user-agent"));
    } catch (error) {
      /* The account was disabled between the verification and this insert.
         `verifyCredential` already answers a disabled account generically, so
         the race must answer the same way rather than reveal what happened. */
      if (error instanceof AuthError && error.code === "account_disabled") {
        throw new AuthError("credentials_invalid", INVALID_MESSAGE, 401);
      }
      throw error;
    }
    setSessionCookie(event.cookies, session.token, config);

    return new Response(
      JSON.stringify({ authenticated: true }),
      { status: 200, headers: { "content-type": "application/json", "cache-control": "no-store" } },
    );
  },
  { errorResponse: authErrorResponse },
);
