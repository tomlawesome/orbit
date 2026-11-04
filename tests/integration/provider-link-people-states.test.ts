/*
 * Each person's sign-in state, and the removed provider's later state
 * (#1676, ADR-0041, ratified mock-up round 2, scene 7 "people afterwards").
 * Extends GET /api/admin/provider-links; every existing field is untouched.
 *
 * Added to the response (decided with the tests):
 *   people:  [{ userId, displayName,
 *               signIn: { state: "password" }
 *                     | { state: "setup-link", expiresAt: ISO }   // live, unconsumed
 *                     | { state: "lapsed",     expiresAt: ISO }   // newest unconsumed link has run out
 *                     | { state: "none" } }]                      // no password, no link
 *            non-disabled members. A password wins over any link. The newest
 *            `setup`/`recovery` token decides between setup-link/lapsed;
 *            a consumed token counts for nothing.
 *   removed: [{ removedAt: ISO, removedBy: { userId, displayName },
 *               stillToSend: [{ userId, displayName }] }]
 *            one per removal in the audit log (its entry carries no issuer, so
 *            none here), newest first. `stillToSend` is computed at read
 *            time: members who now have no password, no live setup link and
 *            no remaining provider link.
 */
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { getDb } from "@/db";
import { auditLog, credentialSetupTokens, externalIdentities, instanceAuthority, localCredentials, userPreferences, users } from "@/db/schema";
import { hashPassword } from "@/lib/auth/password";
import { resetAuthConfigForTests } from "@/lib/env";
import * as credentials from "@/server/local-credentials";
import { accountAddressColumns, cleanupIntegrationEnvironment, createIntegrationFixture, type IntegrationSession } from "./support/fixtures";
import { callRouteForSession, loadRoute } from "./support/request-event";

const previousOidcKey = process.env.ORBIT_AUTH_OIDC;
process.env.ORBIT_AUTH_OIDC = "true";
resetAuthConfigForTests();

const { GET: readPreview } = await loadRoute("admin/provider-links");
const created: string[] = [];
const PASSWORD = "a-correct-local-password";
const DAY = 86_400_000;

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
type SignIn = { state: "password" | "none" } | { state: "setup-link" | "lapsed"; expiresAt: string };
type Body = {
  people: (Person & { signIn: SignIn })[];
  removed: { removedAt: string; removedBy: Person; stillToSend: Person[] }[];
};

async function read(session: IntegrationSession): Promise<Body> {
  const response = await callRouteForSession(readPreview, session, { url: "http://127.0.0.1:3000/api/admin/provider-links" });
  return await response.json() as Body;
}

async function member(label: string, options: { password: boolean; admin?: boolean; issuers?: string[] }) {
  const id = randomUUID();
  const email = `${label}-${id.slice(0, 8)}@states.invalid`;
  const db = getDb();
  await db.insert(users).values({
    id,
    ...(await accountAddressColumns(id, email)),
    emailVerified: true,
    displayName: `States ${label}`,
    isInstanceAdmin: options.admin === true,
  });
  created.push(id);
  await db.insert(userPreferences).values({ userId: id });
  if (options.password) await db.insert(localCredentials).values({ userId: id, passwordHash: await hashPassword(PASSWORD) });
  for (const issuer of options.issuers ?? []) {
    await db.insert(externalIdentities).values({ userId: id, issuer, subject: `sub-${label}-${id.slice(0, 8)}` });
  }
  return { userId: id, displayName: `States ${label}`, email };
}

async function link(userId: string, expiresAt: Date, consumedAt: Date | null = null) {
  await getDb().insert(credentialSetupTokens).values({
    userId, tokenHash: randomUUID(), purpose: "setup", expiresAt, consumedAt,
  });
}

const stateOf = (body: Body, userId: string) => body.people.find((p) => p.userId === userId)?.signIn;

describe("People sign-in states on GET /api/admin/provider-links (#1676 scene 7)", () => {
  it("says password set, setup link good until a date, link lapsed on a date, or none", async () => {
    const fixture = await createIntegrationFixture("pps-states");
    const withPassword = await member("ned", { password: true });
    const live = await member("rob", { password: false });
    const lapsed = await member("gran", { password: false });
    const nothing = await member("sue", { password: false });
    const liveUntil = new Date(Date.now() + 5 * DAY);
    const lapsedOn = new Date(Date.now() - 3 * DAY);
    await link(live.userId, liveUntil);
    await link(lapsed.userId, lapsedOn);
    await link(withPassword.userId, new Date(Date.now() + DAY));

    const body = await read(await fixture.session("admin"));

    expect(stateOf(body, withPassword.userId)).toEqual({ state: "password" });
    expect(stateOf(body, live.userId)).toEqual({ state: "setup-link", expiresAt: liveUntil.toISOString() });
    expect(stateOf(body, lapsed.userId)).toEqual({ state: "lapsed", expiresAt: lapsedOn.toISOString() });
    expect(stateOf(body, nothing.userId)).toEqual({ state: "none" });
    await fixture.cleanup();
  });

  it("uses the newest link, and ignores a consumed one", async () => {
    const fixture = await createIntegrationFixture("pps-newest");
    const renewed = await member("renewed", { password: false });
    const spent = await member("spent", { password: false });
    const newest = new Date(Date.now() + 6 * DAY);
    await link(renewed.userId, new Date(Date.now() - 2 * DAY));
    await link(renewed.userId, newest);
    await link(spent.userId, new Date(Date.now() + 2 * DAY), new Date());

    const body = await read(await fixture.session("admin"));

    expect(stateOf(body, renewed.userId)).toEqual({ state: "setup-link", expiresAt: newest.toISOString() });
    expect(stateOf(body, spent.userId)).toEqual({ state: "none" });
    await fixture.cleanup();
  });

  it("leaves a disabled member out of people", async () => {
    const fixture = await createIntegrationFixture("pps-disabled");
    const gone = await member("gone", { password: false });
    await getDb().update(users).set({ disabledAt: new Date() }).where(inArray(users.id, [gone.userId]));
    const body = await read(await fixture.session("admin"));
    expect(body.people.find((p) => p.userId === gone.userId)).toBeUndefined();
    await fixture.cleanup();
  });
});

describe("the removed provider's later state (#1676 scene 7)", () => {
  it("records when it was removed, by whom, and who is still to send (mock-up story: Rob's mail went, Gran's was refused)", async () => {
    const fixture = await createIntegrationFixture("pps-removed");
    const gone = `https://gone-${randomUUID()}.invalid.example`;
    const primary = await member("primary", { password: true, admin: true });
    await getDb().insert(instanceAuthority).values({ primaryUserId: primary.userId });
    const rob = await member("rob", { password: false, issuers: [gone] });
    const gran = await member("gran", { password: false, issuers: [gone] });
    await member("emma", { password: true, issuers: [gone] });
    const mailer = {
      async sendEmail(notification: { to: string }) {
        if (notification.to === gran.email) throw new Error("the relay refused the message");
      },
    };
    const before = Date.now();
    await credentials.removeProviderLinks(primary.userId, gone, { mailStranded: true, mailer: mailer as never });
    const after = Date.now();
    // Gran's earlier link has lapsed; whatever the refused mail left behind goes.
    await getDb().delete(credentialSetupTokens).where(eq(credentialSetupTokens.userId, gran.userId));
    await link(gran.userId, new Date(Date.now() - DAY));

    const body = await read(await fixture.session("admin"));

    expect(body.removed).toHaveLength(1);
    const removedAt = Date.parse(body.removed[0].removedAt);
    expect(removedAt).toBeGreaterThanOrEqual(before - 1000);
    expect(removedAt).toBeLessThanOrEqual(after + 1000);
    expect(body.removed[0].removedBy).toEqual({ userId: primary.userId, displayName: primary.displayName });
    // Rob has a live link from the mail; Emma has a password; Gran has neither.
    expect(stateOf(body, rob.userId)?.state).toBe("setup-link");
    expect(body.removed[0].stillToSend).toEqual([{ userId: gran.userId, displayName: gran.displayName }]);
    await fixture.cleanup();
  });

  it("is empty when nothing has been removed", async () => {
    const fixture = await createIntegrationFixture("pps-none-removed");
    expect((await read(await fixture.session("admin"))).removed).toEqual([]);
    await fixture.cleanup();
  });
});
