import type { CookieSink } from "@/lib/http";
import type { AuthConfig } from "@/lib/env";

export function sessionCookieName(config: AuthConfig): string {
  return config.secureCookies ? "__Host-orbit-session" : "orbit-session";
}

export function transactionCookieName(config: AuthConfig): string {
  return config.secureCookies ? "__Secure-orbit-oidc" : "orbit-oidc";
}

/**
 * The waiting tab's own name for its pending sign-in (#1033, ADR-0027 §4).
 *
 * `__Host-` for the same reason the session cookie has it: the claim inside
 * decides who collects a session, so it must be bound to this exact origin
 * with no path or domain an adjacent host could widen.
 */
export function pendingSignInCookieName(config: AuthConfig): string {
  return config.secureCookies ? "__Host-orbit-pending" : "orbit-pending";
}

export function setSessionCookie(cookies: CookieSink, token: string, config: AuthConfig): void {
  cookies.set(sessionCookieName(config), token, {
    httpOnly: true,
    secure: config.secureCookies,
    sameSite: "lax",
    path: "/",
    maxAge: config.sessionTtlSeconds,
    priority: "high",
  });
}

export function clearSessionCookie(cookies: CookieSink, config: AuthConfig): void {
  cookies.set(sessionCookieName(config), "", {
    httpOnly: true,
    secure: config.secureCookies,
    sameSite: "lax",
    path: "/",
    maxAge: 0,
  });
}

export function setTransactionCookie(cookies: CookieSink, transaction: string, config: AuthConfig): void {
  cookies.set(transactionCookieName(config), transaction, {
    httpOnly: true,
    secure: config.secureCookies,
    sameSite: "lax",
    path: config.secureCookies ? "/api/auth/callback" : "/",
    maxAge: 600,
  });
}

export function clearTransactionCookie(cookies: CookieSink, config: AuthConfig): void {
  cookies.set(transactionCookieName(config), "", {
    httpOnly: true,
    secure: config.secureCookies,
    sameSite: "lax",
    path: config.secureCookies ? "/api/auth/callback" : "/",
    maxAge: 0,
  });
}

/**
 * Holds the pending sign-in's claim for as long as the approval link lives
 * (ADR-0027 §6's ten minutes). It is not a session and can never become one:
 * `collectSignInApproval` only ever answers with the user id of an approval
 * somebody actually pressed Approve on.
 */
export function setPendingSignInCookie(cookies: CookieSink, claim: string, config: AuthConfig, maxAgeSeconds: number): void {
  cookies.set(pendingSignInCookieName(config), claim, {
    httpOnly: true,
    secure: config.secureCookies,
    sameSite: "lax",
    path: "/",
    maxAge: maxAgeSeconds,
  });
}

export function clearPendingSignInCookie(cookies: CookieSink, config: AuthConfig): void {
  cookies.set(pendingSignInCookieName(config), "", {
    httpOnly: true,
    secure: config.secureCookies,
    sameSite: "lax",
    path: "/",
    maxAge: 0,
  });
}
