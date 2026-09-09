import { setTransactionCookie } from "orbit/lib/auth/cookies";
import { randomUrlSafe, safeReturnPath, sealLoginTransaction } from "orbit/lib/auth/crypto";
import { AuthError } from "orbit/lib/auth/errors";
import { authErrorResponse } from "orbit/lib/auth/http";
import { createAuthorizationUrl, discoverProvider } from "orbit/lib/auth/oidc";
import { isStepUpIntent } from "orbit/lib/auth/recent-auth";
import { getAuthConfig } from "orbit/lib/env";

import { write } from "$lib/server/api.js";

/**
 * Starts an OIDC step-up (ADR-0023 §5).
 *
 * This is the challenge for someone who has no password: the browser goes back
 * to the provider with `max_age=0` — authenticate this person again, now — and
 * the callback turns a fresh `auth_time` into the short-lived proof that
 * `requireRecentAuthentication` will accept once.
 *
 * Session and CSRF only: no recent-authentication guard, because this IS the
 * challenge. What it cannot be talked into is proving something else — the
 * intent is checked against the closed list here and sealed into the
 * transaction, so the proof that comes back is good for that action and that
 * session and nothing else.
 *
 * The 302 is built by hand for the same reason `GET /api/auth/login` builds
 * its own: SvelteKit's `redirect()` signals by throwing, and the wrapper would
 * render that as an error.
 */
export const POST = write(
  async (event, session) => {
    const config = getAuthConfig();
    if (!config.oidc) {
      throw new AuthError("auth_not_configured", "OpenID Connect sign-in is not configured on this instance", 503);
    }

    /** @type {Record<string, unknown>} */
    let body = {};
    try {
      const parsed = await event.request.json();
      if (parsed && typeof parsed === "object") body = /** @type {Record<string, unknown>} */ (parsed);
    } catch {
      // A malformed body is answered by the intent check below.
    }
    const intent = body.intent;
    if (!isStepUpIntent(intent)) {
      throw new AuthError("invalid_request", "The step-up request names no known action", 400);
    }

    const metadata = await discoverProvider(config.oidc);

    const transaction = {
      state: randomUrlSafe(),
      nonce: randomUrlSafe(),
      codeVerifier: randomUrlSafe(),
      returnTo: safeReturnPath(typeof body.returnTo === "string" ? body.returnTo : null),
      stepUpSessionId: session.id,
      intent,
      maxAge: 0,
    };
    setTransactionCookie(event.cookies, await sealLoginTransaction(transaction, config), config);

    return new Response(null, {
      status: 302,
      headers: {
        location: createAuthorizationUrl(config.oidc, metadata, transaction).href,
        "cache-control": "no-store",
      },
    });
  },
  { errorResponse: authErrorResponse },
);
