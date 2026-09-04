import type { CookieSink } from "@/lib/http";
import type { AuthConfig } from "@/lib/env";

export function sessionCookieName(config: AuthConfig): string {
  return config.secureCookies ? "__Host-orbit-session" : "orbit-session";
}

export function transactionCookieName(config: AuthConfig): string {
  return config.secureCookies ? "__Secure-orbit-oidc" : "orbit-oidc";
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
