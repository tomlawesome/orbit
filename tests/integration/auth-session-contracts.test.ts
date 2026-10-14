import { randomBytes, randomUUID } from "node:crypto";

import { eq, sql } from "drizzle-orm";
import { SignJWT, generateKeyPair } from "jose";
import { readSetCookie } from "./support/set-cookie";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/db";
import { auditLog, metadataDamageSightings, metadataKeys, sessions } from "@/db/schema";
import { AuthError } from "@/lib/auth/errors";
import { getAuthConfig, resetAuthConfigForTests } from "@/lib/env";
import { sessionCookieName } from "@/lib/auth/cookies";
import { createCsrfToken, hashSessionToken } from "@/lib/auth/crypto";
import * as oidc from "@/lib/auth/oidc";
import { createSession } from "@/lib/auth/session";
import { hashPassword } from "@/lib/auth/password";
import { deriveDocumentKeyId, getDocumentConfig, resetDocumentConfigForTests } from "@/server/documents/config";
import { rotationComplete, runKekRotationToCompletion, type RotationKeys } from "@/server/documents/rewrap-worker";
import { setInstanceUserDisabled } from "@/server/admin-repository";
import { setPassword } from "@/server/local-credentials";
import { flushMetadataDamageSightings } from "@/server/metadata/damage-sightings";
import { resetMetadataKeyCacheForTests } from "@/server/metadata/keys";
import {
  cleanupIntegrationEnvironment,
  createIntegrationFixture,
  sessionHeaders,
  type IntegrationSession,
} from "./support/fixtures";
import { callRoute, callRouteForSession, loadRoute } from "./support/request-event";

/* OIDC is off by default since ADR-0023 §1 and the run's environment
   (scripts/test-integration.mjs) leaves it that way, so the sign-out cases
   below, which are about the hand-off to the provider, turn it on for this
   file and put the key back afterwards (as bootstrap.test.ts does). Without
   this the route never asks the provider anything and a hand-off case is
   answered by "no provider", not by the code under test. */
const previousOidcKey = process.env.ORBIT_AUTH_OIDC;
process.env.ORBIT_AUTH_OIDC = "true";
resetAuthConfigForTests();

const { POST: logout } = await loadRoute("auth/logout");
const { GET: sessionStatus } = await loadRoute("auth/session");
const { POST: refresh } = await loadRoute("auth/session/refresh");
const { GET: listSessions } = await loadRoute("auth/sessions");
// #1151 A1-R7: the route's own cap, read back from its own module rather
// than duplicated as a literal here, so this test fails the moment the two
// drift apart. Not a route export -- SvelteKit refuses a `+server.js` export
// that isn't an HTTP method, one of its own options, or `_`-prefixed -- so
// this crosses the same tsc/web boundary loadRoute does, once more, for the
// one constant rather than the whole route.
const SESSION_LIST_LIMIT = (await import(
  /* @vite-ignore */ new URL("../../web/src/lib/server/session-limits.js", import.meta.url).href
) as { SESSION_LIST_LIMIT: number }).SESSION_LIST_LIMIT;
const { POST: revokeSessions } = await loadRoute("auth/sessions/revoke");
const { POST: revokeOneSession } = await loadRoute("auth/sessions/[sessionId]/revoke");

afterAll(async () => {
  if (previousOidcKey === undefined) delete process.env.ORBIT_AUTH_OIDC;
  else process.env.ORBIT_AUTH_OIDC = previousOidcKey;
  resetAuthConfigForTests();
  await cleanupIntegrationEnvironment();
});

afterEach(() => {
  vi.restoreAllMocks();
});

const REVOKE_URL = "http://127.0.0.1:3000/api/auth/sessions/revoke";
const LIST_URL = "http://127.0.0.1:3000/api/auth/sessions";
const revokeOneUrl = (sessionId: string) => `http://127.0.0.1:3000/api/auth/sessions/${sessionId}/revoke`;

function checkSession(session: IntegrationSession, overrides: Record<string, string> = {}): Promise<Response> {
  return callRouteForSession(sessionStatus, session, {
    url: "http://127.0.0.1:3000/api/auth/session",
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


/* ---- #1316 decision 26a: the ID token kept for provider sign-out ---------- */

const OVERSIZE_BYTES = 16 * 1024;

/** A real compact JWS, because Orbit must hand the provider the string it was given, byte for byte. */
async function signedIdToken(options: { expiresInSeconds?: number; padBytes?: number } = {}): Promise<string> {
  const { privateKey } = await generateKeyPair("RS256");
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ email: "person@example.invalid", padding: "x".repeat(options.padBytes ?? 0) })
    .setProtectedHeader({ alg: "RS256", kid: "primary" })
    .setIssuer("https://oidc.invalid.example")
    .setAudience("orbit-integration")
    .setSubject(`subject-${randomUUID()}`)
    .setIssuedAt(now - 7200)
    .setExpirationTime(now + (options.expiresInSeconds ?? 300))
    .sign(privateKey);
}

function mockProvider() {
  return vi.spyOn(oidc, "discoverProvider").mockResolvedValue({
    issuer: getAuthConfig().oidc!.issuer,
    authorization_endpoint: "https://oidc.invalid.example/authorize",
    token_endpoint: "https://oidc.invalid.example/token",
    jwks_uri: "https://oidc.invalid.example/jwks",
    end_session_endpoint: "https://oidc.invalid.example/logout",
    code_challenge_methods_supported: ["S256"],
  });
}

function signOutJson(session: IntegrationSession): Promise<Response> {
  return callRouteForSession(logout, session, {
    url: "http://127.0.0.1:3000/api/auth/logout",
    method: "POST",
    headers: { accept: "application/json" },
  });
}

/** Read with SQL, not the schema object, so this stays a statement about the column and not about a TypeScript name. */
async function storedIdToken(sessionId: string): Promise<string | null | undefined> {
  const rows = await getDb().execute(sql`select id_token_enc from sessions where id = ${sessionId}`);
  return (rows[0] as { id_token_enc: string | null } | undefined)?.id_token_enc;
}

async function userSessionCount(userId: string): Promise<number> {
  return (await getDb().select({ id: sessions.id }).from(sessions).where(eq(sessions.userId, userId))).length;
}

describe("PostgreSQL authentication session contracts", () => {
  it("rotates one persisted token atomically and rejects the old cookie and CSRF token", async () => {
    const fixture = await createIntegrationFixture("auth-refresh");
    const session = await fixture.session("member");
    const config = getAuthConfig();
    const [before] = await sessionRows(session.sessionId);

    const response = await callRouteForSession(refresh, session, {
      url: "http://127.0.0.1:3000/api/auth/session/refresh",
      method: "POST",
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(readSetCookie(response, sessionCookieName(config))?.value).toBeTruthy();
    expect(response.headers.get("set-cookie")).toContain("HttpOnly");
    /* `Lax`, not `lax`, since the cut (#735): Next's response-cookie jar spelled
       the value lowercase, SvelteKit's serialiser capitalises it. The attribute
       value is case-insensitive (RFC 6265bis §5.4.7), so the cookie a browser
       receives means exactly what it meant before — this pins the new speller,
       it does not accept a weaker cookie. */
    expect(response.headers.get("set-cookie")).toContain("SameSite=Lax");

    const [after] = await sessionRows(session.sessionId);
    expect(after).toEqual(expect.objectContaining({ id: session.sessionId }));
    expect(after?.tokenHash).not.toBe(before?.tokenHash);
    expect(await sessionRows(session.sessionId)).toHaveLength(1);

    const rotated = replacementSession(session, response);
    const rotatedStatus = await checkSession(rotated);
    expect(rotatedStatus.status).toBe(200);
    expect((await rotatedStatus.json()).authenticated).toBe(true);

    const oldStatus = await checkSession(session);
    expect(oldStatus.status).toBe(401);
    expect(oldStatus.headers.get("cache-control")).toBe("no-store");

    const oldCsrfResponse = await callRouteForSession(refresh, rotated, {
      url: "http://127.0.0.1:3000/api/auth/session/refresh",
      method: "POST",
      headers: { "x-csrf-token": session.csrfToken },
    });
    expect(oldCsrfResponse.status).toBe(403);
    expect(oldCsrfResponse.headers.get("cache-control")).toBe("no-store");
    expect((await oldCsrfResponse.json()).error.code).toBe("csrf_failed");
    expect(hashSessionToken(rotated.token)).toBe(after?.tokenHash);
  });

  it("gives exactly one concurrent refresh winner and leaves only the winner usable", async () => {
    const fixture = await createIntegrationFixture("auth-refresh-concurrent");
    const session = await fixture.session("member");

    const [first, second] = await Promise.all([
      callRouteForSession(refresh, session, { url: "http://127.0.0.1:3000/api/auth/session/refresh", method: "POST" }),
      callRouteForSession(refresh, session, { url: "http://127.0.0.1:3000/api/auth/session/refresh", method: "POST" }),
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
    expect((await (await checkSession(rotated)).json()).authenticated).toBe(true);
    expect((await checkSession(session)).status).toBe(401);
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

    const response = await callRouteForSession(logout, session, {
      url: "http://127.0.0.1:3000/api/auth/logout",
      method: "POST",
    });
    expect(response.status).toBe(303);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("location")).toBe(config.appUrl.href);
    expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
    expect(await sessionRows(session.sessionId)).toHaveLength(0);
    expect((await checkSession(session)).status).toBe(401);
  });

  it("answers a JSON sign-out with the provider's end-session address, the session's ID token and the goodbye page as the way back (#1316)", async () => {
    const fixture = await createIntegrationFixture("auth-logout-json-contract");
    const idToken = await signedIdToken();
    const session = await fixture.session("member", { idToken });
    const config = getAuthConfig();
    // The route only asks the provider when sign-in is configured; without it
    // this case would pass for the wrong reason.
    expect(config.oidc).not.toBeNull();
    const discover = mockProvider();

    const response = await signOutJson(session);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = (await response.json()) as { redirectTo: string | null };
    expect(body.redirectTo).toEqual(expect.any(String));
    const redirect = new URL(body.redirectTo!);
    expect(redirect.origin + redirect.pathname).toBe("https://oidc.invalid.example/logout");
    expect(redirect.searchParams.get("id_token_hint")).toBe(idToken);
    expect(redirect.searchParams.get("post_logout_redirect_uri")).toBe(new URL("/logout", config.appUrl).href);
    expect(redirect.searchParams.get("client_id")).toBe(config.oidc!.clientId);
    expect(readSetCookie(response, sessionCookieName(config))?.value).toBe("");
    expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
    // Sign-out alone may fall back on the last good discovery document.
    expect(discover).toHaveBeenCalledWith(config.oidc, { staleIfError: true });
    expect(await sessionRows(session.sessionId)).toHaveLength(0);
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

    const response = await callRoute(logout, {
      url: "http://127.0.0.1:3000/api/auth/logout",
      method: "POST",
      headers: { origin: config.appUrl.origin },
    });
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

    const response = await callRouteForSession(revokeSessions, laptop, { url: REVOKE_URL, method: "POST" });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ revoked: 2 });
    expect(readSetCookie(response, sessionCookieName(config))?.value).toBe("");
    expect(response.headers.get("set-cookie")).toContain("Max-Age=0");

    // The point of the action: the device that asked, and the one that did
    // not, are both gone — from the database and from the next request.
    expect(await sessionRows(laptop.sessionId)).toHaveLength(0);
    expect(await sessionRows(phone.sessionId)).toHaveLength(0);
    expect((await checkSession(laptop)).status).toBe(401);
    expect((await checkSession(phone)).status).toBe(401);
    expect((await callRouteForSession(refresh, phone, {
      url: "http://127.0.0.1:3000/api/auth/session/refresh",
      method: "POST",
    })).status).toBe(401);

    // Another account's session is untouched: the scope is the caller's user.
    expect((await checkSession(someoneElse)).status).toBe(200);
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

    const signedOut = await callRoute(revokeSessions, {
      url: REVOKE_URL,
      method: "POST",
      headers: { origin: config.appUrl.origin },
    });
    expect(signedOut.status).toBe(401);

    const noCsrf = await callRouteForSession(revokeSessions, session, {
      url: REVOKE_URL,
      method: "POST",
      headers: { "x-csrf-token": "invalid-csrf" },
    });
    expect(noCsrf.status).toBe(403);

    const crossSite = await callRouteForSession(revokeSessions, session, {
      url: REVOKE_URL,
      method: "POST",
      headers: { origin: "https://attacker.invalid" },
    });
    expect(crossSite.status).toBe(403);

    expect(await sessionRows(session.sessionId)).toHaveLength(1);
    expect((await checkSession(session)).status).toBe(200);
    expect(await fixture.auditCount(session.userId)).toBe(0);
  });

  it("preserves the session for invalid logout origin and CSRF", async () => {
    const fixture = await createIntegrationFixture("auth-logout-invalid");
    const session = await fixture.session("member");

    const invalidOrigin = await callRouteForSession(logout, session, {
      url: "http://127.0.0.1:3000/api/auth/logout",
      method: "POST",
      headers: { origin: "https://attacker.invalid" },
    });
    expect(invalidOrigin.status).toBe(403);
    expect(invalidOrigin.headers.get("cache-control")).toBe("no-store");

    const invalidCsrf = await callRouteForSession(logout, session, {
      url: "http://127.0.0.1:3000/api/auth/logout",
      method: "POST",
      headers: { "x-csrf-token": "invalid-csrf" },
    });
    expect(invalidCsrf.status).toBe(403);
    expect(invalidCsrf.headers.get("cache-control")).toBe("no-store");
    expect(await sessionRows(session.sessionId)).toHaveLength(1);
    expect((await checkSession(session)).status).toBe(200);
  });

  it("lists only the caller's own sessions, current first, and never the raw user agent", async () => {
    const fixture = await createIntegrationFixture("auth-sessions-list");
    const laptop = await fixture.session("member");
    const phone = await fixture.session("member");
    const someoneElse = await fixture.session("owner");

    const response = await callRouteForSession(listSessions, laptop, { url: LIST_URL });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = await response.json();
    const ids = body.sessions.map((row: { id: string }) => row.id);
    expect(ids).toEqual(expect.arrayContaining([laptop.sessionId, phone.sessionId]));
    expect(ids).not.toContain(someoneElse.sessionId);

    const current = body.sessions.find((row: { id: string }) => row.id === laptop.sessionId);
    expect(current).toEqual({
      id: laptop.sessionId,
      current: true,
      createdAt: expect.any(String),
      lastSeenAt: expect.any(String),
      device: expect.any(String),
    });
    // No fixture in this suite sets a User-Agent header, so the coarse
    // description resolves to the "no user agent recorded" case — and,
    // whatever it resolves to, the raw header is never a key in the payload.
    expect(current.device).toBe("unknown device");
    expect(Object.keys(current).sort()).toEqual(["createdAt", "current", "device", "id", "lastSeenAt"]);
    expect(body.sessions[0].id).toBe(laptop.sessionId); // current sorts first
  });

  it("caps the list at SESSION_LIST_LIMIT, keeping the current session and the most recently seen (#1151 A1-R7)", async () => {
    const fixture = await createIntegrationFixture("auth-sessions-cap");
    const laptop = await fixture.session("member");

    // SESSION_LIST_LIMIT + 5 more sessions for the same user, inserted
    // directly rather than through createSession (one unit per row is all
    // this needs) -- each with its own lastSeenAt a second apart, so which
    // ones the cap keeps is unambiguous. Row `j` is the j-th oldest; only the
    // newest SESSION_LIST_LIMIT - 1 of them (the current session takes the
    // other slot) should survive the cap.
    const extraCount = SESSION_LIST_LIMIT + 5;
    const base = Date.now() - extraCount * 1000;
    const extraRows = Array.from({ length: extraCount }, (_, j) => ({
      userId: laptop.userId,
      tokenHash: hashSessionToken(randomUUID()),
      expiresAt: new Date(Date.now() + 86_400_000),
      createdAt: new Date(base + j * 1000),
      lastSeenAt: new Date(base + j * 1000),
    }));
    await getDb().insert(sessions).values(extraRows).returning({ id: sessions.id });
    const keptExtraIds = new Set(
      extraRows.slice(extraCount - (SESSION_LIST_LIMIT - 1)).map((row) => row.tokenHash),
    );

    const response = await callRouteForSession(listSessions, laptop, { url: LIST_URL });
    const body = await response.json();

    expect(body.sessions).toHaveLength(SESSION_LIST_LIMIT);
    expect(body.sessions.map((row: { id: string }) => row.id)).toContain(laptop.sessionId);

    const kept = await getDb().select({ id: sessions.id, tokenHash: sessions.tokenHash })
      .from(sessions).where(eq(sessions.userId, laptop.userId));
    const idToTokenHash = new Map(kept.map((row) => [row.id, row.tokenHash]));
    const keptExtraCountInBody = body.sessions
      .filter((row: { id: string }) => row.id !== laptop.sessionId)
      .filter((row: { id: string }) => keptExtraIds.has(idToTokenHash.get(row.id) ?? "")).length;
    expect(keptExtraCountInBody).toBe(SESSION_LIST_LIMIT - 1);
  });

  it("revokes exactly one session, leaving the caller's other sessions and other accounts untouched", async () => {
    const fixture = await createIntegrationFixture("auth-sessions-revoke-one");
    const laptop = await fixture.session("member");
    const phone = await fixture.session("member");

    const response = await callRouteForSession(revokeOneSession, laptop, {
      url: revokeOneUrl(phone.sessionId),
      method: "POST",
      params: { sessionId: phone.sessionId },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ revoked: true });
    // Not the caller's own session, so nothing about this browser's cookie
    // changes.
    expect(response.headers.get("set-cookie")).toBeNull();

    expect(await sessionRows(phone.sessionId)).toHaveLength(0);
    expect(await sessionRows(laptop.sessionId)).toHaveLength(1);
    expect((await checkSession(laptop)).status).toBe(200);

    const [entry] = await getDb().select({
      actorUserId: auditLog.actorUserId,
      entityType: auditLog.entityType,
      entityId: auditLog.entityId,
      action: auditLog.action,
    }).from(auditLog).where(eq(auditLog.entityId, phone.sessionId));
    expect(entry).toEqual({
      actorUserId: laptop.userId,
      entityType: "session",
      entityId: phone.sessionId,
      action: "session_revoked",
    });
  });

  it("answers like logout when the caller revokes their own current session", async () => {
    const fixture = await createIntegrationFixture("auth-sessions-revoke-self");
    const laptop = await fixture.session("member");
    const config = getAuthConfig();

    const response = await callRouteForSession(revokeOneSession, laptop, {
      url: revokeOneUrl(laptop.sessionId),
      method: "POST",
      params: { sessionId: laptop.sessionId },
    });
    expect(response.status).toBe(200);
    expect(readSetCookie(response, sessionCookieName(config))?.value).toBe("");
    expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
    expect(await sessionRows(laptop.sessionId)).toHaveLength(0);
    expect((await checkSession(laptop)).status).toBe(401);
  });

  it("answers 404 for a nonexistent session id and for another account's session id, changing nothing either way", async () => {
    const fixture = await createIntegrationFixture("auth-sessions-revoke-refused");
    const member = await fixture.session("member");
    const someoneElse = await fixture.session("owner");

    const missing = await callRouteForSession(revokeOneSession, member, {
      url: revokeOneUrl("00000000-0000-4000-8000-000000000000"),
      method: "POST",
      params: { sessionId: "00000000-0000-4000-8000-000000000000" },
    });
    expect(missing.status).toBe(404);
    expect(missing.headers.get("cache-control")).toBe("no-store");

    // Same answer for a session id that exists but belongs to someone else —
    // the response must not distinguish "not yours" from "does not exist".
    const wrongOwner = await callRouteForSession(revokeOneSession, member, {
      url: revokeOneUrl(someoneElse.sessionId),
      method: "POST",
      params: { sessionId: someoneElse.sessionId },
    });
    expect(wrongOwner.status).toBe(404);
    expect((await missing.json()).error.code).toBe((await wrongOwner.json()).error.code);

    expect(await sessionRows(someoneElse.sessionId)).toHaveLength(1);
    expect(await fixture.auditCount(someoneElse.sessionId)).toBe(0);
  });

  it("refuses to list or revoke a single session without a session, a CSRF token, or a same-origin post", async () => {
    const fixture = await createIntegrationFixture("auth-sessions-refused");
    const session = await fixture.session("member");
    const config = getAuthConfig();

    expect((await callRoute(listSessions, { url: LIST_URL })).status).toBe(401);

    const signedOut = await callRoute(revokeOneSession, {
      url: revokeOneUrl(session.sessionId),
      method: "POST",
      params: { sessionId: session.sessionId },
      headers: { origin: config.appUrl.origin },
    });
    expect(signedOut.status).toBe(401);

    const noCsrf = await callRouteForSession(revokeOneSession, session, {
      url: revokeOneUrl(session.sessionId),
      method: "POST",
      params: { sessionId: session.sessionId },
      headers: { "x-csrf-token": "invalid-csrf" },
    });
    expect(noCsrf.status).toBe(403);

    const crossSite = await callRouteForSession(revokeOneSession, session, {
      url: revokeOneUrl(session.sessionId),
      method: "POST",
      params: { sessionId: session.sessionId },
      headers: { origin: "https://attacker.invalid" },
    });
    expect(crossSite.status).toBe(403);

    expect(await sessionRows(session.sessionId)).toHaveLength(1);
  });
});

describe("the session keeps the provider's ID token for sign-out (#1316 decision 26a)", () => {
  it("stores the token sealed on the session row, and nowhere readable", async () => {
    const fixture = await createIntegrationFixture("id-token-sealed");
    const idToken = await signedIdToken();
    const session = await fixture.session("member", { idToken });

    const stored = await storedIdToken(session.sessionId);
    expect(stored).toEqual(expect.stringMatching(/^mdv1\./));
    const [row] = await getDb().select().from(sessions).where(eq(sessions.id, session.sessionId));
    expect(JSON.stringify(row)).not.toContain(idToken);
    expect(JSON.stringify(row)).not.toContain(idToken.split(".")[1]);
  });

  it("keeps no token for a session that began with a password", async () => {
    const fixture = await createIntegrationFixture("id-token-none");
    const session = await fixture.session("member");
    expect(await storedIdToken(session.sessionId)).toBeNull();
  });

  it("ends a session with no token locally and sends the browser nowhere, even with a provider configured", async () => {
    const fixture = await createIntegrationFixture("id-token-signout-none");
    const session = await fixture.session("member");
    const config = getAuthConfig();
    mockProvider();

    const response = await signOutJson(session);
    expect(response.status).toBe(200);
    expect((await response.json())).toEqual({ redirectTo: null });
    expect(await sessionRows(session.sessionId)).toHaveLength(0);
    expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
    expect(readSetCookie(response, sessionCookieName(config))?.value).toBe("");
  });

  it("answers a damaged stored value with a local sign-out, and records one sighting", async () => {
    const fixture = await createIntegrationFixture("id-token-damaged");
    const session = await fixture.session("member", { idToken: await signedIdToken() });
    mockProvider();
    await getDb().execute(sql`update sessions set id_token_enc = 'mdv1.x.y.z' where id = ${session.sessionId}`);

    const response = await signOutJson(session);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ redirectTo: null });
    expect(await sessionRows(session.sessionId)).toHaveLength(0);

    await flushMetadataDamageSightings();
    const sightings = await getDb().select().from(metadataDamageSightings)
      .where(eq(metadataDamageSightings.rowId, session.sessionId));
    expect(sightings).toHaveLength(1);
    expect(sightings[0]).toMatchObject({ tableName: "sessions", columnName: "id_token" });
  });

  it("refuses a sealed value moved onto another session, because it is bound to its row", async () => {
    const fixture = await createIntegrationFixture("id-token-moved");
    const original = await fixture.session("member", { idToken: await signedIdToken() });
    const other = await fixture.session("owner", { idToken: await signedIdToken() });
    mockProvider();
    await getDb().execute(sql`update sessions set id_token_enc = (select id_token_enc from sessions where id = ${original.sessionId}) where id = ${other.sessionId}`);

    const response = await signOutJson(other);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ redirectTo: null });
    expect(await sessionRows(other.sessionId)).toHaveLength(0);
    await flushMetadataDamageSightings();
    const sightings = await getDb().select().from(metadataDamageSightings)
      .where(eq(metadataDamageSightings.rowId, other.sessionId));
    expect(sightings).toHaveLength(1);
  });

  it("sends an ID token that has already expired, unchanged: sessions outlive provider tokens", async () => {
    const fixture = await createIntegrationFixture("id-token-expired");
    const expired = await signedIdToken({ expiresInSeconds: -3600 });
    const session = await fixture.session("member", { idToken: expired });
    mockProvider();

    const body = (await (await signOutJson(session)).json()) as { redirectTo: string | null };
    expect(new URL(body.redirectTo!).searchParams.get("id_token_hint")).toBe(expired);
  });

  it("stores no token over 16 KiB, still lets the person in, and signs out locally", async () => {
    const fixture = await createIntegrationFixture("id-token-oversize");
    const oversize = await signedIdToken({ padBytes: OVERSIZE_BYTES });
    expect(Buffer.byteLength(oversize, "utf8")).toBeGreaterThan(OVERSIZE_BYTES);
    const session = await fixture.session("member", { idToken: oversize });
    mockProvider();

    expect(await sessionRows(session.sessionId)).toHaveLength(1);
    expect(await storedIdToken(session.sessionId)).toBeNull();
    const response = await signOutJson(session);
    expect(await response.json()).toEqual({ redirectTo: null });
    expect(await sessionRows(session.sessionId)).toHaveLength(0);
  });

  it("stores a large token that is still under 16 KiB", async () => {
    const fixture = await createIntegrationFixture("id-token-under-bound");
    // The padding is base64-encoded inside the token, so 11 000 characters is about 14.7 KiB of token.
    const token = await signedIdToken({ padBytes: 11_000 });
    expect(Buffer.byteLength(token, "utf8")).toBeLessThanOrEqual(OVERSIZE_BYTES);
    expect(Buffer.byteLength(token, "utf8")).toBeGreaterThan(OVERSIZE_BYTES - 3000);
    const session = await fixture.session("member", { idToken: token });
    expect(await storedIdToken(session.sessionId)).toEqual(expect.stringMatching(/^mdv1\./));
  });

  it("shows neither the token nor its ciphertext on any session read", async () => {
    const fixture = await createIntegrationFixture("id-token-not-exposed");
    const idToken = await signedIdToken();
    const session = await fixture.session("member", { idToken });
    await fixture.session("member", { idToken: await signedIdToken() });

    const status = await (await checkSession(session)).text();
    const list = await (await callRouteForSession(listSessions, session, { url: LIST_URL })).text();
    const ciphertext = (await storedIdToken(session.sessionId))!;
    expect(ciphertext).toEqual(expect.stringMatching(/^mdv1\./));
    for (const body of [status, list]) {
      expect(body).not.toContain(idToken);
      expect(body).not.toContain(ciphertext);
      expect(body).not.toContain("mdv1.");
      expect(body.toLowerCase()).not.toContain("id_token");
      expect(body).not.toContain("idToken");
    }
  });

  it("deletes the token with the row on sign-out everywhere and on revoking one device", async () => {
    const fixture = await createIntegrationFixture("id-token-revoke");
    const laptop = await fixture.session("member", { idToken: await signedIdToken() });
    const phone = await fixture.session("member", { idToken: await signedIdToken() });
    const tablet = await fixture.session("member", { idToken: await signedIdToken() });

    const one = await callRouteForSession(revokeOneSession, laptop, {
      url: revokeOneUrl(phone.sessionId),
      method: "POST",
      params: { sessionId: phone.sessionId },
    });
    expect(one.status).toBe(200);
    expect(await storedIdToken(phone.sessionId)).toBeUndefined();

    const everywhere = await callRouteForSession(revokeSessions, laptop, { url: REVOKE_URL, method: "POST" });
    expect(everywhere.status).toBe(200);
    expect(await userSessionCount(laptop.userId)).toBe(0);
    expect(await storedIdToken(tablet.sessionId)).toBeUndefined();
  });

  it("deletes the token with the row when an administrator disables the account", async () => {
    const fixture = await createIntegrationFixture("id-token-disable");
    const admin = await fixture.session("admin");
    const member = await fixture.session("member", { idToken: await signedIdToken() });

    await setInstanceUserDisabled(admin.userId, member.userId, true);
    expect(await userSessionCount(member.userId)).toBe(0);
    expect(await storedIdToken(member.sessionId)).toBeUndefined();
  });

  it("deletes the token with the row when the password is replaced", async () => {
    const fixture = await createIntegrationFixture("id-token-password");
    const member = await fixture.session("member", { idToken: await signedIdToken() });

    // A first password revokes nothing; the second replaces one and takes the sessions with it.
    await setPassword(member.userId, await hashPassword("a-first-local-password"), member.userId);
    await setPassword(member.userId, await hashPassword("a-second-local-password"), member.userId);
    expect(await userSessionCount(member.userId)).toBe(0);
    expect(await storedIdToken(member.sessionId)).toBeUndefined();
  });

  it("deletes the token with the row when an expired session is presented", async () => {
    const fixture = await createIntegrationFixture("id-token-expired-presented");
    const member = await fixture.session("member", { idToken: await signedIdToken() });
    await fixture.expireSession(member);

    expect((await checkSession(member)).status).toBe(401);
    expect(await storedIdToken(member.sessionId)).toBeUndefined();
  });

  it("sweeps expired sessions, token and all, whenever anyone signs in, even if their cookie is never shown again", async () => {
    const fixture = await createIntegrationFixture("id-token-sweep");
    const forgotten = await fixture.session("member", { idToken: await signedIdToken() });
    const stillLive = await fixture.session("owner", { idToken: await signedIdToken() });
    await fixture.expireSession(forgotten);
    expect(await sessionRows(forgotten.sessionId)).toHaveLength(1);

    // Nobody presents the forgotten cookie; a different person signs in.
    await createSession(fixture.users.outsider.id, getAuthConfig());

    expect(await sessionRows(forgotten.sessionId)).toHaveLength(0);
    expect(await storedIdToken(forgotten.sessionId)).toBeUndefined();
    expect(await sessionRows(stillLive.sessionId)).toHaveLength(1);
  });

  it("still answers the hint after the key-encryption key has been rotated", async () => {
    const fixture = await createIntegrationFixture("id-token-rotation");
    const idToken = await signedIdToken();
    const session = await fixture.session("member", { idToken });
    mockProvider();
    const sealedBefore = await storedIdToken(session.sessionId);

    const current = getDocumentConfig();
    const originalKek = process.env.DOCUMENT_KEK;
    const nextKek = randomBytes(32);
    const keys: RotationKeys = {
      currentKek: current.keyEncryptionKey,
      currentKeyId: current.keyId,
      nextKek,
      nextKeyId: deriveDocumentKeyId(nextKek),
    };
    try {
      process.env.DOCUMENT_KEK_NEXT = nextKek.toString("hex");
      resetDocumentConfigForTests();
      resetMetadataKeyCacheForTests();
      expect(rotationComplete(await runKekRotationToCompletion(keys))).toBe(true);

      process.env.DOCUMENT_KEK = nextKek.toString("hex");
      delete process.env.DOCUMENT_KEK_NEXT;
      resetDocumentConfigForTests();
      resetMetadataKeyCacheForTests();

      // Only the key's wrapping moved; the session's own value is untouched.
      expect(await storedIdToken(session.sessionId)).toBe(sealedBefore);
      const body = (await (await signOutJson(session)).json()) as { redirectTo: string | null };
      expect(new URL(body.redirectTo!).searchParams.get("id_token_hint")).toBe(idToken);
    } finally {
      if (originalKek === undefined) delete process.env.DOCUMENT_KEK;
      else process.env.DOCUMENT_KEK = originalKek;
      delete process.env.DOCUMENT_KEK_NEXT;
      /* As metadata-addresses.test.ts does: a key row wrapped under a KEK
         nothing holds any more would lock every later file out. Dropped; the
         next writer mints a fresh one under the real key. */
      await getDb().delete(metadataKeys);
      resetDocumentConfigForTests();
      resetMetadataKeyCacheForTests();
    }
  }, 120_000);
});
