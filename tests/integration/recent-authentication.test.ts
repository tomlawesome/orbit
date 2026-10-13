/*
 * Recent authentication, end to end (ADR-0023 §5).
 *
 * The guard has two halves and one rule for choosing between them, and this
 * suite drives both through a real sensitive action — an administrator
 * creating a system for somebody else (#1052). What is proved here is the
 * challenge itself, not the system it guards.
 */

import { eq, inArray, like } from "drizzle-orm";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { getDb } from "@/db";
import {
  auditLog,
  externalIdentities,
  households,
  sessions,
  stepUpProofs,
  userPreferences,
  users,
} from "@/db/schema";
import { sessionCookieName } from "@/lib/auth/cookies";
import { hashPassword } from "@/lib/auth/password";
import type { RecentAuthentication } from "@/lib/auth/recent-auth";
import {
  completeStepUp,
  requireRecentAuthentication,
  sealStepUpProof,
  STEP_UP_PROOF_TTL_SECONDS,
  stepUpProofCookieName,
} from "@/lib/auth/recent-auth";
import type { VerifiedIdentity } from "@/lib/auth/oidc";
import { createSession, csrfTokenForSession, readSession } from "@/lib/auth/session";
import { getAuthConfig, resetAuthConfigForTests } from "@/lib/env";
import { createLocalUser } from "@/server/local-credentials";
import { cleanupIntegrationEnvironment } from "./support/fixtures";
import { callRoute, loadRoute } from "./support/request-event";
import { readSetCookie } from "./support/set-cookie";

/* Several accounts below sign in only through a provider, and an identity
   only counts as a way in while the provider is switched on (#1151 SS1-S1),
   so the key is on for this file and restored at the end. */
const previousOidcKey = process.env.ORBIT_AUTH_OIDC;
process.env.ORBIT_AUTH_OIDC = "true";
resetAuthConfigForTests();

const { POST: createSystem } = await loadRoute("admin/systems");

const ORIGIN = "http://127.0.0.1:3000";
const PASSWORD = "a-correct-local-password";
const WRONG_PASSWORD = "a-wrong-local-password";
const ISSUER = "https://oidc.invalid.example";
const SYSTEM_NAME = "Recent authentication system";

const created: string[] = [];

interface Actor {
  id: string;
  email: string;
  sessionId: string;
  cookie: string;
  csrfToken: string;
}

afterEach(async () => {
  const db = getDb();
  await db.delete(households).where(like(households.name, `${SYSTEM_NAME}%`));
  await db.delete(auditLog);
  if (created.length > 0) await db.delete(users).where(inArray(users.id, created));
  created.length = 0;
});

afterAll(async () => {
  if (previousOidcKey === undefined) delete process.env.ORBIT_AUTH_OIDC;
  else process.env.ORBIT_AUTH_OIDC = previousOidcKey;
  resetAuthConfigForTests();
  await cleanupIntegrationEnvironment();
});

/** A user with a password and no provider identity. */
async function localUser(label: string, options: { administrator?: boolean } = {}): Promise<string> {
  const user = await createLocalUser({
    email: `${label}@recent.invalid`,
    displayName: `Recent ${label}`,
    passwordHash: await hashPassword(PASSWORD),
  });
  created.push(user.id);
  if (options.administrator) {
    await getDb().update(users).set({ isInstanceAdmin: true }).where(eq(users.id, user.id));
  }
  return user.id;
}

/** A user with a provider identity and no password. */
async function oidcUser(label: string, options: { administrator?: boolean } = {}): Promise<string> {
  const [user] = await getDb().insert(users).values({
    email: `${label}@recent.invalid`,
    emailVerified: true,
    displayName: `Recent ${label}`,
    isInstanceAdmin: options.administrator === true,
  }).returning({ id: users.id });
  created.push(user.id);
  await getDb().insert(userPreferences).values({ userId: user.id });
  await getDb().insert(externalIdentities).values({ userId: user.id, issuer: ISSUER, subject: `recent-${label}` });
  return user.id;
}

function identityOf(label: string): VerifiedIdentity {
  return {
    issuer: ISSUER,
    subject: `recent-${label}`,
    email: `${label}@recent.invalid`,
    emailVerified: true,
    displayName: `Recent ${label}`,
    avatarUrl: null,
  };
}

async function actorFor(userId: string): Promise<Actor> {
  const config = getAuthConfig();
  const { token } = await createSession(userId, config);
  const session = await readSession(
    { get: (name) => (name === sessionCookieName(config) ? token : undefined) },
    config,
  );
  if (!session) throw new Error("The session was not persisted");
  /* Readable here by construction: these journeys run with a working key, and
     the address is encrypted now (#969), so a null would mean the fixture lost
     the key rather than that the account has no address. Fail loudly. */
  if (session.user.email === null) throw new Error("The account address could not be read");
  return {
    id: userId,
    email: session.user.email,
    sessionId: session.id,
    cookie: `${sessionCookieName(config)}=${token}`,
    csrfToken: csrfTokenForSession(session, config),
  };
}

/** How many systems the guarded action has made so far. */
async function systemsMade(): Promise<number> {
  return (await getDb().select({ id: households.id }).from(households).where(eq(households.name, SYSTEM_NAME))).length;
}

/** The sensitive action, called exactly as a browser would. */
async function createSystemAs(
  actor: Actor,
  ownerId: string,
  options: { currentPassword?: string; proof?: string } = {},
): Promise<Response> {
  const config = getAuthConfig();
  const cookie = options.proof === undefined
    ? actor.cookie
    : `${actor.cookie}; ${stepUpProofCookieName(config)}=${options.proof}`;
  return callRoute(createSystem, {
    url: `${ORIGIN}/api/admin/systems`,
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: ORIGIN,
      "sec-fetch-site": "same-origin",
      "x-csrf-token": actor.csrfToken,
      cookie,
    },
    body: JSON.stringify({
      name: SYSTEM_NAME,
      ownerId,
      ...(options.currentPassword === undefined ? {} : { currentPassword: options.currentPassword }),
    }),
  });
}

/** The guard alone, called with one proof cookie and nothing else. */
function guardWith(actor: Actor, proof: string): Promise<RecentAuthentication> {
  return requireRecentAuthentication(
    { cookies: { get: () => proof, set: () => {} } },
    { id: actor.sessionId, user: { id: actor.id, email: actor.email } },
    {},
    "system_create",
  );
}

async function errorCode(response: Response): Promise<string> {
  const body = (await response.clone().json()) as { error?: { code?: string } };
  return body.error?.code ?? "";
}

describe("recent authentication: the password challenge (ADR-0023 §5)", () => {
  it("refuses a missing or wrong password, accepts the right one, and does not care how old the session is", async () => {
    const actorId = await localUser("admin-local", { administrator: true });
    const ownerId = await localUser("owner-local", { administrator: true });
    const actor = await actorFor(actorId);

    const unchallenged = await createSystemAs(actor, ownerId);
    expect(unchallenged.status).toBe(403);
    expect(await errorCode(unchallenged)).toBe("recent_authentication_required");

    const wrong = await createSystemAs(actor, ownerId, { currentPassword: WRONG_PASSWORD });
    expect(wrong.status).toBe(403);
    expect(await errorCode(wrong)).toBe("recent_authentication_required");
    expect(await systemsMade()).toBe(0);

    /* Sixteen minutes old: #263 refused this outright and asked for a fresh
       sign-in. The window is gone, so what decides is the password. */
    await getDb().update(sessions)
      .set({ createdAt: new Date(Date.now() - 16 * 60 * 1000) })
      .where(eq(sessions.id, actor.sessionId));

    const accepted = await createSystemAs(actor, ownerId, { currentPassword: PASSWORD });
    expect(accepted.status).toBe(201);
    expect(await systemsMade()).toBe(1);
  });

  it("challenges someone who has both methods with the password, not with a step-up proof", async () => {
    const actorId = await localUser("admin-both", { administrator: true });
    await getDb().insert(externalIdentities).values({
      userId: actorId,
      issuer: ISSUER,
      subject: "recent-admin-both",
    });
    const ownerId = await oidcUser("owner-both", { administrator: true });
    const actor = await actorFor(actorId);

    const config = getAuthConfig();
    const proof = await sealStepUpProof(actor.sessionId, "system_create", config);
    const withProof = await createSystemAs(actor, ownerId, { proof });
    expect(withProof.status).toBe(403);
    expect(await errorCode(withProof)).toBe("recent_authentication_required");
    expect(await systemsMade()).toBe(0);

    const withPassword = await createSystemAs(actor, ownerId, { currentPassword: PASSWORD });
    expect(withPassword.status).toBe(201);
    expect(await systemsMade()).toBe(1);
  });
});

describe("recent authentication: the OIDC step-up (ADR-0023 §5)", () => {
  it("needs a proof bound to this session and this action, and spends it once", async () => {
    const actorId = await oidcUser("admin-oidc", { administrator: true });
    const ownerId = await oidcUser("owner-oidc", { administrator: true });
    const actor = await actorFor(actorId);
    const other = await actorFor(ownerId);
    const config = getAuthConfig();

    const unchallenged = await createSystemAs(actor, ownerId);
    expect(unchallenged.status).toBe(403);
    expect(await errorCode(unchallenged)).toBe("recent_authentication_required");

    // A password is not the challenge for someone who has none.
    const password = await createSystemAs(actor, ownerId, { currentPassword: PASSWORD });
    expect(await errorCode(password)).toBe("recent_authentication_required");

    // Another session's proof, and a proof earned for another action.
    for (const proof of [
      await sealStepUpProof(other.sessionId, "system_create", config),
      await sealStepUpProof(actor.sessionId, "password_change", config),
    ]) {
      const response = await createSystemAs(actor, ownerId, { proof });
      expect(response.status).toBe(403);
      expect(await errorCode(response)).toBe("recent_authentication_required");
    }
    expect(await systemsMade()).toBe(0);

    const proof = await sealStepUpProof(actor.sessionId, "system_create", config);
    const accepted = await createSystemAs(actor, ownerId, { proof });
    expect(accepted.status).toBe(201);
    expect(await systemsMade()).toBe(1);
    // Spent: the answer clears the cookie, so the browser cannot present it
    // again for the next sensitive action.
    expect(readSetCookie(accepted, stepUpProofCookieName(config))).toMatchObject({ value: "", maxAge: 0 });

    /* And a refused one is cleared too, rather than left to be retried. The
       proof is sealed for a real but different session, because a proof is now
       a row keyed on a live session (0039_step_up_proofs) and one bound to a
       session that never existed cannot be minted at all. */
    const spent = await createSystemAs(await actorFor(actorId), ownerId, {
      proof: await sealStepUpProof(other.sessionId, "system_create", config),
    });
    expect(readSetCookie(spent, stepUpProofCookieName(config))).toMatchObject({ value: "", maxAge: 0 });
  });

  it("only mints a proof for the identity that holds the session being challenged", async () => {
    const actorId = await oidcUser("stepup-holder");
    await oidcUser("stepup-stranger");
    const actor = await actorFor(actorId);
    const config = getAuthConfig();

    const proof = await completeStepUp({
      identity: identityOf("stepup-holder"),
      sessionId: actor.sessionId,
      intent: "system_create",
      config,
    });
    /* The guard accepts what the callback minted — the two halves agree, which
       is the property a hand-written proof in another suite cannot prove. */
    await expect(requireRecentAuthentication(
      { cookies: { get: () => proof, set: () => {} } },
      { id: actor.sessionId, user: { id: actorId, email: actor.email } },
      {},
      "system_create",
    )).resolves.toMatchObject({ userId: actorId, intent: "system_create", method: "step_up" });

    // Someone else re-authenticating at the provider proves nothing about the
    // person holding this session.
    await expect(completeStepUp({
      identity: identityOf("stepup-stranger"),
      sessionId: actor.sessionId,
      intent: "system_create",
      config,
    })).rejects.toMatchObject({ code: "step_up_failed", status: 403 });

    // An identity Orbit has never seen is not proof either.
    await expect(completeStepUp({
      identity: identityOf("nobody-at-all"),
      sessionId: actor.sessionId,
      intent: "system_create",
      config,
    })).rejects.toMatchObject({ code: "step_up_failed" });

    // Nor is a session that has expired while the browser was at the provider.
    await getDb().update(sessions).set({ expiresAt: new Date(0) }).where(eq(sessions.id, actor.sessionId));
    await expect(completeStepUp({
      identity: identityOf("stepup-holder"),
      sessionId: actor.sessionId,
      intent: "system_create",
      config,
    })).rejects.toMatchObject({ code: "step_up_failed" });
  });

  it("spends a proof on the server, so a copied cookie cannot be replayed", async () => {
    /* The gap this closes (owner ruling, 2026-09-09): clearing the cookie only
       disarms the browser that presented it. Anyone who had copied the value
       out of that browser could present it again for the rest of its two
       minutes, and the guard had no way to tell the copy from the original. */
    const actorId = await oidcUser("stepup-replay");
    const actor = await actorFor(actorId);
    const config = getAuthConfig();
    const proof = await completeStepUp({
      identity: identityOf("stepup-replay"),
      sessionId: actor.sessionId,
      intent: "system_create",
      config,
    });

    await expect(guardWith(actor, proof)).resolves.toMatchObject({ method: "step_up" });

    // The identical cookie value, well inside its life: refused, because the
    // row behind it is already spent.
    await expect(guardWith(actor, proof)).rejects.toMatchObject({
      code: "recent_authentication_required",
      status: 403,
    });

    const [row] = await getDb()
      .select({ consumedAt: stepUpProofs.consumedAt })
      .from(stepUpProofs)
      .where(eq(stepUpProofs.sessionId, actor.sessionId));
    expect(row?.consumedAt).toBeInstanceOf(Date);
  });

  it("refuses a proof whose session has been revoked", async () => {
    const actorId = await oidcUser("stepup-revoked");
    const actor = await actorFor(actorId);
    const config = getAuthConfig();
    const proof = await completeStepUp({
      identity: identityOf("stepup-revoked"),
      sessionId: actor.sessionId,
      intent: "system_create",
      config,
    });

    /* Revocation deletes the `sessions` row, and the proof cascades with it:
       a step-up earned by a session must not outlive the session it proves. */
    await getDb().delete(sessions).where(eq(sessions.id, actor.sessionId));
    expect(await getDb().select().from(stepUpProofs).where(eq(stepUpProofs.sessionId, actor.sessionId))).toEqual([]);

    await expect(guardWith(actor, proof)).rejects.toMatchObject({
      code: "recent_authentication_required",
      status: 403,
    });
  });

  it("mints a proof that expires on its own", async () => {
    // The TTL is the cookie's, the seal's and the row's: a proof left behind is
    // worth nothing two minutes later, and the next mint sweeps the dead row.
    expect(STEP_UP_PROOF_TTL_SECONDS).toBe(120);
    const actorId = await oidcUser("stepup-ttl");
    const actor = await actorFor(actorId);
    const config = getAuthConfig();
    const proof = await completeStepUp({
      identity: identityOf("stepup-ttl"),
      sessionId: actor.sessionId,
      intent: "system_create",
      config,
    });
    expect(proof.split(".").length).toBe(5);
  });
});
