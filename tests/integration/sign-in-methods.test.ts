/*
 * Sign-in methods, end to end (ADR-0023 §6).
 *
 * A reader sees how they sign in, adds a provider identity to the account they
 * are already signed in to, and removes either method — as long as one usable
 * one is left. The three properties this suite exists to hold:
 *
 *  - **A link binds to the session's user.** The account is the one sealed
 *    into the transaction by `link/oidc/start`, so the whole journey is driven
 *    here rather than a hand-sealed transaction: the route that seals and the
 *    callback that opens have to agree, and only the real pair proves that.
 *  - **A provider account belongs to one Orbit account.** `link_exists`, from
 *    the unique index, and nothing is moved.
 *  - **One usable method survives.** `link_last_method` — and an identity is
 *    not usable while `ORBIT_AUTH_OIDC` is false, which is the case a test can
 *    only reach by turning the key off, so it does.
 *
 * The provider itself is mocked at `discoverProvider`/`completeAuthorization`,
 * exactly as `auth-session-contracts.test.ts` mocks discovery: what is under
 * test is Orbit's half of the exchange, and `src/lib/auth/oidc.test.ts` owns
 * the token and claim rules.
 */

import { and, eq, inArray } from "drizzle-orm";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/db";
import { auditLog, externalIdentities, localCredentials, userPreferences, users } from "@/db/schema";
import { sessionCookieName, transactionCookieName } from "@/lib/auth/cookies";
import { openLoginTransaction } from "@/lib/auth/crypto";
import * as oidc from "@/lib/auth/oidc";
import type { OidcMetadata, VerifiedIdentity } from "@/lib/auth/oidc";
import { hashPassword } from "@/lib/auth/password";
import { provisionIdentity } from "@/lib/auth/provision";
import { sealStepUpProof, stepUpProofCookieName } from "@/lib/auth/recent-auth";
import { createSession, csrfTokenForSession, readSession } from "@/lib/auth/session";
import { getAuthConfig, resetAuthConfigForTests } from "@/lib/env";
import { createLocalUser, listMethods, verifyCredential } from "@/server/local-credentials";
import { cleanupIntegrationEnvironment } from "./support/fixtures";
import { callRoute, loadRoute } from "./support/request-event";
import { readSetCookie } from "./support/set-cookie";

/* Linking needs the provider switched on (ADR-0023 §1), and the run's
   environment leaves it off. This file turns it on for itself, one test turns
   it back off to prove what "usable" means, and the key is restored at the
   end. */
const previousOidcKey = process.env.ORBIT_AUTH_OIDC;
process.env.ORBIT_AUTH_OIDC = "true";
resetAuthConfigForTests();

const { GET: readMethods } = await loadRoute("auth/methods");
const { DELETE: removeLocal } = await loadRoute("auth/methods/local");
const { DELETE: removeIdentity } = await loadRoute("auth/methods/oidc/[identityId]");
const { POST: startLink } = await loadRoute("auth/link/oidc/start");
const { GET: callback } = await loadRoute("auth/callback");

const ORIGIN = "http://127.0.0.1:3000";
const ISSUER = "https://oidc.invalid.example";
const PASSWORD = "a-correct-local-password";
const WRONG_PASSWORD = "a-wrong-local-password";

const METADATA: OidcMetadata = {
  issuer: ISSUER,
  authorization_endpoint: `${ISSUER}/authorize`,
  token_endpoint: `${ISSUER}/token`,
  jwks_uri: `${ISSUER}/jwks`,
  code_challenge_methods_supported: ["S256"],
};

const created: string[] = [];

interface Actor {
  id: string;
  email: string;
  sessionId: string;
  cookie: string;
  csrfToken: string;
}

beforeEach(() => {
  vi.spyOn(oidc, "discoverProvider").mockResolvedValue(METADATA);
});

afterEach(async () => {
  vi.restoreAllMocks();
  const db = getDb();
  await db.delete(auditLog);
  if (created.length > 0) await db.delete(users).where(inArray(users.id, created));
  created.length = 0;
  if (process.env.ORBIT_AUTH_OIDC !== "true") {
    process.env.ORBIT_AUTH_OIDC = "true";
    resetAuthConfigForTests();
  }
});

afterAll(async () => {
  if (previousOidcKey === undefined) delete process.env.ORBIT_AUTH_OIDC;
  else process.env.ORBIT_AUTH_OIDC = previousOidcKey;
  await cleanupIntegrationEnvironment();
});

function identityOf(label: string): VerifiedIdentity {
  return {
    issuer: ISSUER,
    subject: `methods-${label}`,
    email: `${label}@methods.invalid`,
    emailVerified: true,
    displayName: `Methods ${label}`,
    avatarUrl: null,
  };
}

/** A user with a password and, optionally, a provider identity already linked. */
async function localUser(label: string, options: { identity?: boolean } = {}): Promise<string> {
  const user = await createLocalUser({
    email: `${label}@methods.invalid`,
    displayName: `Methods ${label}`,
    passwordHash: await hashPassword(PASSWORD),
  });
  created.push(user.id);
  if (options.identity) {
    await getDb().insert(externalIdentities).values({
      userId: user.id,
      issuer: ISSUER,
      subject: `methods-${label}`,
    });
  }
  return user.id;
}

/** A user with a provider identity and no password. */
async function oidcUser(label: string): Promise<string> {
  const [user] = await getDb().insert(users).values({
    email: `${label}@methods.invalid`,
    emailVerified: true,
    displayName: `Methods ${label}`,
  }).returning({ id: users.id });
  created.push(user.id);
  await getDb().insert(userPreferences).values({ userId: user.id });
  await getDb().insert(externalIdentities).values({
    userId: user.id,
    issuer: ISSUER,
    subject: `methods-${label}`,
  });
  return user.id;
}

async function actorFor(userId: string): Promise<Actor> {
  const config = getAuthConfig();
  const { token } = await createSession(userId, config);
  const session = await readSession(
    { get: (name) => (name === sessionCookieName(config) ? token : undefined) },
    config,
  );
  if (!session) throw new Error("The session was not persisted");
  return {
    id: userId,
    email: session.user.email,
    sessionId: session.id,
    cookie: `${sessionCookieName(config)}=${token}`,
    csrfToken: csrfTokenForSession(session, config),
  };
}

function writeHeaders(actor: Actor, extraCookies: string[] = []): Record<string, string> {
  return {
    "content-type": "application/json",
    origin: ORIGIN,
    "sec-fetch-site": "same-origin",
    "x-csrf-token": actor.csrfToken,
    cookie: [actor.cookie, ...extraCookies].join("; "),
  };
}

async function errorCode(response: Response): Promise<string> {
  const body = (await response.clone().json()) as { error?: { code?: string } };
  return body.error?.code ?? "";
}

/** The challenge a route carries: a password in the body, or a proof cookie. */
interface Challenge {
  currentPassword?: string;
  proof?: string;
}

function challengeCookies(challenge: Challenge): string[] {
  if (challenge.proof === undefined) return [];
  return [`${stepUpProofCookieName(getAuthConfig())}=${challenge.proof}`];
}

function challengeBody(challenge: Challenge, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    ...extra,
    ...(challenge.currentPassword === undefined ? {} : { currentPassword: challenge.currentPassword }),
  });
}

async function linkStart(actor: Actor, challenge: Challenge = {}): Promise<Response> {
  return callRoute(startLink, {
    url: `${ORIGIN}/api/auth/link/oidc/start`,
    method: "POST",
    headers: writeHeaders(actor, challengeCookies(challenge)),
    body: challengeBody(challenge, { returnTo: "/settings" }),
  });
}

async function deleteLocal(actor: Actor, challenge: Challenge = {}): Promise<Response> {
  return callRoute(removeLocal, {
    url: `${ORIGIN}/api/auth/methods/local`,
    method: "DELETE",
    headers: writeHeaders(actor, challengeCookies(challenge)),
    body: challengeBody(challenge),
  });
}

async function deleteIdentity(actor: Actor, identityId: string, challenge: Challenge = {}): Promise<Response> {
  return callRoute(removeIdentity, {
    url: `${ORIGIN}/api/auth/methods/oidc/${identityId}`,
    method: "DELETE",
    params: { identityId },
    headers: writeHeaders(actor, challengeCookies(challenge)),
    body: challengeBody(challenge),
  });
}

/**
 * Walks the browser's half of a link: start the flow, take the transaction
 * cookie and the state the route actually sealed, and hand them back to the
 * callback with the identity the provider would have verified.
 */
async function completeLink(actor: Actor, identity: VerifiedIdentity, challenge: Challenge): Promise<Response> {
  const config = getAuthConfig();
  const started = await linkStart(actor, challenge);
  expect(started.status).toBe(302);
  const authorizationUrl = new URL(started.headers.get("location") ?? "");
  const transactionCookie = readSetCookie(started, transactionCookieName(config))?.value ?? "";

  vi.spyOn(oidc, "completeAuthorization").mockResolvedValue(identity);
  return callRoute(callback, {
    url: `${ORIGIN}/api/auth/callback?code=provider-code&state=${authorizationUrl.searchParams.get("state")}`,
    headers: { cookie: `${transactionCookieName(config)}=${transactionCookie}` },
  });
}

async function identityRows(userId: string) {
  return getDb().select({ id: externalIdentities.id, subject: externalIdentities.subject })
    .from(externalIdentities)
    .where(eq(externalIdentities.userId, userId));
}

async function auditActions(userId: string): Promise<string[]> {
  const rows = await getDb().select({ action: auditLog.action })
    .from(auditLog)
    .where(eq(auditLog.entityId, userId));
  return rows.map((row) => row.action);
}

describe("the sign-in methods list (ADR-0023 §6)", () => {
  it("lists the caller's own password and identities, and nobody else's", async () => {
    const actorId = await localUser("list-owner", { identity: true });
    const strangerId = await oidcUser("list-stranger");
    const actor = await actorFor(actorId);
    const [stranger] = await identityRows(strangerId);

    const response = await callRoute(readMethods, {
      url: `${ORIGIN}/api/auth/methods`,
      headers: { cookie: actor.cookie },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");

    const body = await response.json();
    expect(body.local).toEqual({ set: true, changedAt: expect.any(String) });
    expect(body.oidc).toHaveLength(1);
    expect(body.oidc[0]).toEqual({
      id: expect.any(String),
      issuer: ISSUER,
      linkedAt: expect.any(String),
      lastLoginAt: expect.any(String),
    });
    // The provider's opaque identifier for the person is not in the answer.
    expect(Object.keys(body.oidc[0]).sort()).toEqual(["id", "issuer", "lastLoginAt", "linkedAt"]);
    expect(body.oidc.map((row: { id: string }) => row.id)).not.toContain(stranger.id);
  });

  it("says nothing at all to a caller with no session", async () => {
    const response = await callRoute(readMethods, { url: `${ORIGIN}/api/auth/methods` });
    expect(response.status).toBe(401);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
});

describe("linking a provider identity (ADR-0023 §6)", () => {
  it("links the session's own user, signs nobody in, and leaves both methods working", async () => {
    const actorId = await localUser("link-local");
    const actor = await actorFor(actorId);
    const config = getAuthConfig();
    const identity = identityOf("link-local-provider");

    // Unchallenged, the flow does not even start: no transaction is sealed.
    const unchallenged = await linkStart(actor);
    expect(unchallenged.status).toBe(403);
    expect(await errorCode(unchallenged)).toBe("recent_authentication_required");
    expect(readSetCookie(unchallenged, transactionCookieName(config))).toBeUndefined();
    expect(await errorCode(await linkStart(actor, { currentPassword: WRONG_PASSWORD })))
      .toBe("recent_authentication_required");

    const started = await linkStart(actor, { currentPassword: PASSWORD });
    expect(started.status).toBe(302);
    const sealed = readSetCookie(started, transactionCookieName(config))?.value ?? "";
    // The account is decided here, sealed, before the browser ever leaves.
    expect(await openLoginTransaction(sealed, config)).toMatchObject({ linkUserId: actorId });

    const authorizationUrl = new URL(started.headers.get("location") ?? "");
    expect(authorizationUrl.origin).toBe(new URL(METADATA.authorization_endpoint).origin);
    // A link is not a re-authentication, so it asks for no `max_age`.
    expect(authorizationUrl.searchParams.get("max_age")).toBeNull();

    vi.spyOn(oidc, "completeAuthorization").mockResolvedValue(identity);
    const returned = await callRoute(callback, {
      url: `${ORIGIN}/api/auth/callback?code=provider-code&state=${authorizationUrl.searchParams.get("state")}`,
      headers: { cookie: `${transactionCookieName(config)}=${sealed}` },
    });
    expect(returned.status).toBe(303);
    expect(returned.headers.get("location")).toBe(`${ORIGIN}/settings`);
    // Nothing signed in and nothing replaced: the person already had a session.
    expect(readSetCookie(returned, sessionCookieName(config))).toBeUndefined();
    expect(readSetCookie(returned, transactionCookieName(config))).toMatchObject({ value: "", maxAge: 0 });

    const methods = await listMethods(actorId);
    expect(methods.local.set).toBe(true);
    expect(methods.oidc).toHaveLength(1);
    expect(await auditActions(actorId)).toEqual(["identity_linked"]);

    // Both methods now sign the same person in — the point of the whole slice.
    await expect(verifyCredential(actor.email, PASSWORD)).resolves.toEqual({
      outcome: "verified",
      userId: actorId,
    });
    await expect(provisionIdentity(identity)).resolves.toMatchObject({ id: actorId });
  });

  it("refuses a provider account that already belongs to somebody else, and moves nothing", async () => {
    const actorId = await localUser("link-contested");
    const holderId = await oidcUser("link-holder");
    const actor = await actorFor(actorId);

    const returned = await completeLink(actor, identityOf("link-holder"), { currentPassword: PASSWORD });
    expect(returned.status).toBe(303);
    expect(returned.headers.get("location")).toBe(`${ORIGIN}/auth/error?code=link_exists`);

    expect(await identityRows(actorId)).toHaveLength(0);
    expect(await identityRows(holderId)).toHaveLength(1);
    expect(await auditActions(actorId)).toEqual([]);
  });

  it("starts no link without a session, a CSRF token, or a same-origin post", async () => {
    const actorId = await localUser("link-refused");
    const actor = await actorFor(actorId);
    const config = getAuthConfig();

    const signedOut = await callRoute(startLink, {
      url: `${ORIGIN}/api/auth/link/oidc/start`,
      method: "POST",
      headers: { "content-type": "application/json", origin: ORIGIN },
      body: JSON.stringify({ currentPassword: PASSWORD }),
    });
    expect(signedOut.status).toBe(401);

    const noCsrf = await callRoute(startLink, {
      url: `${ORIGIN}/api/auth/link/oidc/start`,
      method: "POST",
      headers: { ...writeHeaders(actor), "x-csrf-token": "invalid-csrf" },
      body: JSON.stringify({ currentPassword: PASSWORD }),
    });
    expect(noCsrf.status).toBe(403);
    expect(await errorCode(noCsrf)).toBe("csrf_failed");

    const crossSite = await callRoute(startLink, {
      url: `${ORIGIN}/api/auth/link/oidc/start`,
      method: "POST",
      headers: { ...writeHeaders(actor), origin: "https://attacker.invalid" },
      body: JSON.stringify({ currentPassword: PASSWORD }),
    });
    expect(crossSite.status).toBe(403);

    expect(readSetCookie(crossSite, transactionCookieName(config))).toBeUndefined();
    expect(await identityRows(actorId)).toHaveLength(0);
  });
});

describe("removing a sign-in method (ADR-0023 §6)", () => {
  it("removes the password of someone who can still sign in with their provider", async () => {
    const actorId = await localUser("remove-password", { identity: true });
    const actor = await actorFor(actorId);

    const unchallenged = await deleteLocal(actor);
    expect(unchallenged.status).toBe(403);
    expect(await errorCode(unchallenged)).toBe("recent_authentication_required");

    const removed = await deleteLocal(actor, { currentPassword: PASSWORD });
    expect(removed.status).toBe(200);
    expect(removed.headers.get("cache-control")).toBe("no-store");
    expect(await removed.json()).toEqual({ removed: true });

    expect(await listMethods(actorId)).toMatchObject({ local: { set: false, changedAt: null } });
    expect(await auditActions(actorId)).toEqual(["password_removed"]);
    // The session survives: removing a method is not a password change.
    await expect(verifyCredential(actor.email, PASSWORD)).resolves.toEqual({ outcome: "rejected" });
  });

  it("removes an identity from someone who still has a password, and only their own", async () => {
    const actorId = await localUser("remove-identity", { identity: true });
    const strangerId = await oidcUser("remove-stranger");
    const actor = await actorFor(actorId);
    const [own] = await identityRows(actorId);
    const [stranger] = await identityRows(strangerId);

    /* Somebody else's identity id is not found rather than refused: the answer
       must not tell a caller which identities exist. */
    const wrongOwner = await deleteIdentity(actor, stranger.id, { currentPassword: PASSWORD });
    expect(wrongOwner.status).toBe(404);
    const missing = await deleteIdentity(actor, "00000000-0000-4000-8000-000000000000", {
      currentPassword: PASSWORD,
    });
    expect(missing.status).toBe(404);
    expect(await errorCode(missing)).toBe(await errorCode(wrongOwner));
    expect(await identityRows(strangerId)).toHaveLength(1);

    const removed = await deleteIdentity(actor, own.id, { currentPassword: PASSWORD });
    expect(removed.status).toBe(200);
    expect(await removed.json()).toEqual({ removed: true });
    expect(await identityRows(actorId)).toHaveLength(0);
    expect(await auditActions(actorId)).toEqual(["identity_unlinked"]);
  });

  it("keeps the last usable method, whichever one it is", async () => {
    const localOnlyId = await localUser("last-local");
    const localOnly = await actorFor(localOnlyId);
    const oidcOnlyId = await oidcUser("last-oidc");
    const oidcOnly = await actorFor(oidcOnlyId);
    const [onlyIdentity] = await identityRows(oidcOnlyId);
    const config = getAuthConfig();

    const lastPassword = await deleteLocal(localOnly, { currentPassword: PASSWORD });
    expect(lastPassword.status).toBe(409);
    expect(await errorCode(lastPassword)).toBe("link_last_method");
    expect(await listMethods(localOnlyId)).toMatchObject({ local: { set: true } });

    /* Someone with no password is challenged by a step-up, so the refusal has
       to survive a genuine proof rather than being an unchallenged request in
       disguise. */
    const lastIdentity = await deleteIdentity(oidcOnly, onlyIdentity.id, {
      proof: await sealStepUpProof(oidcOnly.sessionId, "unlink_method", config),
    });
    expect(lastIdentity.status).toBe(409);
    expect(await errorCode(lastIdentity)).toBe("link_last_method");
    expect(await identityRows(oidcOnlyId)).toHaveLength(1);
  });

  it("does not count an identity as usable while ORBIT_AUTH_OIDC is false", async () => {
    const actorId = await localUser("switched-off", { identity: true });
    const actor = await actorFor(actorId);

    process.env.ORBIT_AUTH_OIDC = "false";
    resetAuthConfigForTests();

    /* The identity is still linked and still listed — turning the provider off
       does not unlink anybody — but it is no longer a way in, so the password
       is now the only usable method and cannot be removed. */
    expect(await listMethods(actorId)).toMatchObject({ oidc: [{ issuer: ISSUER }] });
    const refused = await deleteLocal(actor, { currentPassword: PASSWORD });
    expect(refused.status).toBe(409);
    expect(await errorCode(refused)).toBe("link_last_method");
    expect(await getDb().select({ userId: localCredentials.userId })
      .from(localCredentials)
      .where(eq(localCredentials.userId, actorId))).toHaveLength(1);

    // The identity itself is still removable: the password remains usable.
    const [identity] = await identityRows(actorId);
    const removed = await deleteIdentity(actor, identity.id, { currentPassword: PASSWORD });
    expect(removed.status).toBe(200);
    expect(await identityRows(actorId)).toHaveLength(0);
  });

  it("refuses a proof earned for another action or another session", async () => {
    const actorId = await oidcUser("proof-bound");
    const secondId = await oidcUser("proof-other");
    const actor = await actorFor(actorId);
    const other = await actorFor(secondId);
    const config = getAuthConfig();
    // A second identity, so the removal would otherwise be allowed.
    await getDb().insert(externalIdentities).values({
      userId: actorId,
      issuer: ISSUER,
      subject: "methods-proof-bound-second",
    });
    const [target] = await getDb().select({ id: externalIdentities.id })
      .from(externalIdentities)
      .where(and(eq(externalIdentities.userId, actorId), eq(externalIdentities.subject, "methods-proof-bound")));

    for (const proof of [
      await sealStepUpProof(other.sessionId, "unlink_method", config),
      await sealStepUpProof(actor.sessionId, "password_change", config),
    ]) {
      const response = await deleteIdentity(actor, target.id, { proof });
      expect(response.status).toBe(403);
      expect(await errorCode(response)).toBe("recent_authentication_required");
    }
    expect(await identityRows(actorId)).toHaveLength(2);

    const accepted = await deleteIdentity(actor, target.id, {
      proof: await sealStepUpProof(actor.sessionId, "unlink_method", config),
    });
    expect(accepted.status).toBe(200);
    expect(await identityRows(actorId)).toHaveLength(1);
    // Spent: the answer clears the cookie rather than leaving it to be reused.
    expect(readSetCookie(accepted, stepUpProofCookieName(config))).toMatchObject({ value: "", maxAge: 0 });
  });
});
