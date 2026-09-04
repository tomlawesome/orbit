import { json } from "@sveltejs/kit";

import { authErrorResponse } from "orbit/lib/auth/http";
import { rotateSession } from "orbit/lib/auth/session";
import { getAuthConfig } from "orbit/lib/env";

import { write } from "$lib/server/api.js";

/**
 * Rotates the session token before it expires (#735 port).
 *
 * `write()` covers maintenance, the session and CSRF in the Next route's own
 * order. `errorResponse: authErrorResponse` because this is an auth route —
 * same reasoning as the sibling `session/+server.js`. `event.cookies` is
 * handed to `rotateSession` directly: it already satisfies the engine's
 * `CookieSink`, so no `nextCookieSink` adapter is needed here.
 */
export const POST = write(
  async (event, session) => {
    await rotateSession(session, event.cookies, getAuthConfig());
    return json({ refreshed: true }, { headers: { "cache-control": "no-store" } });
  },
  { errorResponse: authErrorResponse },
);
