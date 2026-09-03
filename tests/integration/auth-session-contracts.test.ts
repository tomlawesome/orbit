import { eq } from "drizzle-orm";
import { readSetCookie } from "./support/set-cookie";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest, type NextResponse } from "next/server";
import { getDb } from "@/db";
import { auditLog, sessions } from "@/db/schema";
import { POST as logout } from "@/app/api/auth/logout/route";
import { GET as sessionStatus } from "@/app/api/auth/session/route";
import { POST as refresh } from "@/app/api/auth/session/refresh/route";
import { POST as revokeSessions } from "@/app/api/auth/sessions/revoke/route";
import { AuthError } from "@/lib/auth/errors";
import { getAuthConfig } from "@/lib/env";
import { sessionCookieName } from "@/lib/auth/cookies";
import { createCsrfToken, hashSessionToken } from "@/lib/auth/crypto";
import * as oidc from "@/lib/auth/oidc";
import {
  cleanupIntegrationEnvironment,
  createIntegrationFixture,
  requestForSession,
  requestWithoutSession,
  sessionHeaders,
  type IntegrationSession,
} from "./support/fixtures";

afterAll(async () => {
  await cleanupIntegrationEnvironment();
});

afterEach(() => {
  vi.restoreAllMocks();
});

const REVOKE_URL = "http://127.0.0.1:3000/api/auth/sessions/revoke";

function sessionRequest(session: IntegrationSession, overrides: Record<string, string> = {}): NextRequest {
  return requestForSession(session, "http://127.0.0.1:3000/api/auth/session", {
    headers: overrides,
  });
}

function replacementSession(session: IntegrationSession, response: Response): IntegrationSession {
  const config = getAuthConfig();
  const token = readSetCookie(response, sessionCookieName(config))?.value;
  if (!token) throw new Error("Refresh response did not set a session cookie");
  const csrfToken = createCsrfToken(token, config.sessionSecret);
  return {
    ...session,
    token,
    csrfToken,
    headers: sessionHeaders(session, {
      cookie: `${sessionCookieName(config)}=${token}`,
      "x-csrf-token": csrfToken,
    }),
  };
}

async function sessionRows(sessionId: string) {
  return getDb().select({ id: sessions.id, tokenHash: sessions.tokenHash })
    .from(sessions)
    .where(eq(sessions.id, sessionId));
}

describe("PostgreSQL authentication session contracts", () => {
  it("rotates one persisted token atomically and rejects the old cookie and CSRF token", async () => {
    const fixture = await createIntegrationFixture("auth-refresh");
    const session = await fixture.session("member");
    const config = getAuthConfig();
    const [before] = await sessionRows(session.sessionId);

    const response = await refresh(requestForSession(session, "http://127.0.0.1:3000/api/auth/session/refresh", {
      method: "POST",
    }));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(readSetCookie(response, sessionCookieName(config))?.value).toBeTruthy();
    expect(response.headers.get("set-cookie")).toContain("HttpOnly");
    expect(response.headers.get("set-cookie")).toContain("SameSite=lax");

    const [after] = await sessionRows(session.sessionId);
    expect(after).toEqual(expect.objectContaining({ id: session.sessionId }));
    expect(after?.tokenHash).not.toBe(before?.tokenHash);
    expect(await sessionRows(session.sessionId)).toHaveLength(1);

    const rotated = replacementSession(session, response);
    const rotatedStatus = await sessionStatus(sessionRequest(rotated));
    expect(rotatedStatus.status).toBe(200);
    expect((await rotatedStatus.json()).authenticated).toBe(true);

    const oldStatus = await sessionStatus(sessionRequest(session));
    expect(oldStatus.status).toBe(401);
    expect(oldStatus.headers.get("cache-control")).toBe("no-store");

    const oldCsrfResponse = await refresh(requestForSession(rotated, "http://127.0.0.1:3000/api/auth/session/refresh", {
      method: "POST",
      headers: { "x-csrf-token": session.csrfToken },
    }));
    expect(oldCsrfResponse.status).toBe(403);
    expect(oldCsrfResponse.headers.get("cache-control")).toBe("no-store");
    expect((await oldCsrfResponse.json()).error.code).toBe("csrf_failed");
    expect(hashSessionToken(rotated.token)).toBe(after?.tokenHash);
  });

  it("gives exactly one concurrent refresh winner and leaves only the winner usable", async () => {
    const fixture = await createIntegrationFixture("auth-refresh-concurrent");
    const session = await fixture.session("member");

    const [first, second] = await Promise.all([
      refresh(requestForSession(session, "http://127.0.0.1:3000/api/auth/session/refresh", { method: "POST" })),
      refresh(requestForSession(session, "http://127.0.0.1:3000/api/auth/session/refresh", { method: "POST" })),
    ]);
    const responses = [first, second];
    expect(responses.map((response) => response.status).sort((left, right) => left - right)).toEqual([200, 401]);

    const winner = responses.find((response) => response.status === 200);
    const loser = responses.find((response) => response.status === 401);
    expect(winner).toBeDefined();
    expect(loser).toBeDefined();
    expect(winner?.headers.get("cache-control")).toBe("no-store");
    expect(loser?.headers.get("cache-control")).toBe("no-store");
    expect((await loser?.json()).error.code).toBe("session_required");

    const rotated = replacementSession(session, winner!);
    expect((await (await sessionStatus(sessionRequest(rotated))).json()).authenticated).toBe(true);
    expect((await sessionStatus(sessionRequest(session))).status).toBe(401);
    expect(await sessionRows(session.sessionId)).toHaveLength(1);
  });

  it("logs out locally first and clears the cookie when provider discovery fails", async () => {
    const fixture = await createIntegrationFixture("auth-logout-provider-down");
    const session = await fixture.session("member");
    const config = getAuthConfig();
    vi.spyOn(oidc, "discoverProvider").mockRejectedValue(new AuthError(
      "discovery_failed",
      "The OpenID provider configuration could not be validated",
      502,
    ));

    const response = await logout(requestForSession(session, "http://127.0.0.1:3000/api/auth/logout", {
      method: "POST",
    }));
    expect(response.status).toBe(303);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("location")).toBe(config.appUrl.href);
    expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
    expect(await sessionRows(session.sessionId)).toHaveLength(0);
    expect((await sessionStatus(sessionRequest(session))).status).toBe(401);
  });

  it("clears a signed-out cookie without changing database state", async () => {
    await createIntegrationFixture("auth-logout-signed-out");
    const config = getAuthConfig();
    vi.spyOn(oidc, "discoverProvider").mockRejectedValue(new AuthError(
      "discovery_failed",
      "The OpenID provider configuration could not be validated",
      502,
    ));
    const before = await getDb().select({ id: sessions.id }).from(sessions);

    const response = await logout(requestWithoutSession("http://127.0.0.1:3000/api/auth/logout", {
      method: "POST",
      headers: { origin: config.appUrl.origin },
    }));
    expect(response.status).toBe(303);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("location")).toBe(config.appUrl.href);
    expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
    expect(await getDb().select({ id: sessions.id }).from(sessions)).toEqual(before);
  });

  it("signs every device out at once, and each one is refused on its next request", async () => {
    const fixture = await createIntegrationFixture("auth-revoke-everywhere");
    const laptop = await fixture.session("member");
    const phone = await fixture.session("member");
    const someoneElse = await fixture.session("owner");
    const config = getAuthConfig();

    const response = await revokeSessions(requestForSession(laptop, REVOKE_URL, { method: "POST" }));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ revoked: 2 });
    expect(readSetCookie(response, sessionCookieName(config))?.value).toBe("");
    expect(response.headers.get("set-cookie")).toContain("Max-Age=0");

    // The point of the action: the device that asked, and the one that did
    // not, are both gone — from the database and from the next request.
    expect(await sessionRows(laptop.sessionId)).toHaveLength(0);
    expect(await sessionRows(phone.sessionId)).toHaveLength(0);
    expect((await sessionStatus(sessionRequest(laptop))).status).toBe(401);
    expect((await sessionStatus(sessionRequest(phone))).status).toBe(401);
    expect((await refresh(requestForSession(phone, "http://127.0.0.1:3000/api/auth/session/refresh", {
      method: "POST",
    }))).status).toBe(401);

    // Another account's session is untouched: the scope is the caller's user.
    expect((await sessionStatus(sessionRequest(someoneElse))).status).toBe(200);
    expect(await sessionRows(someoneElse.sessionId)).toHaveLength(1);

    const [entry] = await getDb().select({
      actorUserId: auditLog.actorUserId,
      entityType: auditLog.entityType,
      entityId: auditLog.entityId,
      action: auditLog.action,
      changes: auditLog.changes,
    }).from(auditLog).where(eq(auditLog.entityId, laptop.userId));
    expect(entry).toEqual({
      actorUserId: laptop.userId,
      entityType: "user",
      entityId: laptop.userId,
      action: "sessions_revoked",
      changes: { sessions: 2 },
    });
  });

  it("revokes nothing without a session, a CSRF token, or a same-origin post", async () => {
    const fixture = await createIntegrationFixture("auth-revoke-refused");
    const session = await fixture.session("member");
    const config = getAuthConfig();

    const signedOut = await revokeSessions(requestWithoutSession(REVOKE_URL, {
      method: "POST",
      headers: { origin: config.appUrl.origin },
    }));
    expect(signedOut.status).toBe(401);

    const noCsrf = await revokeSessions(requestForSession(session, REVOKE_URL, {
      method: "POST",
      headers: { "x-csrf-token": "invalid-csrf" },
    }));
    expect(noCsrf.status).toBe(403);

    const crossSite = await revokeSessions(requestForSession(session, REVOKE_URL, {
      method: "POST",
      headers: { origin: "https://attacker.invalid" },
    }));
    expect(crossSite.status).toBe(403);

    expect(await sessionRows(session.sessionId)).toHaveLength(1);
    expect((await sessionStatus(sessionRequest(session))).status).toBe(200);
    expect(await fixture.auditCount(session.userId)).toBe(0);
  });

  it("preserves the session for invalid logout origin and CSRF", async () => {
    const fixture = await createIntegrationFixture("auth-logout-invalid");
    const session = await fixture.session("member");

    const invalidOrigin = await logout(requestForSession(session, "http://127.0.0.1:3000/api/auth/logout", {
      method: "POST",
      headers: { origin: "https://attacker.invalid" },
    }));
    expect(invalidOrigin.status).toBe(403);
    expect(invalidOrigin.headers.get("cache-control")).toBe("no-store");

    const invalidCsrf = await logout(requestForSession(session, "http://127.0.0.1:3000/api/auth/logout", {
      method: "POST",
      headers: { "x-csrf-token": "invalid-csrf" },
    }));
    expect(invalidCsrf.status).toBe(403);
    expect(invalidCsrf.headers.get("cache-control")).toBe("no-store");
    expect(await sessionRows(session.sessionId)).toHaveLength(1);
    expect((await sessionStatus(sessionRequest(session))).status).toBe(200);
  });
});
