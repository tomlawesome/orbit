import { hasClaimProof, isClaimed } from "orbit/lib/auth/bootstrap";
import { AuthError } from "orbit/lib/auth/errors";
import { authErrorResponse } from "orbit/lib/auth/http";
import { setTransactionCookie } from "orbit/lib/auth/cookies";
import { randomUrlSafe, safeReturnPath, sealLoginTransaction } from "orbit/lib/auth/crypto";
import { createAuthorizationUrl, discoverProvider } from "orbit/lib/auth/oidc";
import { getAuthConfig } from "orbit/lib/env";

import { api } from "$lib/server/api.js";

/**
 * Starts the OIDC authorization-code flow (#735 port).
 *
 * Signed out by design — this is what a caller with no session hits — so it
 * takes the bare wrapper rather than `read()`.
 *
 * The redirect is built by hand rather than through SvelteKit's `redirect()`
 * helper, which signals by throwing: the wrapper would catch it and render it
 * as an error. Constructing the Response also keeps the status exact, and 302
 * here is not interchangeable with 303.
 *
 * `event.cookies.set` still reaches this response — SvelteKit applies cookie
 * writes to whatever the handler returns.
 */
export const GET = api(
  async (event) => {
    const config = getAuthConfig();
    if (!config.oidc) {
      throw new AuthError("auth_not_configured", "OpenID Connect sign-in is not configured on this instance", 503);
    }
    /* While the instance is unclaimed the provider is unreachable without the
       claim cookie (ADR-0022 §2): the first sign-in is what creates the first
       administrator, so anyone who can start it can seize the instance. The
       claim travels on into the sealed transaction, which is how the callback
       learns it from a value the browser cannot forge. */
    const claimed = await isClaimed();
    if (!claimed && !(await hasClaimProof(event.cookies, config))) {
      throw new AuthError("bootstrap_required", "This Orbit instance has not been claimed yet", 403);
    }

    const metadata = await discoverProvider(config.oidc);

    /* State, nonce and verifier are generated per attempt and sealed into the
       transaction cookie, so a replayed callback cannot be matched against a
       transaction the browser never started. */
    const transaction = {
      state: randomUrlSafe(),
      nonce: randomUrlSafe(),
      codeVerifier: randomUrlSafe(),
      returnTo: safeReturnPath(event.url.searchParams.get("returnTo")),
      ...(claimed ? {} : { bootstrap: true }),
    };
    const sealedTransaction = await sealLoginTransaction(transaction, config);

    setTransactionCookie(event.cookies, sealedTransaction, config);

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
