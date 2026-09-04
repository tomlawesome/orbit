import {
  clearTransactionCookie,
  sessionCookieName,
  setSessionCookie,
  transactionCookieName,
} from "orbit/lib/auth/cookies";
import { constantTimeEqual, openLoginTransaction } from "orbit/lib/auth/crypto";
import { AuthError, asAuthError } from "orbit/lib/auth/errors";
import { authErrorResponse } from "orbit/lib/auth/http";
import { reportAuthCallbackFailure } from "orbit/lib/auth/observability";
import { completeAuthorization, discoverProvider } from "orbit/lib/auth/oidc";
import { provisionIdentity } from "orbit/lib/auth/provision";
import { createSession, deleteSessionToken } from "orbit/lib/auth/session";
import { getAuthConfig } from "orbit/lib/env";

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

    const metadata = await discoverProvider(config);
    const identity = await completeAuthorization(config, metadata, code, transaction);
    const user = await provisionIdentity(identity);
    if (user.disabledAt) {
      throw new AuthError("account_disabled", "This Orbit account is disabled", 403);
    }

    // A successful login always replaces the browser's previous session.
    await deleteSessionToken(event.cookies.get(sessionCookieName(config)));
    const session = await createSession(user.id, config);

    clearTransactionCookie(event.cookies, config);
    setSessionCookie(event.cookies, session.token, config);

    return new Response(null, {
      status: 303,
      headers: {
        location: new URL(transaction.returnTo, config.appUrl).href,
        "cache-control": "no-store",
      },
    });
  } catch (error) {
    return callbackFailure(error, config, event);
  }
}
