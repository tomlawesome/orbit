import {
  clearTransactionCookie,
  sessionCookieName,
  setSessionCookie,
  transactionCookieName,
} from "orbit/lib/auth/cookies";
import { clearClaimCookie } from "orbit/lib/auth/bootstrap";
import { constantTimeEqual, openLoginTransaction, transactionKind } from "orbit/lib/auth/crypto";
import { AuthError, asAuthError } from "orbit/lib/auth/errors";
import { authErrorResponse } from "orbit/lib/auth/http";
import { reportAuthCallbackFailure } from "orbit/lib/auth/observability";
import { completeAuthorization, discoverProvider } from "orbit/lib/auth/oidc";
import { provisionIdentity } from "orbit/lib/auth/provision";
import { completeStepUp, isStepUpIntent, setStepUpProofCookie } from "orbit/lib/auth/recent-auth";
import { createSession, deleteSessionToken } from "orbit/lib/auth/session";
import { getAuthConfig } from "orbit/lib/env";
import { readInvitationCookie } from "orbit/server/invitations/cookie";

/**
 * Where the identity provider sends the browser back (#735 port).
 *
 * Not wrapped by `api()`: a failure here must land the person on Orbit's own
 * error screen with the transaction cookie cleared, not on a JSON envelope.
 * That is what `callbackFailure` does, and it is why this file handles its
 * own errors.
 *
 * This is also the route nothing in `web/` fetches — the provider calls it,
 * so a scan of what the front end requests does not see it. It is the
 * operator-registered redirect URI, it is `OIDC_CALLBACK_PATH` in the config
 * contract, and the transaction cookie is scoped to exactly this path.
 *
 * @param {unknown} error
 * @param {import("orbit/lib/env").AuthConfig} config
 * @param {import("@sveltejs/kit").RequestEvent} event
 * @returns {Response}
 */
function callbackFailure(error, config, event) {
  const authError = asAuthError(error);
  reportAuthCallbackFailure(authError.code, authError.tokenExchangeReason);
  const target = new URL("/auth/error", config.appUrl);
  target.searchParams.set("code", authError.code);
  clearTransactionCookie(event.cookies, config);
  return new Response(null, {
    status: 303,
    headers: { location: target.href, "cache-control": "no-store" },
  });
}

export async function GET(event) {
  /** @type {import("orbit/lib/env").AuthConfig} */
  let config;
  try {
    config = getAuthConfig();
  } catch (error) {
    /* No config means no error screen to redirect to, so this one case
       answers in the JSON envelope instead. */
    return authErrorResponse(error);
  }

  try {
    if (!config.oidc) {
      throw new AuthError("auth_not_configured", "OpenID Connect sign-in is not configured on this instance", 503);
    }

    const providerError = event.url.searchParams.get("error");
    if (providerError) {
      throw new AuthError("provider_error", "The identity provider declined the sign-in request", 401);
    }

    const code = event.url.searchParams.get("code");
    const returnedState = event.url.searchParams.get("state");
    const transactionCookie = event.cookies.get(transactionCookieName(config));
    if (!code || !returnedState || !transactionCookie) {
      throw new AuthError("invalid_request", "The authorization response is incomplete", 400);
    }

    const transaction = await openLoginTransaction(transactionCookie, config);
    /* Constant-time, because a timing-distinguishable state comparison is how
       an attacker searches for a valid one. */
    if (!constantTimeEqual(returnedState, transaction.state)) {
      throw new AuthError("invalid_state", "The authorization state does not match", 400);
    }

    const metadata = await discoverProvider(config.oidc);
    const identity = await completeAuthorization(config.oidc, metadata, code, transaction);

    /* What the provider's answer is FOR is decided by the transaction this
       process sealed, never by anything on the request (ADR-0022 §2). Slice 5
       lands two kinds and slice 7 the step-up; the link branch (ADR-0023 §6)
       adds its own case here and its own kind in `transactionKind`. */
    const kind = transactionKind(transaction);
    let user;
    switch (kind) {
      case "step-up": {
        /* A step-up proves the person is still there. It signs nobody in,
           creates nothing and links nothing: it mints the two-minute proof the
           action will consume, and sends the browser back to the action
           (ADR-0023 §5). A stale or missing `auth_time` has already been
           refused by `completeAuthorization` as `step_up_failed`, and lands on
           the error screen with no proof and the action still blocked. */
        if (!isStepUpIntent(transaction.intent)) {
          throw new AuthError("invalid_state", "The sign-in transaction is invalid or has expired", 400);
        }
        const proof = await completeStepUp({
          identity,
          sessionId: /** @type {string} */ (transaction.stepUpSessionId),
          intent: transaction.intent,
          config,
        });
        clearTransactionCookie(event.cookies, config);
        setStepUpProofCookie(event.cookies, proof, config);
        return new Response(null, {
          status: 303,
          headers: {
            location: new URL(transaction.returnTo, config.appUrl).href,
            "cache-control": "no-store",
          },
        });
      }
      case "bootstrap":
        /* The claim: this sign-in creates the first administrator and seats
           the instance's primary administrator. A racing claimant that loses
           the lock is refused with `bootstrap_claimed` and creates nothing. */
        user = await provisionIdentity(identity, { bootstrap: true });
        clearClaimCookie(event.cookies, config);
        break;
      case "login":
        user = await provisionIdentity(identity);
        break;
      default:
        throw new AuthError("invalid_state", "The sign-in transaction is invalid or has expired", 400);
    }
    if (user.disabledAt) {
      throw new AuthError("account_disabled", "This Orbit account is disabled", 403);
    }

    // A successful login always replaces the browser's previous session.
    await deleteSessionToken(event.cookies.get(sessionCookieName(config)));
    const session = await createSession(user.id, config, event.request.headers.get("user-agent"));

    clearTransactionCookie(event.cookies, config);
    setSessionCookie(event.cookies, session.token, config);

    /* #481: a sign-in that STARTED from an invitation goes back to the
       invitation, which is the one place redemption is written. The token is
       read from Orbit's own HTTP-only cookie rather than from `returnTo`,
       because returnTo comes off a query string a stranger can write and this
       cookie is only ever set after the invitation was found and found open.
       The invite screen clears it, whatever the outcome. */
    const pendingInvitation = readInvitationCookie(event.cookies, config);
    const destination = pendingInvitation
      ? new URL(`/invite/${encodeURIComponent(pendingInvitation)}`, config.appUrl)
      : new URL(transaction.returnTo, config.appUrl);

    return new Response(null, {
      status: 303,
      headers: {
        location: destination.href,
        "cache-control": "no-store",
      },
    });
  } catch (error) {
    return callbackFailure(error, config, event);
  }
}
