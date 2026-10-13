import { json } from "@sveltejs/kit";

import { clearSessionCookie } from "orbit/lib/auth/cookies";
import { safeReturnPath } from "orbit/lib/auth/crypto";
import { authErrorResponse } from "orbit/lib/auth/http";
import { createProviderLogoutUrl, discoverProvider } from "orbit/lib/auth/oidc";
import { assertCsrf, assertSameOrigin, deleteSessionToken, readSession } from "orbit/lib/auth/session";
import { getAuthConfig } from "orbit/lib/env";

import { api } from "$lib/server/api.js";

/**
 * Ends the session here, then hands off to the provider (#735 port).
 *
 * Not `write()`, because signing out has to work from a session that is
 * already broken: with a session it takes the full CSRF check, and without
 * one it falls back to the same-origin check alone. A dead session must never
 * leave someone unable to sign out.
 */
export const POST = api(
  async (event) => {
    const config = getAuthConfig();
    const session = await readSession(event.cookies, config);
    if (session) assertCsrf(event.request.headers, session, config);
    else assertSameOrigin(event.request.headers, config);
    await deleteSessionToken(session?.token);

    /* Mirrors the login route's returnTo (#410, §15): this engine's own
       sign-out button is only ever reached from this engine's own screens,
       and "/" being v19's own front door now means a bare sign-out would
       strand that journey there instead of showing it its own signed-out
       state. */
    /* The front end's descent ends on the goodbye at /logout, so that is where
       the provider's own sign-out brings a JSON caller back to. */
    const wantsJson = event.request.headers.get("accept")?.includes("application/json") ?? false;
    const returnTo = event.url.searchParams.get("returnTo") ?? (wantsJson ? "/logout" : null);
    const postLogoutReturnTo = new URL(safeReturnPath(returnTo), config.appUrl);

    /** @type {URL | null} */
    let providerLogout = null;
    if (config.oidc) {
      try {
        // A failed refresh falls back on the last good document rather than skip the provider sign-out.
        const metadata = await discoverProvider(config.oidc, { staleIfError: true });
        providerLogout = createProviderLogoutUrl(config.oidc, metadata, postLogoutReturnTo);
      } catch {
        // Local logout must succeed even if the provider is unavailable.
      }
    }

    clearSessionCookie(event.cookies, config);

    /* The caller chooses the shape: the front end asks for JSON so it can
       drive the hand-off itself, a plain form post gets the redirect. JSON
       answers null when there is no provider session to end, so the front end
       navigates only when there is somewhere to send the browser. */
    if (wantsJson) {
      return json({ redirectTo: providerLogout?.href ?? null }, { headers: { "cache-control": "no-store" } });
    }
    const redirectTarget = providerLogout ?? postLogoutReturnTo;
    return new Response(null, {
      status: 303,
      headers: { location: redirectTarget.href, "cache-control": "no-store" },
    });
  },
  { errorResponse: authErrorResponse },
);
