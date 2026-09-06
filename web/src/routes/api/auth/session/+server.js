import { json } from "@sveltejs/kit";

import { authErrorResponse } from "orbit/lib/auth/http";
import { csrfTokenForSession, readSession } from "orbit/lib/auth/session";
import { getAuthConfig } from "orbit/lib/env";
import { listVisibleHouseholds } from "orbit/server/join-requests";
import { readAndClearInvitedLandingCookie } from "orbit/server/invitations/cookie";

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
 *
 * `justJoined` and `visibleHouseholds` (#871) answer for the one reader whose
 * FIRST look at this endpoint follows redeeming an invitation:
 * `readAndClearInvitedLandingCookie` is true at most once per redemption (see
 * its own note), so the extra `listVisibleHouseholds` read — the same query
 * the newcomer's own count runs off, per `#453`'s labelled sky — only ever
 * happens on that one call, never on the ordinary session check every other
 * page makes. Neither field is present at all otherwise, so this answers
 * everyone else exactly as it always has.
 */
export const GET = api(
  async (event) => {
    const config = getAuthConfig();
    const session = await readSession(event.cookies, config);
    if (!session) {
      return json({ authenticated: false }, { status: 401, headers: { "cache-control": "no-store" } });
    }
    const justJoined = session.activeHouseholdId
      ? readAndClearInvitedLandingCookie(event.cookies, config)
      : false;
    return json(
      {
        authenticated: true,
        user: session.user,
        activeHouseholdId: session.activeHouseholdId,
        expiresAt: session.expiresAt.toISOString(),
        csrfToken: csrfTokenForSession(session, config),
        ...(justJoined
          ? { justJoined: true, visibleHouseholds: await listVisibleHouseholds(session.user.id) }
          : {}),
      },
      { headers: { "cache-control": "no-store" } },
    );
  },
  {
    fixture: () => json(SESSION_FIXTURE, { headers: { "cache-control": "no-store" } }),
    errorResponse: authErrorResponse,
  },
);
