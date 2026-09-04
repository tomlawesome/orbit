import { json } from "@sveltejs/kit";

import { authErrorResponse } from "orbit/lib/auth/http";
import { csrfTokenForSession, readSession } from "orbit/lib/auth/session";
import { getAuthConfig } from "orbit/lib/env";

import { SESSION_FIXTURE } from "$lib/data/fixtures/workspace.js";
import { api } from "$lib/server/api.js";

/**
 * Who the caller is, and the token their writes must carry (#735 port).
 *
 * Deliberately not built on `read()`: an absent session is a normal answer
 * here, not a failure. Every other route wants 401-and-stop; this one is how
 * the front end asks whether it is signed in at all, so it reports
 * `authenticated: false` rather than throwing.
 *
 * The CSRF token is derived from the session token rather than stored, so it
 * cannot be handed out to a caller who did not already present the session it
 * belongs to.
 */
export const GET = api(
  async (event) => {
    const config = getAuthConfig();
    const session = await readSession(event.cookies, config);
    if (!session) {
      return json({ authenticated: false }, { status: 401, headers: { "cache-control": "no-store" } });
    }
    return json(
      {
        authenticated: true,
        user: session.user,
        activeHouseholdId: session.activeHouseholdId,
        expiresAt: session.expiresAt.toISOString(),
        csrfToken: csrfTokenForSession(session, config),
      },
      { headers: { "cache-control": "no-store" } },
    );
  },
  {
    fixture: () => json(SESSION_FIXTURE, { headers: { "cache-control": "no-store" } }),
    errorResponse: authErrorResponse,
  },
);
