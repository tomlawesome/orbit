import { getAuthConfig } from "orbit/lib/env";
import { requireSession } from "orbit/lib/auth/session";
import { assertKeyUsable } from "orbit/server/key-state";
import { verifySenderAddress } from "orbit/server/mail-in/sender-addresses";

/**
 * The one-use link Orbit mails to a sending address (ADR-0017 decision 3,
 * slice 4, #745).
 *
 * A mail program can only issue a GET, so this is one — and that is exactly
 * why the link is worth nothing on its own. Consuming it needs the SESSION
 * too: the token must match a row belonging to the member who is signed in,
 * so somebody who can read the mail but is not that member gains nothing from
 * it. The token is one-use, it expires, and only its digest was ever stored.
 *
 * Every outcome is a redirect back to the relay page rather than a JSON body,
 * because a person opened this from their mail program and an error envelope
 * is not an answer to them. Signed out redirects to sign in and comes back. A
 * bad, spent, expired or someone-else's link all land identically, saying the
 * address is not checked: this page must not become a way of asking whether a
 * token is real.
 *
 * Written without the shared `api()` wrapper on purpose — that wrapper turns
 * anything thrown into the error envelope, which would swallow a redirect.
 */
const RELAY_PAGE = "/settings/mail";

/** @param {string} location */
function seeOther(location) {
  return new Response(null, { status: 303, headers: { location, "cache-control": "no-store" } });
}

export async function GET(event) {
  /* Not wrapped, so the encryption key gate is here, first (#1405): with no
     usable key this reads no session and no encrypted address, and the
     reader is sent to the screen that says why. */
  try {
    assertKeyUsable();
  } catch {
    return seeOther("/maintenance");
  }
  const token = event.url.searchParams.get("token") ?? "";

  let session;
  try {
    session = await requireSession(event.cookies, getAuthConfig());
  } catch {
    // returnTo is the only parameter the login page reads to come back here.
    const back = encodeURIComponent(`${event.url.pathname}${event.url.search}`);
    return seeOther(`/login?returnTo=${back}`);
  }

  try {
    await verifySenderAddress(session.user.id, token);
  } catch {
    return seeOther(`${RELAY_PAGE}?sender=unverified`);
  }
  return seeOther(`${RELAY_PAGE}?sender=verified`);
}
