/*
 * The read-only preview behind the Administration "Sign-in providers" card
 * (#1676, ADR-0041, ratified mock-up round 2): GET /api/admin/provider-links.
 *
 * Shape pinned here (decided with the tests, so the card and the route agree):
 *   { providers: [{ issuer, configured, members: [{ userId, displayName }],
 *                   stranded: [{ userId, displayName }] }],
 *     primary: { userId, displayName } | null,
 *     viewerIsPrimary: boolean, viewerHasPassword: boolean }
 * `stranded` is who would have no other way in: linked to that issuer, no
 * password, not disabled. `configured` means the issuer is still the
 * configured provider (removal is refused; the card says so).
 */

import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { getDb } from "@/db";
import { auditLog, externalIdentities, instanceAuthority, localCredentials, userPreferences, users } from "@/db/schema";
import { hashPassword } from "@/lib/auth/password";
import { getAuthConfig, resetAuthConfigForTests } from "@/lib/env";
import { accountAddressColumns, cleanupIntegrationEnvironment, createIntegrationFixture, type IntegrationSession } from "./support/fixtures";
import { callRouteForSession, loadRoute } from "./support/request-event";

const previousOidcKey = process.env.ORBIT_AUTH_OIDC;
process.env.ORBIT_AUTH_OIDC = "true";
resetAuthConfigForTests();

const URL_ = "http://127.0.0.1:3000/api/admin/provider-links";
const { GET: readPreview } = await loadRoute("admin/provider-links");

const created: string[] = [];

afterEach(async () => {
  const db = getDb();
  await db.delete(instanceAuthority);
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

type Person = { userId: string; displayName: string };
type Preview = {
  providers: { issuer: string; configured: boolean; members: Person[]; stranded: Person[] }[];
  primary: Person | null;
  viewerIsPrimary: boolean;
  viewerHasPassword: boolean;
};

async function preview(session: IntegrationSession) {
  const response = await callRouteForSession(readPreview, session, { url: URL_ });
  return { status: response.status, body: await response.json() as Preview & { error?: { code: string } } };
}

async function addPassword(userId: string) {
  await getDb().insert(localCredentials).values({ userId, passwordHash: await hashPassword("a-correct-local-password") });
}

async function member(label: string, options: { password: boolean; disabled?: boolean; issuers: string[] }) {
  const id = randomUUID();
  const email = `${label}-${id.slice(0, 8)}@preview.invalid`;
  const db = getDb();
  await db.insert(users).values({
    id,
    ...(await accountAddressColumns(id, email)),
    emailVerified: true,
    displayName: `Preview ${label}`,
    ...(options.disabled ? { disabledAt: new Date() } : {}),
  });
  created.push(id);
  await db.insert(userPreferences).values({ userId: id });
  if (options.password) await addPassword(id);
  for (const issuer of options.issuers) {
    await db.insert(externalIdentities).values({ userId: id, issuer, subject: `sub-${label}-${id.slice(0, 8)}` });
  }
  return { id, displayName: `Preview ${label}` };
}

const providerFor = (body: Preview, issuer: string) => body.providers.find((p) => p.issuer === issuer);

describe("GET /api/admin/provider-links (#1676)", () => {
  it("refuses a signed-in member who is not an instance administrator", async () => {
    const fixture = await createIntegrationFixture("plp-refuse");
    const result = await preview(await fixture.session("member"));
    expect(result.status).toBe(403);
    expect(result.body.providers).toBeUndefined();
    await fixture.cleanup();
  });

  it("lists each linked issuer with its members and who would be stranded, leaving out disabled members and members with a password", async () => {
    const fixture = await createIntegrationFixture("plp-lists");
    const issuer = `https://gone-${randomUUID()}.invalid.example`;
    const stranded = await member("rob", { password: false, issuers: [issuer] });
    const withPassword = await member("emma", { password: true, issuers: [issuer] });
    const disabled = await member("gran", { password: false, disabled: true, issuers: [issuer] });

    const { status, body } = await preview(await fixture.session("admin"));

    expect(status).toBe(200);
    const provider = providerFor(body, issuer);
    expect(provider).toBeDefined();
    expect(provider!.configured).toBe(false);
    expect(provider!.members.map((p) => p.userId).sort()).toEqual([stranded.id, withPassword.id, disabled.id].sort());
    expect(provider!.members.find((p) => p.userId === stranded.id)?.displayName).toBe(stranded.displayName);
    expect(provider!.stranded).toEqual([{ userId: stranded.id, displayName: stranded.displayName }]);
    await fixture.cleanup();
  });

  it("marks the issuer that is still the configured provider", async () => {
    const fixture = await createIntegrationFixture("plp-configured");
    const configured = getAuthConfig().oidc!.issuer;
    const other = `https://other-${randomUUID()}.invalid.example`;
    await member("on", { password: true, issuers: [configured, other] });

    const { body } = await preview(await fixture.session("admin"));

    expect(providerFor(body, configured)?.configured).toBe(true);
    expect(providerFor(body, other)?.configured).toBe(false);
    await fixture.cleanup();
  });

  it("names the primary administrator and says the viewer is not them", async () => {
    const fixture = await createIntegrationFixture("plp-other-admin");
    const primary = await member("ned", { password: true, issuers: [] });
    await getDb().update(users).set({ isInstanceAdmin: true }).where(eq(users.id, primary.id));
    await getDb().insert(instanceAuthority).values({ primaryUserId: primary.id });

    const { body } = await preview(await fixture.session("admin"));

    expect(body.primary).toEqual({ userId: primary.id, displayName: primary.displayName });
    expect(body.viewerIsPrimary).toBe(false);
    await fixture.cleanup();
  });

  it("tells the primary administrator they are primary, and whether they have a password", async () => {
    const fixture = await createIntegrationFixture("plp-primary");
    const admin = fixture.users.admin;
    await getDb().insert(instanceAuthority).values({ primaryUserId: admin.id });
    const session = await fixture.session("admin");

    const without = (await preview(session)).body;
    expect(without.viewerIsPrimary).toBe(true);
    expect(without.primary?.userId).toBe(admin.id);
    expect(typeof without.primary?.displayName).toBe("string");
    expect(without.viewerHasPassword).toBe(false);

    await addPassword(admin.id);
    expect((await preview(session)).body.viewerHasPassword).toBe(true);
    await fixture.cleanup();
  });

  it("gives an empty list when no member is linked to any provider", async () => {
    const fixture = await createIntegrationFixture("plp-empty");
    await getDb().delete(externalIdentities);

    const { status, body } = await preview(await fixture.session("admin"));

    expect(status).toBe(200);
    expect(body.providers).toEqual([]);
    await fixture.cleanup();
  });
});
