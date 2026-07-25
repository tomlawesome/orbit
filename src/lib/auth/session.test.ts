import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";
import type { AuthConfig } from "../env";
import { createCsrfToken } from "./crypto";
import { assertCsrf, assertSameOrigin, type AuthenticatedSession } from "./session";

const config: AuthConfig = {
  appUrl: new URL("https://homesee.example"),
  sessionSecret: "test-secret-that-is-at-least-thirty-two-characters",
  sessionTtlSeconds: 3600,
  issuer: "https://auth.example/application/o/homesee/",
  clientId: "homesee",
  clientSecret: "secret",
  callbackUrl: "https://homesee.example/api/auth/callback",
  scopes: "openid profile email",
  claims: { email: "email", emailVerified: "email_verified", name: "name", avatar: "picture" },
  secureCookies: true,
};

const session: AuthenticatedSession = {
  id: "session-id",
  token: "opaque-session-token",
  activeHouseholdId: null,
  expiresAt: new Date(Date.now() + 60_000),
  user: {
    id: "user-id",
    email: "user@example.com",
    emailVerified: true,
    displayName: "Orbit User",
    avatarUrl: null,
    themeMode: "system",
    themeId: "verdant",
  },
};

function postRequest(headers: Record<string, string>): NextRequest {
  return new NextRequest("https://homesee.example/api/auth/session/refresh", {
    method: "POST",
    headers,
  });
}

const invalidOriginHeaders: Array<Record<string, string>> = [
  {},
  { origin: "not a URL" },
  { origin: "https://attacker.example", "sec-fetch-site": "cross-site" },
];

describe("session request protection", () => {
  it("accepts a same-origin request with the synchronizer token", () => {
    const request = postRequest({
      origin: config.appUrl.origin,
      "sec-fetch-site": "same-origin",
      "x-csrf-token": createCsrfToken(session.token, config.sessionSecret),
    });
    expect(() => assertCsrf(request, session, config)).not.toThrow();
  });

  it.each(invalidOriginHeaders)("rejects missing, malformed, or cross-site origins", (headers) => {
    expect(() => assertSameOrigin(postRequest(headers), config)).toThrowError(
      expect.objectContaining({ code: "csrf_failed", status: 403 }),
    );
  });

  it("rejects a missing or invalid synchronizer token", () => {
    const request = postRequest({ origin: config.appUrl.origin, "sec-fetch-site": "same-origin" });
    expect(() => assertCsrf(request, session, config)).toThrowError(
      expect.objectContaining({ code: "csrf_failed", status: 403 }),
    );
  });
});
