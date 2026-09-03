import { json } from "@sveltejs/kit";

import { clearSessionCookie } from "orbit/lib/auth/cookies";
import { authErrorResponse } from "orbit/lib/auth/http";
import { revokeUserSessions } from "orbit/lib/auth/session";
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
  const revoked = await revokeUserSessions(session.user.id);
  clearSessionCookie(event.cookies, getAuthConfig());
  return json({ revoked }, { headers: { "cache-control": "no-store" } });
}, { errorResponse: authErrorResponse });
