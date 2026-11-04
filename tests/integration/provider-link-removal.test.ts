/*
 * Removing a sign-in provider removes every member's link to it (#1676,
 * owner answer 50a).
 *
 * Server function only: where an administrator triggers it is undecided, so
 * nothing here touches a route, screen or command. The function under test is
 * `removeProviderLinks(actorUserId, issuer)` from `@/server/local-credentials`;
 * it is reached through the module namespace so a rename fails these tests one
 * by one rather than the whole file at import.
 *
 * Decided with the tests: a member who would be left with no way to sign in
 * blocks the whole removal (refused, nothing deleted) — there is no `force`
 * option. Rows are deleted, not hidden.
 */

import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { getDb } from "@/db";
import { auditLog, externalIdentities, instanceAuthority, localCredentials, userPreferences, users } from "@/db/schema";
import { hashPassword } from "@/lib/auth/password";
import { getAuthConfig, resetAuthConfigForTests } from "@/lib/env";
import * as credentials from "@/server/local-credentials";
import { accountAddressColumns, cleanupIntegrationEnvironment } from "./support/fixtures";

const previousOidcKey = process.env.ORBIT_AUTH_OIDC;
process.env.ORBIT_AUTH_OIDC = "true";
resetAuthConfigForTests();

const PASSWORD = "a-correct-local-password";
const created: string[] = [];

afterEach(async () => {
  const db = getDb();
  await db.delete(instanceAuthority);
  await db.delete(auditLog);
  if (created.length > 0) await db.delete(users).where(inArray(users.id, created));
  created.length = 0;
  process.env.ORBIT_AUTH_OIDC = "true";
  resetAuthConfigForTests();
});

afterAll(async () => {
  if (previousOidcKey === undefined) delete process.env.ORBIT_AUTH_OIDC;
  else process.env.ORBIT_AUTH_OIDC = previousOidcKey;
  resetAuthConfigForTests();
  await cleanupIntegrationEnvironment();
});

type RemoveProviderLinks = (actorUserId: string, issuer: string) => Promise<number | { removed: number }>;

function removeProviderLinks(actorUserId: string, issuer: string) {
  const fn = (credentials as unknown as { removeProviderLinks: RemoveProviderLinks }).removeProviderLinks;
  return fn(actorUserId, issuer);
}

function countOf(result: number | { removed: number }): number {
  return typeof result === "number" ? result : result.removed;
}

/** Make this user the instance's primary administrator (instance_authority is a single row). */
async function makePrimary(userId: string): Promise<void> {
  const db = getDb();
  await db.delete(instanceAuthority);
  await db.insert(instanceAuthority).values({ primaryUserId: userId });
}

interface Member {
  id: string;
  email: string;
  subject: string;
}

/** A member. `password` gives a local credential; `issuers` are provider links. */
async function member(
  label: string,
  options: { password: boolean; admin?: boolean; primary?: boolean; issuers: string[] },
): Promise<Member> {
  const id = randomUUID();
  const email = `${label}-${id.slice(0, 8)}@removal.invalid`;
  const subject = `sub-${label}-${id.slice(0, 8)}`;
  const db = getDb();
  await db.insert(users).values({
    id,
    ...(await accountAddressColumns(id, email)),
    emailVerified: true,
    displayName: `Removal ${label}`,
    isInstanceAdmin: options.admin === true,
  });
  created.push(id);
  if (options.primary) await makePrimary(id);
  await db.insert(userPreferences).values({ userId: id });
  if (options.password) {
    await db.insert(localCredentials).values({ userId: id, passwordHash: await hashPassword(PASSWORD) });
  }
  for (const issuer of options.issuers) {
    await db.insert(externalIdentities).values({ userId: id, issuer, subject });
  }
  return { id, email, subject };
}

async function rowsFor(issuer: string) {
  return getDb().select().from(externalIdentities).where(eq(externalIdentities.issuer, issuer));
}

describe("removing every member's link to a removed provider (#1676)", () => {
  it("deletes every member's row for that issuer, keeps other issuers, and returns the count", async () => {
    const gone = `https://gone-${randomUUID()}.invalid.example`;
    const kept = `https://kept-${randomUUID()}.invalid.example`;
    const admin = await member("admin", { password: true, admin: true, primary: true, issuers: [gone] });
    const a = await member("a", { password: true, issuers: [gone, kept] });
    const b = await member("b", { password: true, issuers: [gone] });
    const c = await member("c", { password: true, issuers: [kept] });

    const result = await removeProviderLinks(admin.id, gone);

    expect(countOf(result)).toBe(3);
    expect(await rowsFor(gone)).toHaveLength(0);
    const keptRows = await rowsFor(kept);
    expect(keptRows.map((row) => row.userId).sort()).toEqual([a.id, c.id].sort());
    // Deleted, not hidden: no row for the issuer survives in any state.
    const all = await getDb().select().from(externalIdentities).where(inArray(externalIdentities.userId, [admin.id, a.id, b.id]));
    expect(all.filter((row) => row.issuer === gone)).toHaveLength(0);
  });

  it("writes one audit entry that carries no issuer, subject or email", async () => {
    const gone = `https://gone-${randomUUID()}.invalid.example`;
    const admin = await member("audit-admin", { password: true, admin: true, primary: true, issuers: [gone] });
    const other = await member("audit-other", { password: true, issuers: [gone] });

    await removeProviderLinks(admin.id, gone);

    const entries = await getDb().select().from(auditLog);
    expect(entries).toHaveLength(1);
    expect(entries[0].actorUserId).toBe(admin.id);
    const recorded = JSON.stringify(entries[0].changes);
    for (const secret of [gone, new URL(gone).host, admin.subject, other.subject, admin.email, other.email]) {
      expect(recorded).not.toContain(secret);
    }
    expect(JSON.stringify(entries[0])).not.toContain(gone);
  });

  it("refuses an actor who is not an instance administrator and deletes nothing", async () => {
    const gone = `https://gone-${randomUUID()}.invalid.example`;
    const plain = await member("plain", { password: true, issuers: [gone] });
    const other = await member("plain-other", { password: true, issuers: [gone] });

    await expect(removeProviderLinks(plain.id, gone)).rejects.toThrow();

    expect(await rowsFor(gone)).toHaveLength(2);
    expect(other.id).not.toBe(plain.id);
    expect(await getDb().select().from(auditLog)).toHaveLength(0);
  });

  it("refuses an administrator who is not the primary with primary_administrator_only and deletes nothing", async () => {
    const gone = `https://gone-${randomUUID()}.invalid.example`;
    await member("np-primary", { password: true, admin: true, primary: true, issuers: [] });
    const second = await member("np-second", { password: true, admin: true, issuers: [gone] });

    await expect(removeProviderLinks(second.id, gone)).rejects.toMatchObject({ code: "primary_administrator_only", status: 403 });

    expect(await rowsFor(gone)).toHaveLength(1);
    expect(await getDb().select().from(auditLog)).toHaveLength(0);
  });

  it("refuses a primary administrator with no password with primary_administrator_needs_password and deletes nothing", async () => {
    const gone = `https://gone-${randomUUID()}.invalid.example`;
    const primary = await member("nopw-primary", { password: false, admin: true, primary: true, issuers: [gone] });

    await expect(removeProviderLinks(primary.id, gone)).rejects.toMatchObject({
      code: "primary_administrator_needs_password",
      status: 409,
      message: expect.stringMatching(/settings/i),
    });

    expect(await rowsFor(gone)).toHaveLength(1);
    expect(await getDb().select().from(auditLog)).toHaveLength(0);
  });

  it("refuses a non-administrator without either new code", async () => {
    const gone = `https://gone-${randomUUID()}.invalid.example`;
    await member("nl-primary", { password: false, admin: true, primary: true, issuers: [] });
    const plain = await member("nl-plain", { password: true, issuers: [gone] });

    const failure = await removeProviderLinks(plain.id, gone).then(() => null, (error: unknown) => error as { code?: string } | null);

    expect(failure).toBeInstanceOf(Error);
    expect(failure?.code).not.toBe("primary_administrator_only");
    expect(failure?.code).not.toBe("primary_administrator_needs_password");
  });

  it("checks primary-only first, then the password, then the strand check", async () => {
    const gone = `https://gone-${randomUUID()}.invalid.example`;
    await member("or-primary", { password: false, admin: true, primary: true, issuers: [] });
    const second = await member("or-second", { password: false, admin: true, issuers: [gone] });
    await expect(removeProviderLinks(second.id, gone)).rejects.toMatchObject({ code: "primary_administrator_only" });
    const primary = await member("or-primary2", { password: false, admin: true, primary: true, issuers: [gone] });
    await expect(removeProviderLinks(primary.id, gone)).rejects.toMatchObject({ code: "primary_administrator_needs_password" });
  });

  it("refuses outright when a member would be left with no way to sign in, naming the count and no emails", async () => {
    const gone = `https://gone-${randomUUID()}.invalid.example`;
    const admin = await member("strand-admin", { password: true, admin: true, primary: true, issuers: [gone] });
    const safe = await member("strand-safe", { password: true, issuers: [gone] });
    const stranded1 = await member("strand-one", { password: false, issuers: [gone] });
    const stranded2 = await member("strand-two", { password: false, issuers: [gone] });

    const failure = await removeProviderLinks(admin.id, gone).then(
      () => null,
      (error: unknown) => error as Error,
    );

    expect(failure).toBeInstanceOf(Error);
    const message = String(failure?.message ?? "");
    const code = String((failure as { code?: unknown } | null)?.code ?? "");
    // The error says how many members are affected (2) or lists their ids.
    expect(/\b2\b/.test(message) || [stranded1.id, stranded2.id].every((id) => message.includes(id))).toBe(true);
    for (const text of [message, code, JSON.stringify(failure)]) {
      for (const email of [admin.email, safe.email, stranded1.email, stranded2.email]) {
        expect(text).not.toContain(email);
      }
      expect(text).not.toContain(gone);
    }
    // Refused before anything is deleted, for everyone including the safe members.
    expect(await rowsFor(gone)).toHaveLength(4);
    expect(await getDb().select().from(auditLog)).toHaveLength(0);
    void safe;
  });

  /* An identity is a way in only while provider sign-in is on, and only at
     the configured issuer (identitiesAreUsable, getAuthConfig().oidc.issuer). */
  function configuredIssuer(): string {
    const oidc = getAuthConfig().oidc;
    if (!oidc) throw new Error("test needs ORBIT_AUTH_OIDC=true");
    return oidc.issuer;
  }

  async function expectRefusedAndUntouched(actorId: string, issuer: string, expectedRows: number) {
    await expect(removeProviderLinks(actorId, issuer)).rejects.toMatchObject({
      code: "provider_removal_strands_members",
    });
    expect(await rowsFor(issuer)).toHaveLength(expectedRows);
    expect(await getDb().select().from(auditLog)).toHaveLength(0);
  }

  it("does not treat a member as stranded when their other identity is at the configured issuer", async () => {
    const gone = `https://gone-${randomUUID()}.invalid.example`;
    const admin = await member("two-admin", { password: true, admin: true, primary: true, issuers: [gone] });
    const twice = await member("two-links", { password: false, issuers: [gone, configuredIssuer()] });

    expect(countOf(await removeProviderLinks(admin.id, gone))).toBe(2);

    expect(await rowsFor(gone)).toHaveLength(0);
    const remaining = await rowsFor(configuredIssuer());
    expect(remaining.map((row) => row.userId)).toEqual([twice.id]);
  });

  it("(a) strands a passwordless member with another identity while ORBIT_AUTH_OIDC=false", async () => {
    const gone = `https://gone-${randomUUID()}.invalid.example`;
    const other = `https://other-${randomUUID()}.invalid.example`;
    const admin = await member("off-admin", { password: true, admin: true, primary: true, issuers: [] });
    await member("off-stranded", { password: false, issuers: [gone, other] });
    process.env.ORBIT_AUTH_OIDC = "false";
    resetAuthConfigForTests();

    await expectRefusedAndUntouched(admin.id, gone, 1);
    expect(await rowsFor(other)).toHaveLength(1);
  });

  it("(b) strands a passwordless member whose other identity is not at the configured issuer", async () => {
    const gone = `https://gone-${randomUUID()}.invalid.example`;
    const third = `https://third-${randomUUID()}.invalid.example`;
    const admin = await member("third-admin", { password: true, admin: true, primary: true, issuers: [] });
    await member("third-stranded", { password: false, issuers: [gone, third] });

    await expectRefusedAndUntouched(admin.id, gone, 1);
    expect(await rowsFor(third)).toHaveLength(1);
  });

  it("(c) removes an old issuer when members also hold an identity at the configured issuer", async () => {
    const old = `https://old-${randomUUID()}.invalid.example`;
    const admin = await member("old-admin", { password: true, admin: true, primary: true, issuers: [] });
    const user = await member("old-member", { password: false, issuers: [old, configuredIssuer()] });

    expect(countOf(await removeProviderLinks(admin.id, old))).toBe(1);

    expect(await rowsFor(old)).toHaveLength(0);
    expect((await rowsFor(configuredIssuer())).map((row) => row.userId)).toEqual([user.id]);
  });
});

describe("a member unlinking their own identity while provider sign-in is off (#1676)", () => {
  const challenge = (userId: string) => ({ userId, intent: "unlink_method" as const, method: "password" as const });

  it("lets a member with a password unlink while ORBIT_AUTH_OIDC=false", async () => {
    const issuer = `https://off-${randomUUID()}.invalid.example`;
    const user = await member("self-unlink", { password: true, issuers: [issuer] });
    process.env.ORBIT_AUTH_OIDC = "false";
    resetAuthConfigForTests();
    const [row] = await rowsFor(issuer);

    await expect(credentials.unlinkIdentity(user.id, row.id, challenge(user.id))).resolves.toEqual({ removed: true });

    expect(await rowsFor(issuer)).toHaveLength(0);
    const kept = await getDb().select().from(localCredentials).where(eq(localCredentials.userId, user.id));
    expect(kept).toHaveLength(1);
  });

  it("still refuses with link_last_method when it would remove the last method", async () => {
    const issuer = `https://off-${randomUUID()}.invalid.example`;
    const user = await member("self-last", { password: false, issuers: [issuer] });
    process.env.ORBIT_AUTH_OIDC = "false";
    resetAuthConfigForTests();
    const [row] = await rowsFor(issuer);

    await expect(credentials.unlinkIdentity(user.id, row.id, challenge(user.id))).rejects.toMatchObject({
      code: "link_last_method",
    });

    expect(await rowsFor(issuer)).toHaveLength(1);
  });
});
