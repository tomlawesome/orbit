import type { CookieReader, CookieSink } from "@/lib/http";
import type { AuthConfig } from "@/lib/env";

/**
 * THE REMEMBERED INVITATION (#481, step 3).
 *
 * A signed-out visitor who opens `/invite/<token>` has to go through the
 * identity provider and come back, and the provider's redirect knows nothing
 * about which invitation started it. So the token is parked here: HTTP-only,
 * same-site lax so it survives the top-level navigation back from the
 * provider, and one hour — long enough to create an account with the provider,
 * short enough that a shared computer does not carry it into next week.
 *
 * Deliberately NOT the login transaction's `returnTo`. That value comes off a
 * query string a stranger can write; this one is set by Orbit, after it has
 * confirmed the invitation exists and is open.
 */

export function invitationCookieName(config: AuthConfig): string {
  return config.secureCookies ? "__Host-orbit-invite" : "orbit-invite";
}

/** One hour, and no renewal: a stalled sign-in starts again from the mail. */
export const INVITATION_COOKIE_MAX_AGE_SECONDS = 3600;

export function setInvitationCookie(cookies: CookieSink, token: string, config: AuthConfig): void {
  cookies.set(invitationCookieName(config), token, {
    httpOnly: true,
    secure: config.secureCookies,
    sameSite: "lax",
    path: "/",
    maxAge: INVITATION_COOKIE_MAX_AGE_SECONDS,
  });
}

export function clearInvitationCookie(cookies: CookieSink, config: AuthConfig): void {
  cookies.set(invitationCookieName(config), "", {
    httpOnly: true,
    secure: config.secureCookies,
    sameSite: "lax",
    path: "/",
    maxAge: 0,
  });
}

/** What the callback reads to decide where a fresh session should land. */
export function readInvitationCookie(cookies: CookieReader, config: AuthConfig): string | null {
  const value = cookies.get(invitationCookieName(config));
  return value ? value : null;
}

/**
 * THE INVITED LANDING (#871) — one shot, carried across the redirect a
 * redemption ends with.
 *
 * `redeemInvitation` sets the session's active household directly, so by the
 * time `/invite/[token]` redirects to `/` the session already answers "which
 * household" the way it would for a member of ten years — there is nothing
 * left there to tell an invited reader's FIRST landing apart from their
 * hundredth. This cookie is that difference: `/invite/[token]/+page.server.js`
 * sets it in the same response as the redirect, and `GET /api/auth/session`
 * reads it and clears it in the same breath, exactly the rule
 * `$lib/flight/arrival.js`'s `consumeLaunch` already keeps for the launch
 * marker — a refresh of `/`, a bookmark, a Back, all find it already gone,
 * so the arrival plays once, not on every later visit to a household this
 * reader now simply belongs to.
 *
 * Two minutes is generous for a redirect and a page load, and nowhere near
 * long enough to matter if a reader's tab sits open unattended.
 */

export function invitedLandingCookieName(config: AuthConfig): string {
  return config.secureCookies ? "__Host-orbit-invited" : "orbit-invited";
}

export const INVITED_LANDING_COOKIE_MAX_AGE_SECONDS = 120;

export function setInvitedLandingCookie(cookies: CookieSink, config: AuthConfig): void {
  cookies.set(invitedLandingCookieName(config), "1", {
    httpOnly: true,
    secure: config.secureCookies,
    sameSite: "lax",
    path: "/",
    maxAge: INVITED_LANDING_COOKIE_MAX_AGE_SECONDS,
  });
}

/** Read once, gone in the same breath — see the note above. */
export function readAndClearInvitedLandingCookie(cookies: CookieSink, config: AuthConfig): boolean {
  const name = invitedLandingCookieName(config);
  const present = Boolean(cookies.get(name));
  if (present) {
    cookies.set(name, "", {
      httpOnly: true,
      secure: config.secureCookies,
      sameSite: "lax",
      path: "/",
      maxAge: 0,
    });
  }
  return present;
}
