import {
  clearPendingSignInCookie,
  sessionCookieName,
  setPendingSignInCookie,
  setSessionCookie,
} from "orbit/lib/auth/cookies";
import { AuthError } from "orbit/lib/auth/errors";
import { authErrorResponse } from "orbit/lib/auth/http";
import { assertSameOrigin, createSession, deleteSessionToken } from "orbit/lib/auth/session";
import { getAuthConfig } from "orbit/lib/env";
import { verifyCredential } from "orbit/server/local-credentials";
import {
  SIGN_IN_APPROVAL_TTL_MS,
  secondFactorConfigured,
  startSignInApproval,
} from "orbit/server/sign-in-approvals";

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
 * OIDC callback does -- when there is one to replace it with. Since #1033 the
 * ordinary answer to a correct password is a PENDING sign-in rather than a
 * session (ADR-0027 §1): the reader is mailed an approval link and this tab
 * waits. The session is minted by `login/pending` once somebody has pressed
 * Approve, so the only way past this route is through a mailbox.
 *
 * The factor is off as a whole, and only as a whole, when the instance has no
 * mail relay configured (ADR-0027 §2) -- an instance that cannot send has no
 * way to ask, and locking every password out of it would be worse than the
 * door it already has. There is no per-user switch and no remembered browser.
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
    /* The instance holds no usable encryption key, so no address can be
       matched at all (#969). Told apart from a wrong password deliberately:
       flattening it into `credentials_invalid` below would send an operator
       whose key is missing looking for a fault in their own password. It
       names no account and is true before any comparison happens, so it
       gives away nothing the generic answer protects. */
    if (verdict.outcome === "locked") {
      throw new AuthError(
        "instance_locked",
        "This Orbit instance cannot sign anybody in until its encryption key is available",
        503,
      );
    }
    if (verdict.outcome !== "verified") {
      throw new AuthError("credentials_invalid", INVALID_MESSAGE, 401);
    }

    await deleteSessionToken(event.cookies.get(sessionCookieName(config)));

    if (secondFactorConfigured()) {
      /* The address the approval is judged on. SvelteKit's own
         `getClientAddress` is the whole of it: Orbit ships fronted by nothing
         (docker-compose.yml publishes the app's port directly), so there is no
         proxy-trust convention to honour and no forwarded-for header this
         instance has any reason to believe. An operator who puts a proxy in
         front of Orbit will need that convention before the address on the
         approval page means what it says. */
      let clientAddress = null;
      try {
        clientAddress = event.getClientAddress();
      } catch {
        /* An adapter that cannot say is answered by the page's own wording for
           an address it could not read, never by a guess. */
        clientAddress = null;
      }
      const pending = await startSignInApproval(verdict.userId, {
        userAgent: event.request.headers.get("user-agent"),
        clientAddress,
      });
      setPendingSignInCookie(event.cookies, pending.claim, config, Math.floor(SIGN_IN_APPROVAL_TTL_MS / 1000));

      /* Deliberately bounded: whether a link is waiting, when it lapses, and
         when this tab may ask for another. Never the address it went to, and
         never the link. `limited` is ADR-0027 §8's "check the mail we already
         sent" and is the one thing the card says differently. */
      return new Response(
        JSON.stringify({
          authenticated: false,
          pending: {
            expiresAt: pending.expiresAt.toISOString(),
            canResendAt: pending.canResendAt.toISOString(),
            limited: pending.limited,
          },
        }),
        { status: 200, headers: { "content-type": "application/json", "cache-control": "no-store" } },
      );
    }

    /* No relay, so no factor: the password is the whole of the sign-in, and
       this is the route as it stood before #1033. */
    clearPendingSignInCookie(event.cookies, config);
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
