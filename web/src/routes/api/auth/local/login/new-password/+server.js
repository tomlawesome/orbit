import { sessionCookieName, setSessionCookie } from "orbit/lib/auth/cookies";
import { AuthError, PasswordChangeRequiredError } from "orbit/lib/auth/errors";
import { authErrorResponse } from "orbit/lib/auth/http";
import { checkPasswordBounds, hashPassword, MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH } from "orbit/lib/auth/password";
import { clearPasswordChangeCookie, issuePasswordChangeHold, openPasswordChangeHold } from "orbit/lib/auth/password-change-hold";
import { assertSameOrigin, createSession, deleteSessionToken } from "orbit/lib/auth/session";
import { VerificationGateRefusedError } from "orbit/lib/auth/verification-gate";
import { getAuthConfig } from "orbit/lib/env";
import { assertNotRefusedPassword, completePasswordRenewal } from "orbit/server/local-credentials";

import { api } from "$lib/server/api.js";

/**
 * Saves the new password a refused sign-in made necessary, and only then
 * signs the reader in (#1881, ADR-0027 amendment of 2026-11-17).
 *
 * Signed out by design: THE HOLD COOKIE IS THE WHOLE AUTHORISATION. It was
 * set by a sign-in that passed every check a sign-in asks (the password and
 * the emailed approval, or the provider) on an account whose password a
 * "This wasn't me" had marked, and it lets this browser do one thing: this.
 * So the route takes the bare wrapper and asserts same-origin, as the other
 * signed-out writes do.
 *
 * The checks, in the order a reader can fix them: the two entries agree; the
 * password is inside ADR-0021 §6's bounds (the setup route's own rule and
 * words); and it is not the refused one. Every refusal leaves the hold as it
 * was -- standing, and lapsing when it always would.
 *
 * Saving is ADR-0023 §7's password change: under the credential's row lock
 * the mark is checked to be the one this hold was issued for, the hash
 * written and the mark cleared in the same statement, every session the
 * account held revoked and `password_changed` recorded. Then, and only then,
 * a session is minted for this browser.
 */
/** @param {Record<string, unknown>} payload */
function answer(payload) {
  return new Response(
    JSON.stringify(payload),
    { status: 200, headers: { "content-type": "application/json", "cache-control": "no-store" } },
  );
}

export const POST = api(
  async (event) => {
    const config = getAuthConfig();
    assertSameOrigin(event.request.headers, config);

    const hold = await openPasswordChangeHold(event.cookies, config);

    /** @type {Record<string, unknown>} */
    let body = {};
    try {
      const parsed = await event.request.json();
      if (parsed && typeof parsed === "object") body = /** @type {Record<string, unknown>} */ (parsed);
    } catch {
      // A malformed body is answered by the field checks below.
    }
    const field = (/** @type {string} */ name) => (typeof body[name] === "string" ? String(body[name]) : "");
    const password = field("password");
    const passwordAgain = field("passwordAgain");

    if (password !== passwordAgain || passwordAgain.length === 0) {
      throw new AuthError("password_mismatch", "The two passwords are not the same", 400);
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
    await assertNotRefusedPassword(hold.userId, password);

    let passwordHash;
    try {
      passwordHash = await hashPassword(password);
    } catch (error) {
      if (error instanceof VerificationGateRefusedError) {
        throw new AuthError("too_many_attempts", "Too many attempts at once; try again shortly", 429);
      }
      throw error;
    }

    await completePasswordRenewal(hold.userId, hold.requiredAt, passwordHash, password);

    /* Saved. The hold stays until a session exists (#1901 ruling 1): a mint
       that fails leaves this browser either a fresh hold or a plain "sign in
       with it", never a lost hold and no session. The save stands and is
       reported, as the password route reports it. */
    await deleteSessionToken(event.cookies.get(sessionCookieName(config)));
    let session;
    try {
      session = await createSession(hold.userId, config, event.request.headers.get("user-agent"));
    } catch (error) {
      if (error instanceof PasswordChangeRequiredError) {
        /* A refusal re-marked the account between the save and the mint.
           The fresh hold keeps this one's lapse (#1943 SEC-H2): a re-issue
           only ever shortens a hold, never extends it. */
        const fresh = await issuePasswordChangeHold(event.cookies, error, config, hold.lapsesAt);
        return answer({ saved: true, state: "password_change_required", refusedAt: fresh.refusedAt });
      }
      /* Anything else: the password is saved, the reader signs in with it.
         Nothing about the failure is told. */
      clearPasswordChangeCookie(event.cookies, config);
      return answer({ saved: true, state: "sign_in_again" });
    }
    clearPasswordChangeCookie(event.cookies, config);
    setSessionCookie(event.cookies, session.token, config);

    return answer({ authenticated: true });
  },
  { errorResponse: authErrorResponse },
);
