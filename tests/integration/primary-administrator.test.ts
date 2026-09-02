import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { getDb } from "@/db";
import { auditLog, instanceAuthority, sessions, users } from "@/db/schema";
import {
  setInstanceAdministrator,
  setInstanceUserDisabled,
  transferPrimaryAdministrator,
  listInstanceUsers,
} from "@/server/admin-repository";
import { POST as transferPrimary } from "@/app/api/admin/primary/route";
import {
  cleanupIntegrationEnvironment,
  createIntegrationFixture,
  requestForSession,
} from "./support/fixtures";

afterAll(async () => {
  await cleanupIntegrationEnvironment();
});

/* The authority row is a database-wide singleton, so every test seats and
   clears it explicitly rather than leaking a primary into sibling suites. */
afterEach(async () => {
  await getDb().delete(instanceAuthority);
});

async function seatPrimary(userId: string): Promise<void> {
  await getDb().insert(instanceAuthority).values({ primaryUserId: userId });
}

async function primaryRow(): Promise<string | null> {
  const [row] = await getDb()
    .select({ primaryUserId: instanceAuthority.primaryUserId })
    .from(instanceAuthority);
  return row?.primaryUserId ?? null;
}

describe("primary administrator authority (#263)", () => {
  it("rejects disable and demotion of the primary regardless of actor, and stays deletable-proof at the database", async () => {
    const fixture = await createIntegrationFixture("primary-protect");
    const primary = fixture.users.admin;
    await seatPrimary(primary.id);
    // A second, ordinary administrator attempts both mutations.
    await setInstanceAdministrator(primary.id, fixture.users.owner.id, true);

    await expect(
      setInstanceUserDisabled(fixture.users.owner.id, primary.id, true),
    ).rejects.toMatchObject({ code: "primary_administrator_protected" });
    await expect(
      setInstanceAdministrator(fixture.users.owner.id, primary.id, false),
    ).rejects.toMatchObject({ code: "primary_administrator_protected" });

    // The database itself refuses to delete the seated primary (RESTRICT),
    // so a missed application check cannot orphan the instance. The audit
    // trail's own foreign key guards this user too; it is cleared for this
    // user alone so the assertion proves the authority constraint itself.
    await getDb().delete(auditLog).where(eq(auditLog.entityId, primary.id));
    await getDb().execute(sql`delete from audit_log where actor_user_id = ${primary.id}`);
    // 23001 is restrict_violation. PostgreSQL 18 separated it from plain
    // foreign_key_violation (23503), which 17 raised for both RESTRICT and
    // NO ACTION; the constraint and the refusal are unchanged. Pinned rather
    // than loosened because the database image is pinned by digest, so a
    // future change to this code should stop and be looked at.
    await expect(
      getDb().delete(users).where(eq(users.id, primary.id)),
    ).rejects.toMatchObject({
      cause: { code: "23001", constraint_name: "instance_authority_primary_user_id_users_id_fk" },
    });

    // The singleton check refuses a second seat of authority.
    await expect(
      getDb().insert(instanceAuthority).values({ singleton: false, primaryUserId: fixture.users.owner.id }),
    ).rejects.toMatchObject({ cause: { code: "23514" } });

    await fixture.cleanup();
  });

  it("transfers atomically: only the fresh-sessioned primary, only to an eligible target, audited, former stays admin", async () => {
    const fixture = await createIntegrationFixture("primary-transfer");
    const primary = fixture.users.admin;
    await seatPrimary(primary.id);
    await setInstanceAdministrator(primary.id, fixture.users.owner.id, true);
    const primarySession = await fixture.session("admin");

    // A non-primary administrator cannot transfer.
    const ownerSession = await fixture.session("owner");
    await expect(
      transferPrimaryAdministrator(fixture.users.owner.id, ownerSession.sessionId, primary.id),
    ).rejects.toMatchObject({ code: "primary_administrator_required" });

    // Ineligible targets: self, a non-administrator, a disabled account.
    await expect(
      transferPrimaryAdministrator(primary.id, primarySession.sessionId, primary.id),
    ).rejects.toMatchObject({ code: "transfer_target_ineligible" });
    await expect(
      transferPrimaryAdministrator(primary.id, primarySession.sessionId, fixture.users.member.id),
    ).rejects.toMatchObject({ code: "transfer_target_ineligible" });
    await fixture.disableUser("disabled");
    await expect(
      transferPrimaryAdministrator(primary.id, primarySession.sessionId, fixture.users.disabled.id),
    ).rejects.toMatchObject({ code: "transfer_target_ineligible" });

    // A stale session is not fresh proof: the original primary is unchanged.
    await getDb().update(sessions)
      .set({ createdAt: new Date(Date.now() - 60 * 60 * 1000) })
      .where(eq(sessions.id, primarySession.sessionId));
    await expect(
      transferPrimaryAdministrator(primary.id, primarySession.sessionId, fixture.users.owner.id),
    ).rejects.toMatchObject({ code: "recent_authentication_required" });
    expect(await primaryRow()).toBe(primary.id);

    // A fresh session transfers; the former primary remains an active admin.
    const freshSession = await fixture.session("admin");
    const listed = await transferPrimaryAdministrator(primary.id, freshSession.sessionId, fixture.users.owner.id);
    expect(await primaryRow()).toBe(fixture.users.owner.id);
    const former = listed.users.find((user) => user.id === primary.id);
    expect(former).toMatchObject({ isInstanceAdmin: true, isPrimaryAdministrator: false, disabledAt: null });
    expect(listed.users.find((user) => user.id === fixture.users.owner.id)).toMatchObject({ isPrimaryAdministrator: true });
    const audits = await getDb().select({ id: auditLog.id }).from(auditLog)
      .where(eq(auditLog.action, "primary_administrator_transferred"));
    expect(audits.length).toBeGreaterThanOrEqual(1);

    // Authority has moved: the former primary can now be demoted, and a
    // repeated transfer from the former primary is rejected.
    await expect(
      transferPrimaryAdministrator(primary.id, freshSession.sessionId, fixture.users.owner.id),
    ).rejects.toMatchObject({ code: "primary_administrator_required" });
    await setInstanceAdministrator(fixture.users.owner.id, primary.id, false);

    await fixture.cleanup();
  });

  it("serializes a concurrent transfer and disable so authority is never orphaned", async () => {
    const fixture = await createIntegrationFixture("primary-race");
    const primary = fixture.users.admin;
    await seatPrimary(primary.id);
    await setInstanceAdministrator(primary.id, fixture.users.owner.id, true);
    const primarySession = await fixture.session("admin");

    // Both run at once under the administrator lock: whichever wins, the
    // instance ends with exactly one primary who is an active administrator.
    const [transferOutcome, disableOutcome] = await Promise.allSettled([
      transferPrimaryAdministrator(primary.id, primarySession.sessionId, fixture.users.owner.id),
      setInstanceUserDisabled(primary.id, fixture.users.owner.id, true),
    ]);
    const seated = await primaryRow();
    expect(seated).not.toBeNull();
    const [seatedUser] = await getDb()
      .select({ administrator: users.isInstanceAdmin, disabledAt: users.disabledAt })
      .from(users).where(eq(users.id, seated as string));
    expect(seatedUser.administrator).toBe(true);
    expect(seatedUser.disabledAt).toBeNull();
    // At least one of the two operations must have concluded decisively.
    expect([transferOutcome.status, disableOutcome.status]).toContain("fulfilled");

    await fixture.cleanup();
  });

  it("exposes transfer over the API with CSRF and admin gating", async () => {
    const fixture = await createIntegrationFixture("primary-route");
    const primary = fixture.users.admin;
    await seatPrimary(primary.id);
    await setInstanceAdministrator(primary.id, fixture.users.owner.id, true);

    const memberSession = await fixture.session("member");
    const denied = await transferPrimary(requestForSession(memberSession, "http://orbit.test/api/admin/primary", {
      method: "POST",
      body: JSON.stringify({ targetUserId: fixture.users.owner.id }),
      headers: { "Content-Type": "application/json" },
    }));
    expect(denied.status).toBe(403);

    const primarySession = await fixture.session("admin");
    const response = await transferPrimary(requestForSession(primarySession, "http://orbit.test/api/admin/primary", {
      method: "POST",
      body: JSON.stringify({ targetUserId: fixture.users.owner.id }),
      headers: { "Content-Type": "application/json" },
    }));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const payload = await response.json() as { users: Array<{ id: string; isPrimaryAdministrator: boolean }> };
    expect(payload.users.find((user) => user.id === fixture.users.owner.id)?.isPrimaryAdministrator).toBe(true);
    expect(await primaryRow()).toBe(fixture.users.owner.id);

    await fixture.cleanup();
  });

  it("lists the primary flag only for administrators and changes nothing for instances without a seated primary", async () => {
    const fixture = await createIntegrationFixture("primary-absent");
    // No seat: legacy pre-bootstrap state. Existing admin flows are unchanged.
    const listed = await listInstanceUsers(fixture.users.admin.id);
    expect(listed.users.every((user) => user.isPrimaryAdministrator === false)).toBe(true);
    await setInstanceAdministrator(fixture.users.admin.id, fixture.users.owner.id, true);
    await setInstanceAdministrator(fixture.users.admin.id, fixture.users.owner.id, false);
    await expect(getDb().execute(sql`select 1`)).resolves.toBeDefined();
    await fixture.cleanup();
  });
});
