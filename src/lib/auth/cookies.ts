import type { NextResponse } from "next/server";
import type { AuthConfig } from "@/lib/env";

export function sessionCookieName(config: AuthConfig): string {
  return config.secureCookies ? "__Host-orbit-session" : "orbit-session";
}

export function transactionCookieName(config: AuthConfig): string {
  return config.secureCookies ? "__Secure-orbit-oidc" : "orbit-oidc";
}

export function setSessionCookie(response: NextResponse, token: string, config: AuthConfig): void {
  response.cookies.set(sessionCookieName(config), token, {
    httpOnly: true,
    secure: config.secureCookies,
    sameSite: "lax",
    path: "/",
    maxAge: config.sessionTtlSeconds,
    priority: "high",
  });
}

export function clearSessionCookie(response: NextResponse, config: AuthConfig): void {
  response.cookies.set(sessionCookieName(config), "", {
    httpOnly: true,
    secure: config.secureCookies,
    sameSite: "lax",
    path: "/",
    maxAge: 0,
  });
}

export function setTransactionCookie(response: NextResponse, transaction: string, config: AuthConfig): void {
  response.cookies.set(transactionCookieName(config), transaction, {
    httpOnly: true,
    secure: config.secureCookies,
    sameSite: "lax",
    path: config.secureCookies ? "/api/auth/callback" : "/",
    maxAge: 600,
  });
}

export function clearTransactionCookie(response: NextResponse, config: AuthConfig): void {
  response.cookies.set(transactionCookieName(config), "", {
    httpOnly: true,
    secure: config.secureCookies,
    sameSite: "lax",
    path: config.secureCookies ? "/api/auth/callback" : "/",
    maxAge: 0,
  });
}
