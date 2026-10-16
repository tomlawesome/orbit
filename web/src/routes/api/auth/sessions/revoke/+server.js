import { json } from "@sveltejs/kit";

import { clearSessionCookie } from "orbit/lib/auth/cookies";
import { authErrorResponse } from "orbit/lib/auth/http";
import { providerLogoutFor } from "orbit/lib/auth/provider-logout";
import { revokeUserSessionsTakingOwn } from "orbit/lib/auth/session";
import { getAuthConfig } from "orbit/lib/env";

import { write } from "$lib/server/api.js";

/**
 * "Sign out of every device" (#468, settings §13) — ported for #735.
 *
 * Every session this user holds ends, the caller's own included: a device the
 * reader no longer trusts must lose access, and a caller who kept their own
 * session would have no way to know which device that was. Clearing the
 * cookie stops this browser presenting a token that is already dead; every
 * other device is refused on its next request because `readSession` finds no
 * row.
 *
 * The scope is the session's own user id, never one from the request, so
 * there is nothing to name and no way to sign anyone else out. `write` supplies
 * the CSRF check an action this destructive requires — it must not be
 * reachable from another origin's form post.
 */
export const POST = write(async (event, session) => {
  const config = getAuthConfig();
  const { revoked, taken } = await revokeUserSessionsTakingOwn(session.user.id, session.id);
  /* This browser leaves through the provider as the ordinary sign-out does
     (#1439), with its own ID token only. The provider's sessions on the other
     devices are not reachable from here: those devices stay signed in at the
     provider, and only Orbit's sessions on them end. */
  const providerLogout = await providerLogoutFor(config, taken, new URL("/logout", config.appUrl));
  clearSessionCookie(event.cookies, config);
  return json(
    { revoked, redirectTo: providerLogout?.href ?? null },
    { headers: { "cache-control": "no-store" } },
  );
}, { errorResponse: authErrorResponse });
