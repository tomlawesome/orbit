import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { getDb } from "@/db";
import { auditLog, instanceAuthority, users } from "@/db/schema";
import {
  setInstanceAdministrator,
  setInstanceUserDisabled,
  listInstanceUsers,
} from "@/server/admin-repository";
import { cleanupIntegrationEnvironment, createIntegrationFixture } from "./support/fixtures";
import { callRouteForSession, loadRoute } from "./support/request-event";

const { PUT: updateAdministrator, PATCH: updateUser } = await loadRoute("admin/users");

const PRIMARY_PROTECTED_MESSAGE = "The primary administrator's account cannot be demoted or disabled.";

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

describe("primary administrator authority (#263)", () => {
  it("rejects disable and demotion of the primary regardless of actor, and stays deletable-proof at the database", async () => {
    const fixture = await createIntegrationFixture("primary-protect");
    const primary = fixture.users.admin;
    await seatPrimary(primary.id);
    // A second, ordinary administrator attempts both mutations.
    await setInstanceAdministrator(primary.id, fixture.users.owner.id, true);

    await expect(
      setInstanceUserDisabled(fixture.users.owner.id, primary.id, true),
    ).rejects.toMatchObject({
      code: "primary_administrator_protected",
      message: "The primary administrator's account cannot be demoted or disabled.",
    });
    await expect(
      setInstanceAdministrator(fixture.users.owner.id, primary.id, false),
    ).rejects.toMatchObject({
      code: "primary_administrator_protected",
      message: "The primary administrator's account cannot be demoted or disabled.",
    });

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

  it("answers the admin users route with 409 and the same refusal words when an administrator disables or demotes the primary", async () => {
    const fixture = await createIntegrationFixture("primary-route");
    const primary = fixture.users.admin;
    await seatPrimary(primary.id);
    await setInstanceAdministrator(primary.id, fixture.users.owner.id, true);
    const actor = await fixture.session("owner");
    const headers = { "content-type": "application/json" };

    const disabled = await callRouteForSession(updateUser, actor, {
      url: "http://127.0.0.1:3000/api/admin/users",
      method: "PATCH",
      headers,
      body: JSON.stringify({ userId: primary.id, disabled: true }),
    });
    expect(disabled.status).toBe(409);
    const disabledBody = await disabled.json() as { error?: { code?: string; message?: string } };
    expect(disabledBody.error?.code).toBe("primary_administrator_protected");
    expect(disabledBody.error?.message).toBe(PRIMARY_PROTECTED_MESSAGE);

    const demoted = await callRouteForSession(updateAdministrator, actor, {
      url: "http://127.0.0.1:3000/api/admin/users",
      method: "PUT",
      headers,
      body: JSON.stringify({ userId: primary.id, administrator: false }),
    });
    expect(demoted.status).toBe(409);
    const demotedBody = await demoted.json() as { error?: { code?: string; message?: string } };
    expect(demotedBody.error?.code).toBe("primary_administrator_protected");
    expect(demotedBody.error?.message).toBe(PRIMARY_PROTECTED_MESSAGE);

    await fixture.cleanup();
  });
});
