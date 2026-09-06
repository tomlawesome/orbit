import { redirect } from "@sveltejs/kit";

import { readSession } from "orbit/lib/auth/session";
import { getAuthConfig } from "orbit/lib/env";
import { inspectInvitation, redeemInvitation } from "orbit/server/invitations";
import { clearInvitationCookie, setInvitationCookie } from "orbit/server/invitations/cookie";

/**
 * THE LINK IN THE MAIL (#481, steps 3 to 5).
 *
 * The one screen in `web/` that runs on the server on purpose. It has to: the
 * token arrives in the URL, the decision needs the session cookie, and the
 * remembered-invitation cookie is HTTP-only, so none of it can happen in the
 * browser. It is also why this route is open in `hooks.server.js` — a signed
 * out stranger is exactly who this address is written for.
 *
 * Two ways in, one path:
 *
 *   SIGNED OUT and the invitation is open — the token is parked in a
 *   short-lived HTTP-only cookie and the reader goes to the identity provider.
 *   The callback sends them back HERE, now with a session, and the branch
 *   below does the work. So redemption is written once, not twice.
 *
 *   SIGNED IN — redeem, and on success go straight to /home. The session's
 *   active household is already set by then, so the arrival's household choice
 *   never appears and the first-run tour shows exactly as it would for anyone
 *   whose `tour_seen_at` is null.
 *
 * Every other outcome renders this screen with one line and one action. None
 * of them names the household: a spent, withdrawn or misaddressed link tells
 * whoever holds it nothing it did not already know.
 */
export const ssr = true;
export const prerender = false;

export async function load({ params, cookies }) {
  const config = getAuthConfig();
  const token = /** @type {string} */ (params.token);
  const session = await readSession(cookies, config);

  if (session) {
    /* Spent on arrival, whatever the outcome: a token that survived a failed
       attempt would be retried by every later sign-in on this browser. */
    clearInvitationCookie(cookies, config);
    const outcome = await redeemInvitation(token, {
      userId: session.user.id,
      email: session.user.email,
      sessionId: session.id,
    });
    if (outcome.state === "joined" || outcome.state === "already_member") {
      redirect(303, "/home");
    }
    return { state: outcome.state, inviterName: outcome.inviterName };
  }

  const seen = await inspectInvitation(token);
  if (seen.state === "open") {
    setInvitationCookie(cookies, token, config);
    /* No returnTo: the cookie is what carries the invitation, and it was set
       by Orbit after checking the token rather than read off a query string. */
    redirect(303, "/api/auth/login");
  }
  return { state: seen.state, inviterName: seen.inviterName };
}
