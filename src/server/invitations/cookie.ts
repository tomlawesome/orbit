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
