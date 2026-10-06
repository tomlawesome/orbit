import { sessionCookieName, setSessionCookie } from "orbit/lib/auth/cookies";
import { AuthError } from "orbit/lib/auth/errors";
import { authErrorResponse } from "orbit/lib/auth/http";
import { checkPasswordBounds, hashPassword, MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH } from "orbit/lib/auth/password";
import { assertSameOrigin, createSession, deleteSessionToken } from "orbit/lib/auth/session";
import { VerificationGateRefusedError } from "orbit/lib/auth/verification-gate";
import { getAuthConfig } from "orbit/lib/env";
import { consumeSetupToken } from "orbit/server/local-credentials";

import { api } from "$lib/server/api.js";

/**
 * Spends a setup or recovery link and signs the new password's owner in
 * (ADR-0023 §3). Signed out by design — the token in the body is the whole
 * authorisation, exactly as the invitation redemption route works — so this
 * takes the bare wrapper and asserts same-origin.
 *
 * An unknown, already-consumed or expired token is the one generic
 * `setup_token_invalid`: nothing here tells a caller which of the three it
 * was, for the same reason a sign-in failure names no field.
 *
 * A `recovery` token replaces an existing password, so `consumeSetupToken`
 * has already revoked every session that account held by the time this
 * creates the new one (ADR-0023 §7) — the same rule a signed-in password
 * change follows, because setting a new password after losing the old one is
 * a password change. A `setup` token has no prior credential and ordinarily
 * no prior session to revoke.
 */
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
      // A malformed body is answered by the field checks below.
    }
    const field = (/** @type {string} */ name) => (typeof body[name] === "string" ? String(body[name]) : "");
    const token = field("token");
    const password = field("password");

    if (token.length === 0) {
      throw new AuthError("setup_token_invalid", "This setup link is no longer valid", 400);
    }
    const rejection = checkPasswordBounds(password);
    if (rejection) {
      throw new AuthError(
        "password_rejected",
        rejection === "too_short"
          ? `Use a password of at least ${MIN_PASSWORD_LENGTH} characters`
          : `Use a password of at most ${MAX_PASSWORD_LENGTH} characters`,
        400,
      );
    }

    let passwordHash;
    try {
      passwordHash = await hashPassword(password);
    } catch (error) {
      if (error instanceof VerificationGateRefusedError) {
        throw new AuthError("too_many_attempts", "Too many attempts at once; try again shortly", 429);
      }
      throw error;
    }

    const consumed = await consumeSetupToken(token, passwordHash);

    /* Kills whatever session THIS browser held, which may belong to a
       different account than the one the token names; `consumeSetupToken`
       already revoked every session the token's own owner held. */
    await deleteSessionToken(event.cookies.get(sessionCookieName(config)));
    const session = await createSession(consumed.userId, config, event.request.headers.get("user-agent"));
    setSessionCookie(event.cookies, session.token, config);

    return new Response(
      JSON.stringify({ authenticated: true }),
      { status: 200, headers: { "content-type": "application/json", "cache-control": "no-store" } },
    );
  },
  { errorResponse: authErrorResponse },
);
