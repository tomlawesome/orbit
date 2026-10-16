import { json } from "@sveltejs/kit";

import { clearSessionCookie } from "orbit/lib/auth/cookies";
import { authErrorResponse } from "orbit/lib/auth/http";
import { providerLogoutFor } from "orbit/lib/auth/provider-logout";
import { revokeSession } from "orbit/lib/auth/session";
import { getAuthConfig } from "orbit/lib/env";

import { write } from "$lib/server/api.js";

/**
 * "Sign out of one place" (#482) — the single-session counterpart to
 * `/api/auth/sessions/revoke`'s sign-out-everywhere.
 *
 * Scoped to the caller: `revokeSession` deletes the row only if it belongs
 * to this user, and answers `session_not_found` (404) either way when it
 * does not — a session id that exists but belongs to someone else must look
 * exactly like one that never existed, or the response itself would leak
 * who else is signed in.
 *
 * If the caller revoked the session they are reading this response from,
 * this browser's own cookie is now a dead letter; clearing it here is the
 * same courtesy `sessions/revoke` and `logout` already extend, so the next
 * request does not carry a cookie for a row that is already gone.
 */
export const POST = write(async (event, session) => {
  const sessionId = /** @type {string} */ (event.params.sessionId);
  const taken = await revokeSession(session.user.id, sessionId);
  /** @type {URL | null} */
  let providerLogout = null;
  if (sessionId === session.id) {
    const config = getAuthConfig();
    /* This browser's own session ended (#1439): leave through the provider
       as the ordinary sign-out does, back to the goodbye at /logout. Another
       device's token is never this browser's hint, so the provider is not
       asked for any other row. */
    providerLogout = await providerLogoutFor(config, taken, new URL("/logout", config.appUrl));
    clearSessionCookie(event.cookies, config);
  }
  return json(
    { revoked: true, redirectTo: providerLogout?.href ?? null },
    { headers: { "cache-control": "no-store" } },
  );
}, { errorResponse: authErrorResponse });
