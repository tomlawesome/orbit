import { describe, expect, it } from "vitest";
import type { AuthConfig } from "../env";
import { createCsrfToken } from "./crypto";
import { assertCsrf, assertSameOrigin, type AuthenticatedSession } from "./session";

const config: AuthConfig = {
  appUrl: new URL("https://orbit.example"),
  sessionSecret: "test-secret-that-is-at-least-thirty-two-characters",
  sessionTtlSeconds: 3600,
  issuer: "https://auth.example/application/o/orbit/",
  clientId: "orbit",
  clientSecret: "secret",
  callbackUrl: "https://orbit.example/api/auth/callback",
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
    isInstanceAdmin: true,
    themeMode: "system",
    themeId: "verdant",
    textSize: "comfortable",
    urgencyPalette: "themed",
    emailNotifications: true,
    pushNotifications: true,
  },
};

/* A plain Request since the cut (#735): the seam reads `.headers` and nothing
   else, so there was never anything Next-specific to construct here. */
function postRequest(headers: Record<string, string>): Request {
  return new Request("https://orbit.example/api/auth/session/refresh", {
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
    expect(() => assertCsrf(request.headers, session, config)).not.toThrow();
  });

  it.each(invalidOriginHeaders)("rejects missing, malformed, or cross-site origins", (headers) => {
    expect(() => assertSameOrigin(postRequest(headers).headers, config)).toThrowError(
      expect.objectContaining({ code: "csrf_failed", status: 403 }),
    );
  });

  it("rejects a missing or invalid synchronizer token", () => {
    const request = postRequest({ origin: config.appUrl.origin, "sec-fetch-site": "same-origin" });
    expect(() => assertCsrf(request.headers, session, config)).toThrowError(
      expect.objectContaining({ code: "csrf_failed", status: 403 }),
    );
  });
});
