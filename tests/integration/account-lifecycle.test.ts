import { and, eq, sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { getDb } from "@/db";
import { auditLog, externalIdentities, memberships, sessions, users } from "@/db/schema";
import { AuthError } from "@/lib/auth/errors";
import { getAuthConfig } from "@/lib/env";
import { createSession } from "@/lib/auth/session";
import { provisionIdentity } from "@/lib/auth/provision";
import { PATCH as updateMembers } from "@/app/api/households/[householdId]/members/route";
import { DELETE as removeMember } from "@/app/api/households/[householdId]/members/route";
import { PATCH as updateUser } from "@/app/api/admin/users/route";
import { setInstanceAdministrator, setInstanceUserDisabled } from "@/server/admin-repository";
import { transferHouseholdOwnership } from "@/server/workspace-repository";
import {
  cleanupIntegrationEnvironment,
  createIntegrationFixture,
  requestForSession,
} from "./support/fixtures";

afterAll(async () => {
  await cleanupIntegrationEnvironment();
});

function householdContext(householdId: string) {
  return { params: Promise.resolve({ householdId }) };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((nextResolve) => { resolve = nextResolve; });
  return { promise, resolve };
}

function waitFor(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function responseBody(response: Response): Promise<{ error?: { code?: string; message?: string } }> {
  return await response.json() as { error?: { code?: string; message?: string } };
}

async function expectApiError(response: Response, status: number, code: string): Promise<{ message?: string }> {
  expect(response.status).toBe(status);
  expect(response.headers.get("cache-control")).toBe("no-store");
  const body = await responseBody(response);
  expect(body.error?.code).toBe(code);
  return body.error ?? {};
}

async function auditRows(entityId: string, action?: string) {
  return getDb().select({ id: auditLog.id }).from(auditLog).where(and(
    eq(auditLog.entityId, entityId),
    ...(action ? [eq(auditLog.action, action)] : []),
  ));
}

async function activeAdministratorCount(): Promise<number> {
  const [result] = await getDb().select({ count: sql<number>`count(*)::int` }).from(users)
    .where(and(eq(users.isInstanceAdmin, true), sql`${users.disabledAt} is null`));
  return result?.count ?? 0;
}

async function ownerRows(householdId: string) {
  return getDb().select({ userId: memberships.userId, disabledAt: users.disabledAt })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(and(eq(memberships.householdId, householdId), eq(memberships.role, "owner")));
}

describe("account disable, session and ownership invariants", () => {
  it("revokes every session, supports safe re-enable, and audits state changes once", async () => {
    const fixture = await createIntegrationFixture("account-revocation");
    const admin = await fixture.session("admin");
    const firstSession = await fixture.session("member");
    const secondSession = await fixture.session("member");
    const beforeAudit = (await auditRows(fixture.users.member.id, "account_disabled")).length;

    const disabled = await updateUser(requestForSession(admin, "http://127.0.0.1:3000/api/admin/users", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ userId: fixture.users.member.id, disabled: true }),
    }));
    expect(disabled.status).toBe(200);
    expect((await getDb().select({ disabledAt: users.disabledAt }).from(users).where(eq(users.id, fixture.users.member.id)))[0]?.disabledAt).not.toBeNull();
    expect((await getDb().select({ id: sessions.id }).from(sessions).where(eq(sessions.userId, fixture.users.member.id)))).toHaveLength(0);
    expect((await auditRows(fixture.users.member.id, "account_disabled"))).toHaveLength(beforeAudit + 1);

    await expectApiError(await (await import("@/app/api/workspace/route")).GET(requestForSession(firstSession, "http://127.0.0.1:3000/api/workspace")), 401, "session_required");
    await expectApiError(await (await import("@/app/api/workspace/route")).GET(requestForSession(secondSession, "http://127.0.0.1:3000/api/workspace")), 401, "session_required");

    const repeatedDisable = await updateUser(requestForSession(admin, "http://127.0.0.1:3000/api/admin/users", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ userId: fixture.users.member.id, disabled: true }),
    }));
    expect(repeatedDisable.status).toBe(200);
    expect((await auditRows(fixture.users.member.id, "account_disabled"))).toHaveLength(beforeAudit + 1);

    const enabled = await updateUser(requestForSession(admin, "http://127.0.0.1:3000/api/admin/users", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ userId: fixture.users.member.id, disabled: false }),
    }));
    expect(enabled.status).toBe(200);
    expect((await getDb().select({ disabledAt: users.disabledAt }).from(users).where(eq(users.id, fixture.users.member.id)))[0]?.disabledAt).toBeNull();
    expect((await auditRows(fixture.users.member.id, "account_enabled"))).toHaveLength(1);

    const freshSession = await fixture.session("member");
    expect((await (await import("@/app/api/workspace/route")).GET(requestForSession(freshSession, "http://127.0.0.1:3000/api/workspace"))).status).toBe(200);
    await expectApiError(await (await import("@/app/api/workspace/route")).GET(requestForSession(firstSession, "http://127.0.0.1:3000/api/workspace")), 401, "session_required");
  });

  it("rejects disabled OIDC provisioning and session creation without profile mutation", async () => {
    const fixture = await createIntegrationFixture("disabled-provisioning");
    const admin = await fixture.session("admin");
    const [identity] = await getDb().select().from(externalIdentities).where(eq(externalIdentities.userId, fixture.users.member.id));
    const [beforeUser] = await getDb().select({ email: users.email, displayName: users.displayName, avatarUrl: users.avatarUrl, emailVerified: users.emailVerified, updatedAt: users.updatedAt })
      .from(users).where(eq(users.id, fixture.users.member.id));
    const beforeIdentity = identity?.lastLoginAt?.getTime();

    await updateUser(requestForSession(admin, "http://127.0.0.1:3000/api/admin/users", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ userId: fixture.users.member.id, disabled: true }),
    }));
    const sessionsBeforeRejectedSignIn = await getDb().select({ id: sessions.id }).from(sessions)
      .where(eq(sessions.userId, fixture.users.member.id));

    await expect(provisionIdentity({
      issuer: identity!.issuer,
      subject: identity!.subject,
      email: "changed@example.test",
      emailVerified: false,
      displayName: "Changed display name",
      avatarUrl: "https://example.test/avatar.png",
    })).rejects.toMatchObject({ code: "account_disabled", status: 403 });
    await expect(createSession(fixture.users.member.id, getAuthConfig())).rejects.toBeInstanceOf(AuthError);

    const [afterUser] = await getDb().select({ email: users.email, displayName: users.displayName, avatarUrl: users.avatarUrl, emailVerified: users.emailVerified, updatedAt: users.updatedAt })
      .from(users).where(eq(users.id, fixture.users.member.id));
    const [afterIdentity] = await getDb().select({ lastLoginAt: externalIdentities.lastLoginAt }).from(externalIdentities).where(eq(externalIdentities.userId, fixture.users.member.id));
    expect(afterUser).toEqual(beforeUser);
    expect(afterIdentity?.lastLoginAt.getTime()).toBe(beforeIdentity);
    expect(await getDb().select({ id: sessions.id }).from(sessions)
      .where(eq(sessions.userId, fixture.users.member.id))).toEqual(sessionsBeforeRejectedSignIn);
  });

  it("protects owners and disabled ownership targets without mutation or audit", async () => {
    const fixture = await createIntegrationFixture("owner-protection");
    const admin = await fixture.session("admin");
    const owner = await fixture.session("owner");
    const beforeAudit = (await auditRows(fixture.household.id)).length;
    const ownerAudit = (await auditRows(fixture.users.owner.id)).length;

    const disableOwner = await updateUser(requestForSession(admin, "http://127.0.0.1:3000/api/admin/users", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ userId: fixture.users.owner.id, disabled: true }),
    }));
    const ownerError = await expectApiError(disableOwner, 409, "owner_protected");
    expect(ownerError.message).toContain("Transfer ownership");

    const removeOwner = await removeMember(requestForSession(owner, "http://127.0.0.1:3000/api/households/members", {
      method: "DELETE",
      body: JSON.stringify({ userId: fixture.users.owner.id }),
    }), householdContext(fixture.household.id));
    await expectApiError(removeOwner, 409, "owner_protected");
    expect((await getDb().select({ disabledAt: users.disabledAt }).from(users).where(eq(users.id, fixture.users.owner.id)))[0]?.disabledAt).toBeNull();
    expect((await ownerRows(fixture.household.id))).toEqual([{ userId: fixture.users.owner.id, disabledAt: null }]);
    expect(await getDb().select({ id: sessions.id }).from(sessions).where(eq(sessions.id, owner.sessionId)))
      .toEqual([{ id: owner.sessionId }]);
    expect((await auditRows(fixture.household.id))).toHaveLength(beforeAudit);
    expect((await auditRows(fixture.users.owner.id))).toHaveLength(ownerAudit);

    await updateUser(requestForSession(admin, "http://127.0.0.1:3000/api/admin/users", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ userId: fixture.users.member.id, disabled: true }),
    }));
    const transfer = await updateMembers(requestForSession(admin, "http://127.0.0.1:3000/api/households/members", {
      method: "PATCH",
      body: JSON.stringify({ userId: fixture.users.member.id }),
    }), householdContext(fixture.household.id));
    await expectApiError(transfer, 409, "account_disabled");
    expect((await ownerRows(fixture.household.id))).toEqual([{ userId: fixture.users.owner.id, disabledAt: null }]);
    expect((await auditRows(fixture.household.id, "ownership_transferred"))).toHaveLength(0);
  });

  it("serializes ownership transfer and disable so the final owner is enabled", async () => {
    const fixture = await createIntegrationFixture("concurrent-owner-disable");
    const admin = await fixture.session("admin");
    const owner = await fixture.session("owner");
    const member = await fixture.session("member");

    const results = await Promise.allSettled([
      setInstanceUserDisabled(admin.userId, fixture.users.member.id, true),
      transferHouseholdOwnership(owner.userId, fixture.household.id, fixture.users.member.id),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected");
    expect(rejected && rejected.status === "rejected" ? rejected.reason : undefined).toMatchObject({
      code: expect.stringMatching(/^(account_disabled|owner_protected)$/),
      status: 409,
    });

    const owners = await ownerRows(fixture.household.id);
    const [memberState] = await getDb().select({ disabledAt: users.disabledAt }).from(users)
      .where(eq(users.id, fixture.users.member.id));
    const memberSessions = await getDb().select({ id: sessions.id }).from(sessions)
      .where(eq(sessions.userId, fixture.users.member.id));
    const transferAudits = await auditRows(fixture.household.id, "ownership_transferred");
    const disableAudits = await auditRows(fixture.users.member.id, "account_disabled");
    expect(owners).toHaveLength(1);
    expect(owners[0]?.disabledAt).toBeNull();
    expect(transferAudits.length + disableAudits.length).toBe(1);
    if (memberState?.disabledAt) {
      expect(owners[0]?.userId).toBe(fixture.users.owner.id);
      expect(disableAudits).toHaveLength(1);
      expect(memberSessions).toHaveLength(0);
    } else {
      expect(owners[0]?.userId).toBe(fixture.users.member.id);
      expect(transferAudits).toHaveLength(1);
      expect(memberSessions).toEqual([{ id: member.sessionId }]);
    }
  });

  it("serializes administrator disable and demotion under the administrator lock", async () => {
    const fixture = await createIntegrationFixture("concurrent-admin-invariant");
    await getDb().update(users).set({ isInstanceAdmin: true }).where(eq(users.id, fixture.users.outsider.id));

    const held = deferred<void>();
    const release = deferred<void>();
    const lock = getDb().transaction(async (transaction) => {
      await transaction.execute(sql`select pg_advisory_xact_lock(hashtextextended('orbit:administrators', 0))`);
      held.resolve();
      await release.promise;
    });
    try {
      await held.promise;
      const disable = setInstanceUserDisabled(fixture.users.outsider.id, fixture.users.admin.id, true);
      const demote = setInstanceAdministrator(fixture.users.admin.id, fixture.users.outsider.id, false);
      const completedBeforeRelease = await Promise.race([
        Promise.allSettled([disable, demote]).then(() => true),
        waitFor(100).then(() => false),
      ]);
      expect(completedBeforeRelease).toBe(false);
      release.resolve();
      const results = await Promise.allSettled([disable, demote]);
      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      expect(await activeAdministratorCount()).toBeGreaterThanOrEqual(1);
      expect((await auditRows(fixture.users.outsider.id, "administrator_revoked")).length + (await auditRows(fixture.users.admin.id, "account_disabled")).length).toBe(1);
    } finally {
      release.resolve();
      await lock;
    }
  });
});
