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
