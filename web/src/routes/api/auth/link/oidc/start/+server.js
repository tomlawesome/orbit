import { json } from "@sveltejs/kit";

import { setTransactionCookie } from "orbit/lib/auth/cookies";
import { randomUrlSafe, safeReturnPath, sealLoginTransaction } from "orbit/lib/auth/crypto";
import { AuthError } from "orbit/lib/auth/errors";
import { authErrorResponse } from "orbit/lib/auth/http";
import { createAuthorizationUrl, discoverProvider } from "orbit/lib/auth/oidc";
import { requireRecentAuthentication } from "orbit/lib/auth/recent-auth";
import { getAuthConfig } from "orbit/lib/env";

import { write } from "$lib/server/api.js";

/**
 * Starts linking a provider identity to the signed-in account (ADR-0023 §6).
 *
 * Session, CSRF and a fresh challenge — gaining a second way into an account
 * is exactly as sensitive as changing the first — and then the ordinary
 * authorization-code flow, with one difference: the transaction carries
 * `linkUserId`, sealed here under `SESSION_SECRET`.
 *
 * That field is the whole security property. The callback learns which
 * account the returning identity belongs to from the sealed value and from
 * nothing else — not a query parameter, not a cookie the browser could write,
 * not the email the provider asserts. A link target a stranger could name is
 * an account takeover with extra steps.
 *
 * The 302 is built by hand for the same reason `GET /api/auth/login` builds
 * its own: SvelteKit's `redirect()` signals by throwing, and the wrapper would
 * render that as an error. A plain form post still gets that 302; the front
 * end's own `handToProvider` (web/src/lib/data/workspace.js) calls this with
 * `redirect: "manual"` so it can drive the hand-off itself, which turns any
 * redirect response into an opaque one it cannot read a location from — so
 * it asks for JSON instead, the same way `POST /api/auth/logout` already
 * answers its own caller (#1151 SF1-F1).
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
      // No body, or an unparseable one: the guard below refuses it either way.
    }

    await requireRecentAuthentication(event, session, body, "link_oidc");

    const metadata = await discoverProvider(config.oidc);
    const transaction = {
      state: randomUrlSafe(),
      nonce: randomUrlSafe(),
      codeVerifier: randomUrlSafe(),
      returnTo: safeReturnPath(typeof body.returnTo === "string" ? body.returnTo : null),
      linkUserId: session.user.id,
    };
    setTransactionCookie(event.cookies, await sealLoginTransaction(transaction, config), config);

    const location = createAuthorizationUrl(config.oidc, metadata, transaction).href;
    if (event.request.headers.get("accept")?.includes("application/json")) {
      return json({ location }, { headers: { "cache-control": "no-store" } });
    }
    return new Response(null, {
      status: 302,
      headers: { location, "cache-control": "no-store" },
    });
  },
  { errorResponse: authErrorResponse },
);
