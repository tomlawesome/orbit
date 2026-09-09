import { clearClaimCookie, hasClaimProof, isClaimed } from "orbit/lib/auth/bootstrap";
import { sessionCookieName, setSessionCookie } from "orbit/lib/auth/cookies";
import { AuthError } from "orbit/lib/auth/errors";
import { authErrorResponse } from "orbit/lib/auth/http";
import { checkPasswordBounds, hashPassword, MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH } from "orbit/lib/auth/password";
import { assertSameOrigin, createSession, deleteSessionToken } from "orbit/lib/auth/session";
import { VerificationGateRefusedError } from "orbit/lib/auth/verification-gate";
import { getAuthConfig } from "orbit/lib/env";
import { createLocalUser } from "orbit/server/local-credentials";

import { api } from "$lib/server/api.js";

/**
 * Creates the first administrator with a password (ADR-0022 §2).
 *
 * The claim cookie is the whole authorisation: it is minted only by
 * `POST /api/auth/bootstrap/claim`, only for a browser that presented the code
 * printed in the container's log, and it is good for five minutes. Signed out
 * by design — nobody has an account yet — so this takes the bare wrapper and
 * asserts same-origin, exactly as the claim route does.
 *
 * Whether the instance is already claimed is decided by state, never by the
 * cookie: a cookie that survived somebody else's claim buys nothing.
 *
 * The response carries a session, so the new administrator lands on the
 * first-run journey signed in rather than being asked for the password they
 * have just chosen.
 */
export const POST = api(
  async (event) => {
    const config = getAuthConfig();
    assertSameOrigin(event.request.headers, config);

    if (await isClaimed()) {
      throw new AuthError("bootstrap_claimed", "This Orbit instance has already been claimed", 409);
    }
    if (!(await hasClaimProof(event.cookies, config))) {
      throw new AuthError("bootstrap_required", "This Orbit instance has not been claimed yet", 403);
    }

    /** @type {Record<string, unknown>} */
    let body = {};
    try {
      const parsed = await event.request.json();
      if (parsed && typeof parsed === "object") body = /** @type {Record<string, unknown>} */ (parsed);
    } catch {
      // A malformed body is answered by the field checks below.
    }
    const field = (/** @type {string} */ name) => (typeof body[name] === "string" ? String(body[name]) : "");
    const email = field("email");
    const displayName = field("displayName");
    const password = field("password");

    /* Cheap refusals first, so an obviously incomplete form does not spend a
       64 MiB derivation before being told which field is missing. */
    if (email.trim().length === 0 || displayName.trim().length === 0) {
      throw new AuthError("invalid_request", "Enter an email address and a name", 400);
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
      /* The verification gate is saturated (ADR-0021 §4). Same generic answer
         as the sign-in backoff: a refusal costs a request and says nothing. */
      if (error instanceof VerificationGateRefusedError) {
        throw new AuthError("too_many_attempts", "Too many attempts at once; try again shortly", 429);
      }
      throw error;
    }

    const user = await createLocalUser({ email, displayName, passwordHash }, { bootstrap: true });

    // A successful claim replaces whatever session the browser was holding,
    // exactly as the OIDC callback does.
    await deleteSessionToken(event.cookies.get(sessionCookieName(config)));
    const session = await createSession(user.id, config, event.request.headers.get("user-agent"));
    clearClaimCookie(event.cookies, config);
    setSessionCookie(event.cookies, session.token, config);

    return new Response(
      JSON.stringify({ claimed: true }),
      { status: 201, headers: { "content-type": "application/json", "cache-control": "no-store" } },
    );
  },
  { errorResponse: authErrorResponse },
);
