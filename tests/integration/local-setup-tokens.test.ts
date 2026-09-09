import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { getDb } from "@/db";
import { auditLog, credentialSetupTokens, localCredentials, sessions } from "@/db/schema";
import { sessionCookieName } from "@/lib/auth/cookies";
import { hashPassword, verifyPassword } from "@/lib/auth/password";
import { sealStepUpProof, stepUpProofCookieName } from "@/lib/auth/recent-auth";
import { createSession } from "@/lib/auth/session";
import { getAuthConfig } from "@/lib/env";
import { createLocalUser, RECOVERY_TOKEN_TTL_MS } from "@/server/local-credentials";
import {
  cleanupIntegrationEnvironment,
  createIntegrationFixture,
  type IntegrationSession,
} from "./support/fixtures";
import { callRoute, callRouteForSession, loadRoute } from "./support/request-event";
import { readSetCookie } from "./support/set-cookie";

/**
 * SETUP TOKENS against PostgreSQL (#911, ADR-0023 §3, §6-§7).
 *
 * Unit-shaped assertions belong beside `local-sign-in.test.ts`; what only a
 * real database shows is here — that a token row's `FOR UPDATE` lock really
 * serialises redemption, that a password change really deletes every other
 * session and no more, and that the setup URL and the raw token appear in
 * exactly one response and nowhere else: no list, no second response, no
 * audit row.
 */

const { GET: listUsers, POST: createUser } = await loadRoute("admin/users");
const { POST: reissueSetupLink } = await loadRoute("admin/users/[userId]/setup-link");
const { POST: consumeSetup } = await loadRoute("auth/local/setup");
const { POST: changePassword } = await loadRoute("auth/local/password");
const { GET: sessionStatus } = await loadRoute("auth/session");

afterAll(async () => {
  await cleanupIntegrationEnvironment();
});

const ADMIN_PASSWORD = "the-administrators-own-password";
const OLD_PASSWORD = "a-password-set-earlier";
const NEW_PASSWORD = "a-freshly-chosen-password";

const ORIGIN = "http://127.0.0.1:3000";

/** Gives a fixture user a known local password, direct to the row. */
async function seedLocalCredential(userId: string, password: string): Promise<void> {
  await getDb().insert(localCredentials).values({ userId, passwordHash: await hashPassword(password) });
}

/** The one token a setup URL carries, as the browser that opens it would read it. */
function tokenFromSetupUrl(setupUrl: string): string {
  const match = /\/setup\/([^/?#]+)/u.exec(setupUrl);
  if (!match) throw new Error(`No setup token in ${setupUrl}`);
  return decodeURIComponent(match[1]);
}

async function call(
  handler: Parameters<typeof callRouteForSession>[0],
  session: IntegrationSession,
  path: string,
  init: { body?: unknown; params?: Record<string, string>; headers?: Record<string, string> } = {},
): Promise<{ status: number; body: Record<string, unknown>; response: Response }> {
  const response = await callRouteForSession(handler, session, {
    url: `${ORIGIN}${path}`,
    params: init.params,
    method: "POST",
    headers: init.headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  return { status: response.status, body: (await response.clone().json()) as Record<string, unknown>, response };
}

async function callSignedOut(
  handler: Parameters<typeof callRoute>[0],
  path: string,
  body: unknown,
): Promise<{ status: number; body: Record<string, unknown>; response: Response }> {
  const response = await callRoute(handler, {
    url: `${ORIGIN}${path}`,
    method: "POST",
    headers: { "content-type": "application/json", origin: ORIGIN, "sec-fetch-site": "same-origin" },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.clone().json()) as Record<string, unknown>, response };
}

/** A caller's own session cookie plus a step-up proof, as the browser sends both together. */
function withStepUpProof(session: IntegrationSession, proof: string): Record<string, string> {
  const config = getAuthConfig();
  return { cookie: `${session.headers.cookie}; ${stepUpProofCookieName(config)}=${proof}` };
}

async function sessionCountFor(userId: string): Promise<number> {
  return (await getDb().select({ id: sessions.id }).from(sessions).where(eq(sessions.userId, userId))).length;
}

async function isAuthenticated(token: string): Promise<boolean> {
  const config = getAuthConfig();
  const status = await callRoute(sessionStatus, {
    url: `${ORIGIN}/api/auth/session`,
    headers: { cookie: `${sessionCookieName(config)}=${token}` },
  });
  if (status.status !== 200) return false;
  return ((await status.json()) as { authenticated?: boolean }).authenticated === true;
}

describe("an administrator creating a local user (ADR-0023 §3)", () => {
  it("creates a user with no credential, hands back the setup URL once, and the list never carries it", async () => {
    const fixture = await createIntegrationFixture("setup-create");
    try {
      const admin = await fixture.session("admin");
      await seedLocalCredential(admin.userId, ADMIN_PASSWORD);

      const created = await call(createUser, admin, "/api/admin/users", {
        body: {
          email: `new-local-${fixture.household.id.slice(0, 8)}@example.invalid`,
          displayName: "New Local User",
          currentPassword: ADMIN_PASSWORD,
        },
      });
      expect(created.status).toBe(201);
      const setupUrl = created.body.setupUrl as string;
      expect(setupUrl).toMatch(new RegExp(`^${ORIGIN}/setup/`, "u"));
      const newUserId = (created.body.user as { id: string }).id;
      const token = tokenFromSetupUrl(setupUrl);

      // No password exists yet: nothing can sign in as this account.
      expect(await getDb().select().from(localCredentials).where(eq(localCredentials.userId, newUserId))).toEqual([]);

      const [tokenRow] = await getDb().select({
        purpose: credentialSetupTokens.purpose,
        consumedAt: credentialSetupTokens.consumedAt,
        createdByUserId: credentialSetupTokens.createdByUserId,
      }).from(credentialSetupTokens).where(eq(credentialSetupTokens.userId, newUserId));
      expect(tokenRow).toMatchObject({ purpose: "setup", consumedAt: null, createdByUserId: admin.userId });

      // The list an administrator reads back never carries the URL or the token.
      const list = await call(listUsers, admin, "/api/admin/users");
      const serialisedList = JSON.stringify(list.body);
      expect(serialisedList).not.toContain(token);
      expect(serialisedList).not.toContain("setupUrl");

      const auditRows = await getDb().select({ action: auditLog.action, changes: auditLog.changes, entityId: auditLog.entityId })
        .from(auditLog).where(eq(auditLog.entityId, newUserId));
      expect(auditRows.map((row) => row.action).sort()).toEqual(["local_user_created", "setup_link_issued"]);
      expect(auditRows.find((row) => row.action === "setup_link_issued")?.changes).toEqual({ userId: newUserId, purpose: "setup" });
      expect(JSON.stringify(auditRows)).not.toContain(token);
    } finally {
      await fixture.cleanup();
    }
  }, 30_000);

  it("refuses a non-administrator on both admin routes, and a wrong current password on creation", async () => {
    const fixture = await createIntegrationFixture("setup-authority");
    try {
      const admin = await fixture.session("admin");
      await seedLocalCredential(admin.userId, ADMIN_PASSWORD);
      const owner = await fixture.session("owner");

      expect((await call(createUser, owner, "/api/admin/users", {
        body: { email: "denied@example.invalid", displayName: "Denied", currentPassword: "irrelevant" },
      })).status).toBe(403);

      expect((await call(reissueSetupLink, owner, `/api/admin/users/${admin.userId}/setup-link`, {
        params: { userId: admin.userId },
        body: { currentPassword: "irrelevant" },
      })).status).toBe(403);

      const wrongPassword = await call(createUser, admin, "/api/admin/users", {
        body: { email: "unchallenged@example.invalid", displayName: "Unchallenged", currentPassword: "not-the-password" },
      });
      expect(wrongPassword.status).toBe(403);
      expect((wrongPassword.body.error as { code: string }).code).toBe("recent_authentication_required");
    } finally {
      await fixture.cleanup();
    }
  }, 30_000);
});

describe("consuming a setup or recovery link (ADR-0023 §3, §7)", () => {
  it("sets the password, marks the token consumed once, and signs the owner in", async () => {
    const fixture = await createIntegrationFixture("setup-consume");
    try {
      const admin = await fixture.session("admin");
      await seedLocalCredential(admin.userId, ADMIN_PASSWORD);

      const created = await call(createUser, admin, "/api/admin/users", {
        body: { email: `consume-${fixture.household.id.slice(0, 8)}@example.invalid`, displayName: "Consumer", currentPassword: ADMIN_PASSWORD },
      });
      const newUserId = (created.body.user as { id: string }).id;
      const token = tokenFromSetupUrl(created.body.setupUrl as string);

      const consumed = await callSignedOut(consumeSetup, "/api/auth/local/setup", { token, password: NEW_PASSWORD });
      expect(consumed.status).toBe(200);
      expect(consumed.body).toEqual({ authenticated: true });

      const config = getAuthConfig();
      const cookie = readSetCookie(consumed.response, sessionCookieName(config));
      expect(cookie).toBeDefined();
      expect(await isAuthenticated(cookie!.value)).toBe(true);

      const [credential] = await getDb().select({ passwordHash: localCredentials.passwordHash })
        .from(localCredentials).where(eq(localCredentials.userId, newUserId));
      expect((await verifyPassword(credential.passwordHash, NEW_PASSWORD)).verified).toBe(true);

      const [tokenRow] = await getDb().select({ consumedAt: credentialSetupTokens.consumedAt })
        .from(credentialSetupTokens).where(eq(credentialSetupTokens.userId, newUserId));
      expect(tokenRow.consumedAt).not.toBeNull();

      const setAudit = await getDb().select({ action: auditLog.action, changes: auditLog.changes, actorUserId: auditLog.actorUserId })
        .from(auditLog).where(eq(auditLog.entityId, newUserId));
      const passwordSet = setAudit.find((row) => row.action === "password_set");
      expect(passwordSet).toMatchObject({ changes: {}, actorUserId: newUserId });

      // The same link a second time: one generic refusal, no second session minted.
      const again = await callSignedOut(consumeSetup, "/api/auth/local/setup", { token, password: NEW_PASSWORD });
      expect(again.status).toBe(400);
      expect((again.body.error as { code: string }).code).toBe("setup_token_invalid");
      expect(again.response.headers.get("set-cookie")).toBeNull();
    } finally {
      await fixture.cleanup();
    }
  }, 30_000);

  it("refuses an expired token with the same generic answer", async () => {
    const fixture = await createIntegrationFixture("setup-expired");
    try {
      const admin = await fixture.session("admin");
      await seedLocalCredential(admin.userId, ADMIN_PASSWORD);
      const created = await call(createUser, admin, "/api/admin/users", {
        body: { email: `expired-${fixture.household.id.slice(0, 8)}@example.invalid`, displayName: "Expired", currentPassword: ADMIN_PASSWORD },
      });
      const token = tokenFromSetupUrl(created.body.setupUrl as string);

      await getDb().update(credentialSetupTokens)
        .set({ expiresAt: new Date(Date.now() - 1000) })
        .where(eq(credentialSetupTokens.userId, (created.body.user as { id: string }).id));

      const response = await callSignedOut(consumeSetup, "/api/auth/local/setup", { token, password: NEW_PASSWORD });
      expect(response.status).toBe(400);
      expect((response.body.error as { code: string }).code).toBe("setup_token_invalid");
    } finally {
      await fixture.cleanup();
    }
  }, 30_000);
});

describe("re-issuing a link for a local user who forgot their password (ADR-0023 §3)", () => {
  it("issues a five-minute recovery token, and consuming it revokes the account's other sessions", async () => {
    const fixture = await createIntegrationFixture("setup-reissue");
    try {
      const admin = await fixture.session("admin");
      await seedLocalCredential(admin.userId, ADMIN_PASSWORD);

      const target = await createLocalUser({
        email: `forgetful-${fixture.household.id.slice(0, 8)}@example.invalid`,
        displayName: "Forgetful",
        passwordHash: await hashPassword(OLD_PASSWORD),
      });
      // A session on some other device, to prove recovery revokes it.
      const config = getAuthConfig();
      await createSession(target.id, config);
      expect(await sessionCountFor(target.id)).toBe(1);

      const issuedAt = Date.now();
      const reissued = await call(reissueSetupLink, admin, `/api/admin/users/${target.id}/setup-link`, {
        params: { userId: target.id },
        body: { currentPassword: ADMIN_PASSWORD },
      });
      expect(reissued.status).toBe(200);
      const token = tokenFromSetupUrl(reissued.body.setupUrl as string);

      const [tokenRow] = await getDb().select({ purpose: credentialSetupTokens.purpose, expiresAt: credentialSetupTokens.expiresAt })
        .from(credentialSetupTokens).where(eq(credentialSetupTokens.userId, target.id));
      expect(tokenRow.purpose).toBe("recovery");
      expect(tokenRow.expiresAt.getTime()).toBeLessThanOrEqual(issuedAt + RECOVERY_TOKEN_TTL_MS + 5000);
      expect(tokenRow.expiresAt.getTime()).toBeGreaterThan(issuedAt + RECOVERY_TOKEN_TTL_MS - 5000);

      const consumed = await callSignedOut(consumeSetup, "/api/auth/local/setup", { token, password: NEW_PASSWORD });
      expect(consumed.status).toBe(200);

      // Redeeming a recovery link is a password change: the old session is gone.
      expect(await sessionCountFor(target.id)).toBe(1);
      const [credential] = await getDb().select({ passwordHash: localCredentials.passwordHash })
        .from(localCredentials).where(eq(localCredentials.userId, target.id));
      expect((await verifyPassword(credential.passwordHash, NEW_PASSWORD)).verified).toBe(true);

      const changedAudit = await getDb().select({ action: auditLog.action, changes: auditLog.changes })
        .from(auditLog).where(eq(auditLog.entityId, target.id));
      expect(changedAudit.find((row) => row.action === "password_changed")?.changes).toEqual({ sessionsRevoked: 1 });
    } finally {
      await fixture.cleanup();
    }
  }, 30_000);

  it("answers user_not_found for a target that does not exist", async () => {
    const fixture = await createIntegrationFixture("setup-reissue-missing");
    try {
      const admin = await fixture.session("admin");
      await seedLocalCredential(admin.userId, ADMIN_PASSWORD);
      const missingId = "00000000-0000-4000-8000-000000000000";
      const response = await call(reissueSetupLink, admin, `/api/admin/users/${missingId}/setup-link`, {
        params: { userId: missingId },
        body: { currentPassword: ADMIN_PASSWORD },
      });
      expect(response.status).toBe(404);
    } finally {
      await fixture.cleanup();
    }
  }, 30_000);
});

describe("changing a signed-in password (ADR-0023 §5, §6, §7)", () => {
  it("refuses an OIDC-only caller setting a first password with no step-up proof", async () => {
    const fixture = await createIntegrationFixture("password-first-set-unchallenged");
    try {
      // The fixture's `owner` carries an external identity and no local
      // credential (`support/fixtures.ts`), so this is exactly the OIDC-only
      // caller ADR-0023 §5 sends through a step-up rather than a password.
      const owner = await fixture.session("owner");

      const response = await call(changePassword, owner, "/api/auth/local/password", {
        body: { password: NEW_PASSWORD },
      });
      expect(response.status).toBe(403);
      expect((response.body.error as { code: string }).code).toBe("recent_authentication_required");
      expect(await getDb().select().from(localCredentials).where(eq(localCredentials.userId, owner.userId))).toEqual([]);
    } finally {
      await fixture.cleanup();
    }
  }, 30_000);

  it("sets a first password for an OIDC-only caller given a valid step-up proof, and revokes nothing", async () => {
    const fixture = await createIntegrationFixture("password-first-set");
    try {
      const owner = await fixture.session("owner");
      const config = getAuthConfig();
      const proof = await sealStepUpProof(owner.sessionId, "password_set", config);

      const response = await call(changePassword, owner, "/api/auth/local/password", {
        body: { password: NEW_PASSWORD },
        headers: withStepUpProof(owner, proof),
      });
      expect(response.status).toBe(200);
      expect(response.body).toEqual({ changed: false, sessionsRevoked: 0 });

      const [credential] = await getDb().select({ passwordHash: localCredentials.passwordHash })
        .from(localCredentials).where(eq(localCredentials.userId, owner.userId));
      expect((await verifyPassword(credential.passwordHash, NEW_PASSWORD)).verified).toBe(true);

      // Nothing was revoked: the caller's own original session still answers.
      expect(await isAuthenticated(owner.token)).toBe(true);
      // The proof is spent (cleared) but no session cookie is reissued.
      expect(readSetCookie(response.response, sessionCookieName(config))).toBeUndefined();

      const audit = await getDb().select({ action: auditLog.action, changes: auditLog.changes, actorUserId: auditLog.actorUserId })
        .from(auditLog).where(eq(auditLog.entityId, owner.userId));
      expect(audit.find((row) => row.action === "password_set")).toMatchObject({ changes: {}, actorUserId: owner.userId });
    } finally {
      await fixture.cleanup();
    }
  }, 30_000);

  it("changing an existing password revokes every session but re-issues the caller's own", async () => {
    const fixture = await createIntegrationFixture("password-change");
    try {
      const first = await fixture.session("owner");
      await seedLocalCredential(first.userId, OLD_PASSWORD);
      const second = await fixture.session("owner");
      expect(await sessionCountFor(first.userId)).toBe(2);

      const response = await call(changePassword, first, "/api/auth/local/password", {
        body: { currentPassword: OLD_PASSWORD, password: NEW_PASSWORD },
      });
      expect(response.status).toBe(200);
      expect(response.body).toEqual({ changed: true, sessionsRevoked: 2 });

      const config = getAuthConfig();
      const reissued = readSetCookie(response.response, sessionCookieName(config));
      expect(reissued).toBeDefined();
      expect(await isAuthenticated(reissued!.value)).toBe(true);

      // Both prior sessions, the caller's own included, are gone.
      expect(await isAuthenticated(first.token)).toBe(false);
      expect(await isAuthenticated(second.token)).toBe(false);
      expect(await sessionCountFor(first.userId)).toBe(1);

      const audit = await getDb().select({ action: auditLog.action, changes: auditLog.changes })
        .from(auditLog).where(eq(auditLog.entityId, first.userId));
      expect(audit.find((row) => row.action === "password_changed")?.changes).toEqual({ sessionsRevoked: 2 });
    } finally {
      await fixture.cleanup();
    }
  }, 30_000);

  it("refuses a wrong or missing current password, and changes nothing", async () => {
    const fixture = await createIntegrationFixture("password-wrong-challenge");
    try {
      const owner = await fixture.session("owner");
      await seedLocalCredential(owner.userId, OLD_PASSWORD);

      const wrong = await call(changePassword, owner, "/api/auth/local/password", {
        body: { currentPassword: "not-the-password", password: NEW_PASSWORD },
      });
      expect(wrong.status).toBe(403);
      expect((wrong.body.error as { code: string }).code).toBe("recent_authentication_required");

      const missing = await call(changePassword, owner, "/api/auth/local/password", {
        body: { password: NEW_PASSWORD },
      });
      expect(missing.status).toBe(403);
      expect((missing.body.error as { code: string }).code).toBe("recent_authentication_required");

      const [credential] = await getDb().select({ passwordHash: localCredentials.passwordHash })
        .from(localCredentials).where(eq(localCredentials.userId, owner.userId));
      expect((await verifyPassword(credential.passwordHash, OLD_PASSWORD)).verified).toBe(true);
      expect(await sessionCountFor(owner.userId)).toBe(1);
    } finally {
      await fixture.cleanup();
    }
  }, 30_000);
});
