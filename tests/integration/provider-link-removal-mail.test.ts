/*
 * Removing a sign-in provider's links: the mail-sending mode, sessions, audit
 * counts and the administrator route (#1676, owner answer 45b, Fable's design).
 *
 * Written from the design note on the issue, not from the implementation.
 * The function under test is `removeProviderLinks(actorUserId, issuer,
 * options?)` from `@/server/local-credentials`. Without options it is the
 * bare mode (`provider_removal_strands_members`, covered in
 * provider-link-removal.test.ts). With `{ mailStranded: true }` it mails the
 * existing setup link to every member left with no way in.
 *
 * Choices these tests pin that the design note left open (the build may
 * rename them, but then these tests are the place to change):
 *  - options: `{ mailStranded?: boolean; expiresInDays?: number; mailer?: SetupMailer | null }`.
 *    A supplied mailer counts as outgoing mail being ready; `mailer: null`
 *    (and, for the route, no SMTP configuration) means not ready.
 *  - result: `{ removed, members, mailed, mailFailed, sessionsEnded,
 *    recipients: [{ userId, mailed, reason }] }`, `reason` null when mailed.
 *  - refusal codes: `mail_not_ready` (409), `provider_still_configured` (409),
 *    `recipient_address_unreadable` (409, the existing code for an address
 *    that cannot be read).
 *  - route: POST /api/admin/provider-links/remove, body
 *    `{ issuer, mailStranded?, expiresInDays?, currentPassword? }`, intent
 *    `provider_links_remove`.
 */

import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { getDb } from "@/db";
import {
  auditLog,
  credentialSetupTokens,
  externalIdentities,
  localCredentials,
  sessions,
  userPreferences,
  users,
} from "@/db/schema";
import { hashPassword } from "@/lib/auth/password";
import { stepUpIntents } from "@/lib/auth/recent-auth";
import { getAuthConfig, resetAuthConfigForTests } from "@/lib/env";
import * as credentials from "@/server/local-credentials";
import type { SmtpNotification } from "@/server/notification-worker";
import {
  accountAddressColumns,
  cleanupIntegrationEnvironment,
  createIntegrationFixture,
  type IntegrationSession,
} from "./support/fixtures";
import { callRouteForSession, loadRoute, type RouteHandler } from "./support/request-event";

const previousOidcKey = process.env.ORBIT_AUTH_OIDC;
process.env.ORBIT_AUTH_OIDC = "true";
resetAuthConfigForTests();

const PASSWORD = "a-correct-local-password";
const ORIGIN = "http://127.0.0.1:3000";
const DAY_MS = 24 * 60 * 60 * 1000;
const created: string[] = [];

afterEach(async () => {
  const db = getDb();
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

interface Recipient {
  userId: string;
  mailed: boolean;
  reason: string | null;
}
interface RemovalResult {
  removed: number;
  members: number;
  mailed: number;
  mailFailed: number;
  sessionsEnded: number;
  recipients: Recipient[];
}
interface Mailer {
  sendEmail(notification: SmtpNotification): Promise<void>;
}
interface Options {
  mailStranded?: boolean;
  expiresInDays?: number;
  mailer?: Mailer | null;
}

function removeProviderLinks(actorUserId: string, issuer: string, options?: Options): Promise<RemovalResult> {
  const fn = (credentials as unknown as {
    removeProviderLinks: (a: string, i: string, o?: Options) => Promise<RemovalResult>;
  }).removeProviderLinks;
  return fn(actorUserId, issuer, options);
}

function captureMailer(failFor: string[] = []) {
  const sent: SmtpNotification[] = [];
  const mailer: Mailer = {
    async sendEmail(notification) {
      if (failFor.includes(notification.to)) throw new Error("connection dropped");
      sent.push(notification);
    },
  };
  return { sent, mailer };
}

interface Member {
  id: string;
  email: string;
}

async function member(
  label: string,
  options: { password: boolean; admin?: boolean; issuers: string[] },
): Promise<Member> {
  const id = randomUUID();
  const email = `${label}-${id.slice(0, 8)}@removal.invalid`;
  const db = getDb();
  await db.insert(users).values({
    id,
    ...(await accountAddressColumns(id, email)),
    emailVerified: true,
    displayName: `Removal ${label}`,
    isInstanceAdmin: options.admin === true,
  });
  created.push(id);
  await db.insert(userPreferences).values({ userId: id });
  if (options.password) {
    await db.insert(localCredentials).values({ userId: id, passwordHash: await hashPassword(PASSWORD) });
  }
  for (const issuer of options.issuers) {
    await db.insert(externalIdentities).values({ userId: id, issuer, subject: `sub-${label}-${randomUUID().slice(0, 8)}` });
  }
  return { id, email };
}

/** A session; `provider` gives it an ID token, as a provider sign-in does. */
async function session(userId: string, provider: boolean): Promise<string> {
  const id = randomUUID();
  await getDb().insert(sessions).values({
    id,
    userId,
    tokenHash: `hash-${randomUUID()}`,
    expiresAt: new Date(Date.now() + DAY_MS),
    idTokenEnc: provider ? "sealed-id-token-for-test" : null,
  });
  return id;
}

async function sessionIds(userIds: string[]): Promise<string[]> {
  const rows = await getDb().select({ id: sessions.id }).from(sessions).where(inArray(sessions.userId, userIds));
  return rows.map((row) => row.id);
}

async function rowsFor(issuer: string) {
  return getDb().select().from(externalIdentities).where(eq(externalIdentities.issuer, issuer));
}

async function auditActions(): Promise<string[]> {
  return (await getDb().select({ action: auditLog.action }).from(auditLog)).map((row) => row.action).sort();
}

function newIssuer(label = "gone"): string {
  return `https://${label}-${randomUUID()}.invalid.example`;
}

function configuredIssuer(): string {
  const oidc = getAuthConfig().oidc;
  if (!oidc) throw new Error("test needs ORBIT_AUTH_OIDC=true");
  return oidc.issuer;
}

async function expectRefused(
  attempt: Promise<unknown>,
  expected: { code: string; status?: number },
): Promise<Error> {
  const failure = await attempt.then(() => null, (error: unknown) => error as Error);
  expect(failure).toBeInstanceOf(Error);
  expect(failure).toMatchObject({ code: expected.code, ...(expected.status ? { status: expected.status } : {}) });
  return failure as Error;
}

describe("mail mode: stranded members get the existing setup mail (#1676)", () => {
  it("mails exactly the members left with no way in, once each, and leaves the others unmailed", async () => {
    const gone = newIssuer();
    const admin = await member("m-admin", { password: true, admin: true, issuers: [] });
    const stranded1 = await member("m-one", { password: false, issuers: [gone] });
    const stranded2 = await member("m-two", { password: false, issuers: [gone, newIssuer("other")] });
    const withPassword = await member("m-pw", { password: true, issuers: [gone] });
    const withOtherWay = await member("m-other", { password: false, issuers: [gone, configuredIssuer()] });
    const capture = captureMailer();

    const result = await removeProviderLinks(admin.id, gone, { mailStranded: true, mailer: capture.mailer });

    expect(capture.sent.map((mail) => mail.to).sort()).toEqual([stranded1.email, stranded2.email].sort());
    expect(result.removed).toBe(4);
    expect(result.members).toBe(4);
    expect(result.mailed).toBe(2);
    expect(result.mailFailed).toBe(0);
    expect(await rowsFor(gone)).toHaveLength(0);
    const mailed = result.recipients.filter((entry) => entry.mailed).map((entry) => entry.userId).sort();
    expect(mailed).toEqual([stranded1.id, stranded2.id].sort());
    expect(result.recipients.every((entry) => entry.mailed ? entry.reason === null : true)).toBe(true);
    const mailedIds = result.recipients.map((entry) => entry.userId);
    expect(mailedIds).not.toContain(withPassword.id);
    expect(mailedIds).not.toContain(withOtherWay.id);
    // The existing audit, once per mailed member (issued, then sent, as the per-person link writes); no new email type.
    const sent = await getDb().select().from(auditLog).where(eq(auditLog.action, "setup_link_sent"));
    expect(sent.map((row) => row.entityId).sort()).toEqual([stranded1.id, stranded2.id].sort());
    expect(await auditActions()).toEqual(["provider_links_removed", "setup_link_issued", "setup_link_issued", "setup_link_sent", "setup_link_sent"]);
  });

  it("uses the setup link path: a setup link lasting the default 7 days", async () => {
    const gone = newIssuer();
    const admin = await member("d-admin", { password: true, admin: true, issuers: [] });
    const stranded = await member("d-one", { password: false, issuers: [gone] });
    const capture = captureMailer();
    const before = Date.now();

    await removeProviderLinks(admin.id, gone, { mailStranded: true, mailer: capture.mailer });

    expect(capture.sent[0].text).toMatch(/\/setup\//u);
    const [token] = await getDb().select().from(credentialSetupTokens).where(eq(credentialSetupTokens.userId, stranded.id));
    expect(token.purpose).toBe("setup");
    expect(Math.abs(token.expiresAt.getTime() - (before + 7 * DAY_MS))).toBeLessThan(60_000);
  });

  it("honours the administrator's chosen number of days", async () => {
    const gone = newIssuer();
    const admin = await member("n-admin", { password: true, admin: true, issuers: [] });
    const stranded = await member("n-one", { password: false, issuers: [gone] });
    const before = Date.now();

    await removeProviderLinks(admin.id, gone, { mailStranded: true, expiresInDays: 14, mailer: captureMailer().mailer });

    const [token] = await getDb().select().from(credentialSetupTokens).where(eq(credentialSetupTokens.userId, stranded.id));
    expect(Math.abs(token.expiresAt.getTime() - (before + 14 * DAY_MS))).toBeLessThan(60_000);
  });

  it("refuses a lifetime outside 1 to 14 days before changing anything", async () => {
    const gone = newIssuer();
    const admin = await member("l-admin", { password: true, admin: true, issuers: [] });
    await member("l-one", { password: false, issuers: [gone] });
    const capture = captureMailer();

    for (const days of [0, 15]) {
      await expect(removeProviderLinks(admin.id, gone, { mailStranded: true, expiresInDays: days, mailer: capture.mailer }))
        .rejects.toThrow();
    }

    expect(await rowsFor(gone)).toHaveLength(1);
    expect(capture.sent).toHaveLength(0);
    expect(await auditActions()).toEqual([]);
  });

  it("with nobody stranded, removes the links and sends no mail", async () => {
    const gone = newIssuer();
    const admin = await member("z-admin", { password: true, admin: true, issuers: [gone] });
    await member("z-pw", { password: true, issuers: [gone] });
    const capture = captureMailer();

    const result = await removeProviderLinks(admin.id, gone, { mailStranded: true, mailer: capture.mailer });

    expect(result).toMatchObject({ removed: 2, members: 2, mailed: 0, mailFailed: 0 });
    expect(capture.sent).toHaveLength(0);
    expect(await rowsFor(gone)).toHaveLength(0);
  });
});

describe("mail mode: a disabled member is never mailed (#1676)", () => {
  it("does not mail a stranded disabled member, reports member_disabled, and still removes their links", async () => {
    const gone = newIssuer();
    const admin = await member("dis-admin", { password: true, admin: true, issuers: [] });
    const disabled = await member("dis-off", { password: false, issuers: [gone] });
    await getDb().update(users).set({ disabledAt: new Date() }).where(eq(users.id, disabled.id));
    const capture = captureMailer();

    const result = await removeProviderLinks(admin.id, gone, { mailStranded: true, mailer: capture.mailer });

    expect(capture.sent).toHaveLength(0);
    expect(await rowsFor(gone)).toHaveLength(0);
    expect(result).toMatchObject({ removed: 1, members: 1, mailed: 0 });
    expect(result.recipients.find((entry) => entry.userId === disabled.id)).toMatchObject({
      mailed: false,
      reason: "member_disabled",
    });
    expect(await getDb().select().from(credentialSetupTokens).where(eq(credentialSetupTokens.userId, disabled.id))).toHaveLength(0);
    const sent = await getDb().select().from(auditLog).where(eq(auditLog.action, "setup_link_sent"));
    expect(sent).toHaveLength(0);
  });

  it("mails a stranded member who is not disabled in the same removal", async () => {
    const gone = newIssuer();
    const admin = await member("disx-admin", { password: true, admin: true, issuers: [] });
    const disabled = await member("disx-off", { password: false, issuers: [gone] });
    const active = await member("disx-on", { password: false, issuers: [gone] });
    await getDb().update(users).set({ disabledAt: new Date() }).where(eq(users.id, disabled.id));
    const capture = captureMailer();

    const result = await removeProviderLinks(admin.id, gone, { mailStranded: true, mailer: capture.mailer });

    expect(capture.sent.map((mail) => mail.to)).toEqual([active.email]);
    expect(result).toMatchObject({ removed: 2, members: 2, mailed: 1 });
    expect(result.recipients.find((entry) => entry.userId === active.id)).toMatchObject({ mailed: true, reason: null });
    expect(result.recipients.find((entry) => entry.userId === disabled.id)).toMatchObject({
      mailed: false,
      reason: "member_disabled",
    });
  });
});

describe("mail mode: a failed mail does not undo the removal (#1676)", () => {
  it("removes every link, mails the others, and reports the failed member with a reason", async () => {
    const gone = newIssuer();
    const admin = await member("f-admin", { password: true, admin: true, issuers: [] });
    const good = await member("f-good", { password: false, issuers: [gone] });
    const bad = await member("f-bad", { password: false, issuers: [gone] });
    const capture = captureMailer([bad.email]);

    const result = await removeProviderLinks(admin.id, gone, { mailStranded: true, mailer: capture.mailer });

    expect(await rowsFor(gone)).toHaveLength(0);
    expect(capture.sent.map((mail) => mail.to)).toEqual([good.email]);
    expect(result).toMatchObject({ removed: 2, members: 2, mailed: 1, mailFailed: 1 });
    const failed = result.recipients.find((entry) => entry.userId === bad.id);
    expect(failed?.mailed).toBe(false);
    expect(typeof failed?.reason).toBe("string");
    expect(failed?.reason).not.toBe("");
    expect(failed?.reason).not.toContain(bad.email);
    expect(result.recipients.find((entry) => entry.userId === good.id)).toMatchObject({ mailed: true, reason: null });
    // A mail that did not go is never recorded as sent.
    const sent = await getDb().select().from(auditLog).where(eq(auditLog.action, "setup_link_sent"));
    expect(sent.map((row) => row.entityId)).toEqual([good.id]);
    const [removal] = await getDb().select().from(auditLog).where(eq(auditLog.action, "provider_links_removed"));
    expect(removal.changes).toMatchObject({ mailed: 1, mailFailed: 1 });
  });

  it("keeps the links removed when every mail fails", async () => {
    const gone = newIssuer();
    const admin = await member("a-admin", { password: true, admin: true, issuers: [] });
    const one = await member("a-one", { password: false, issuers: [gone] });
    const two = await member("a-two", { password: false, issuers: [gone] });

    const result = await removeProviderLinks(admin.id, gone, {
      mailStranded: true,
      mailer: captureMailer([one.email, two.email]).mailer,
    });

    expect(await rowsFor(gone)).toHaveLength(0);
    expect(result).toMatchObject({ removed: 2, mailed: 0, mailFailed: 2 });
    expect(result.recipients.every((entry) => !entry.mailed && Boolean(entry.reason))).toBe(true);
  });
});

describe("mail mode: refusals change nothing (#1676)", () => {
  async function expectUntouched(gone: string, rows: number, capture: ReturnType<typeof captureMailer>) {
    expect(await rowsFor(gone)).toHaveLength(rows);
    expect(capture.sent).toHaveLength(0);
    expect(await auditActions()).toEqual([]);
    expect(await getDb().select().from(credentialSetupTokens).where(inArray(credentialSetupTokens.userId, created))).toHaveLength(0);
  }

  it("refuses with 409 mail_not_ready when outgoing mail is not ready, before anything changes", async () => {
    const gone = newIssuer();
    const admin = await member("r-admin", { password: true, admin: true, issuers: [] });
    await member("r-one", { password: false, issuers: [gone] });
    const stranded = await member("r-two", { password: false, issuers: [gone] });
    const providerSession = await session(stranded.id, true);
    const capture = captureMailer();

    await expectRefused(removeProviderLinks(admin.id, gone, { mailStranded: true, mailer: null }), {
      code: "mail_not_ready",
      status: 409,
    });

    await expectUntouched(gone, 2, capture);
    expect(await sessionIds([stranded.id])).toEqual([providerSession]);
  });

  it("refuses with mail_not_ready even when nobody would be stranded", async () => {
    const gone = newIssuer();
    const admin = await member("rn-admin", { password: true, admin: true, issuers: [gone] });

    await expectRefused(removeProviderLinks(admin.id, gone, { mailStranded: true, mailer: null }), {
      code: "mail_not_ready",
      status: 409,
    });

    expect(await rowsFor(gone)).toHaveLength(1);
  });

  it("refuses with 409 while the issuer is the one currently configured, saying to turn the provider off first", async () => {
    const admin = await member("c-admin", { password: true, admin: true, issuers: [configuredIssuer()] });
    await member("c-pw", { password: true, issuers: [configuredIssuer()] });
    const capture = captureMailer();

    const failure = await expectRefused(
      removeProviderLinks(admin.id, configuredIssuer(), { mailStranded: true, mailer: capture.mailer }),
      { code: "provider_still_configured", status: 409 },
    );

    expect(failure.message.toLowerCase()).toMatch(/turn .*off|configuration/u);
    await expectUntouched(configuredIssuer(), 2, capture);
  });

  it("refuses the still-configured issuer in the bare mode too", async () => {
    const admin = await member("cb-admin", { password: true, admin: true, issuers: [configuredIssuer()] });

    await expectRefused(removeProviderLinks(admin.id, configuredIssuer()), {
      code: "provider_still_configured",
      status: 409,
    });

    expect(await rowsFor(configuredIssuer())).toHaveLength(1);
    expect(await auditActions()).toEqual([]);
  });

  it("allows the removal once the provider is turned off, even for the issuer that was configured", async () => {
    const issuer = configuredIssuer();
    const admin = await member("off-admin", { password: true, admin: true, issuers: [issuer] });
    process.env.ORBIT_AUTH_OIDC = "false";
    resetAuthConfigForTests();

    const result = await removeProviderLinks(admin.id, issuer, { mailStranded: true, mailer: captureMailer().mailer });

    expect(result.removed).toBe(1);
    expect(await rowsFor(issuer)).toHaveLength(0);
  });

  it("refuses with its own reason when a stranded member's address cannot be read", async () => {
    const gone = newIssuer();
    const admin = await member("u-admin", { password: true, admin: true, issuers: [] });
    await member("u-fine", { password: false, issuers: [gone] });
    const unreadable = await member("u-locked", { password: false, issuers: [gone] });
    await getDb().update(users).set({ emailEnc: null }).where(eq(users.id, unreadable.id));
    const capture = captureMailer();

    const failure = await expectRefused(
      removeProviderLinks(admin.id, gone, { mailStranded: true, mailer: capture.mailer }),
      { code: "recipient_address_unreadable", status: 409 },
    );

    expect(failure.message).not.toContain(unreadable.email);
    await expectUntouched(gone, 2, capture);
  });

  it("does not let an unreadable address of a member who keeps a way in block the removal", async () => {
    const gone = newIssuer();
    const admin = await member("uk-admin", { password: true, admin: true, issuers: [] });
    const keeper = await member("uk-pw", { password: true, issuers: [gone] });
    await getDb().update(users).set({ emailEnc: null }).where(eq(users.id, keeper.id));

    const result = await removeProviderLinks(admin.id, gone, { mailStranded: true, mailer: captureMailer().mailer });

    expect(result.removed).toBe(1);
  });

  it("refuses a non-administrator in mail mode and changes nothing", async () => {
    const gone = newIssuer();
    const plain = await member("p-plain", { password: true, issuers: [gone] });
    const capture = captureMailer();

    await expect(removeProviderLinks(plain.id, gone, { mailStranded: true, mailer: capture.mailer })).rejects.toThrow();

    await expectUntouched(gone, 1, capture);
  });
});

describe("bare mode keeps refusing a stranded member (#1676)", () => {
  it("is 409 provider_removal_strands_members with no options, and mails nothing", async () => {
    const gone = newIssuer();
    const admin = await member("bare-admin", { password: true, admin: true, issuers: [] });
    await member("bare-one", { password: false, issuers: [gone] });

    await expectRefused(removeProviderLinks(admin.id, gone), { code: "provider_removal_strands_members", status: 409 });
    await expectRefused(removeProviderLinks(admin.id, gone, { mailStranded: false }), {
      code: "provider_removal_strands_members",
      status: 409,
    });

    expect(await rowsFor(gone)).toHaveLength(1);
    expect(await auditActions()).toEqual([]);
  });
});

describe("sessions end with the links (#1676)", () => {
  it("ends provider sessions of every user who had a link, and keeps password sessions and other users' sessions", async () => {
    const gone = newIssuer();
    const admin = await member("s-admin", { password: true, admin: true, issuers: [] });
    const linkedPw = await member("s-pw", { password: true, issuers: [gone] });
    const linkedStranded = await member("s-stranded", { password: false, issuers: [gone] });
    const unlinked = await member("s-unlinked", { password: true, issuers: [] });
    const otherProvider = await member("s-other", { password: true, issuers: [newIssuer("other")] });

    const ended = [
      await session(linkedPw.id, true),
      await session(linkedStranded.id, true),
      await session(linkedStranded.id, true),
    ];
    const survivors = [
      await session(linkedPw.id, false),
      await session(unlinked.id, true),
      await session(otherProvider.id, true),
      await session(admin.id, true),
    ];

    const result = await removeProviderLinks(admin.id, gone, { mailStranded: true, mailer: captureMailer().mailer });

    const remaining = await sessionIds([linkedPw.id, linkedStranded.id, unlinked.id, otherProvider.id, admin.id]);
    expect(remaining.sort()).toEqual([...survivors].sort());
    for (const id of ended) expect(remaining).not.toContain(id);
    expect(result.sessionsEnded).toBe(3);
  });

  it("ends provider sessions in the bare mode as well", async () => {
    const gone = newIssuer();
    const admin = await member("sb-admin", { password: true, admin: true, issuers: [] });
    const linked = await member("sb-linked", { password: true, issuers: [gone] });
    const providerSession = await session(linked.id, true);
    const passwordSession = await session(linked.id, false);

    await removeProviderLinks(admin.id, gone);

    expect(await sessionIds([linked.id])).toEqual([passwordSession]);
    expect(providerSession).not.toBe(passwordSession);
  });

  it("keeps sessions when the removal is refused", async () => {
    const gone = newIssuer();
    const admin = await member("sr-admin", { password: true, admin: true, issuers: [] });
    const stranded = await member("sr-one", { password: false, issuers: [gone] });
    const providerSession = await session(stranded.id, true);

    await expectRefused(removeProviderLinks(admin.id, gone), { code: "provider_removal_strands_members" });

    expect(await sessionIds([stranded.id])).toEqual([providerSession]);
  });
});

describe("the acting administrator is a member like any other (#1676)", () => {
  it("mails the acting administrator when they are left without a way in, and ends their provider session", async () => {
    const gone = newIssuer();
    const admin = await member("self-admin", { password: false, admin: true, issuers: [gone] });
    const other = await member("self-other", { password: false, issuers: [gone] });
    const adminProviderSession = await session(admin.id, true);
    const capture = captureMailer();

    const result = await removeProviderLinks(admin.id, gone, { mailStranded: true, mailer: capture.mailer });

    expect(capture.sent.map((mail) => mail.to).sort()).toEqual([admin.email, other.email].sort());
    expect(result.recipients.find((entry) => entry.userId === admin.id)).toMatchObject({ mailed: true });
    expect(await sessionIds([admin.id])).not.toContain(adminProviderSession);
  });

  it("does not mail an acting administrator who has a password, but still ends their provider session", async () => {
    const gone = newIssuer();
    const admin = await member("self2-admin", { password: true, admin: true, issuers: [gone] });
    await member("self2-other", { password: false, issuers: [gone] });
    const providerSession = await session(admin.id, true);
    const passwordSession = await session(admin.id, false);
    const capture = captureMailer();

    await removeProviderLinks(admin.id, gone, { mailStranded: true, mailer: capture.mailer });

    expect(capture.sent.map((mail) => mail.to)).not.toContain(admin.email);
    const remaining = await sessionIds([admin.id]);
    expect(remaining).toContain(passwordSession);
    expect(remaining).not.toContain(providerSession);
  });
});

describe("audit: counts only (#1676)", () => {
  it("records provider_links_removed with exactly removed, members, mailed, mailFailed and sessionsEnded", async () => {
    const gone = newIssuer();
    const admin = await member("au-admin", { password: true, admin: true, issuers: [] });
    const good = await member("au-good", { password: false, issuers: [gone] });
    const bad = await member("au-bad", { password: false, issuers: [gone] });
    const keeper = await member("au-keeper", { password: true, issuers: [gone] });
    await session(good.id, true);
    await session(keeper.id, true);

    await removeProviderLinks(admin.id, gone, { mailStranded: true, mailer: captureMailer([bad.email]).mailer });

    const entries = await getDb().select().from(auditLog).where(eq(auditLog.action, "provider_links_removed"));
    expect(entries).toHaveLength(1);
    expect(entries[0].actorUserId).toBe(admin.id);
    expect(entries[0].changes).toEqual({ removed: 3, members: 3, mailed: 1, mailFailed: 1, sessionsEnded: 2 });
    const everything = JSON.stringify(await getDb().select().from(auditLog));
    for (const secret of [gone, new URL(gone).host, good.email, bad.email, keeper.email]) {
      expect(everything).not.toContain(secret);
    }
  });
});

describe("the administrator route (#1676)", () => {
  const ADMIN_PASSWORD = "the-administrators-own-password";
  const PATH = "/api/admin/provider-links/remove";

  async function route(): Promise<RouteHandler> {
    return (await loadRoute("admin/provider-links/remove")).POST;
  }

  async function post(who: IntegrationSession, body: unknown) {
    const response = await callRouteForSession(await route(), who, {
      url: `${ORIGIN}${PATH}`,
      method: "POST",
      body: JSON.stringify(body),
    });
    return { status: response.status, body: (await response.clone().json()) as Record<string, unknown> };
  }

  function errorCode(body: Record<string, unknown>): string | undefined {
    return (body.error as { code?: string } | undefined)?.code;
  }

  it("has the provider_links_remove step-up intent", () => {
    expect(stepUpIntents).toContain("provider_links_remove");
  });

  it("removes the links for an administrator who passes the password challenge", async () => {
    const fixture = await createIntegrationFixture("plr-ok");
    try {
      const admin = await fixture.session("admin");
      await getDb().insert(localCredentials).values({ userId: admin.userId, passwordHash: await hashPassword(ADMIN_PASSWORD) });
      const gone = newIssuer();
      const keeper = await member("rt-pw", { password: true, issuers: [gone] });
      const providerSession = await session(keeper.id, true);

      const answer = await post(admin, { issuer: gone, currentPassword: ADMIN_PASSWORD });

      expect(answer.status).toBe(200);
      expect(answer.body).toMatchObject({ removed: 1, sessionsEnded: 1 });
      expect(await rowsFor(gone)).toHaveLength(0);
      expect(await sessionIds([keeper.id])).not.toContain(providerSession);
    } finally {
      await fixture.cleanup();
    }
  }, 30_000);

  it("answers 403 to a non-administrator and changes nothing", async () => {
    const fixture = await createIntegrationFixture("plr-403");
    try {
      const owner = await fixture.session("owner");
      const gone = newIssuer();
      await member("rt-403", { password: true, issuers: [gone] });

      const answer = await post(owner, { issuer: gone, currentPassword: "irrelevant" });

      expect(answer.status).toBe(403);
      expect(await rowsFor(gone)).toHaveLength(1);
    } finally {
      await fixture.cleanup();
    }
  }, 30_000);

  it("refuses a missing or wrong challenge and changes nothing", async () => {
    const fixture = await createIntegrationFixture("plr-challenge");
    try {
      const admin = await fixture.session("admin");
      await getDb().insert(localCredentials).values({ userId: admin.userId, passwordHash: await hashPassword(ADMIN_PASSWORD) });
      const gone = newIssuer();
      await member("rt-ch", { password: true, issuers: [gone] });

      const missing = await post(admin, { issuer: gone });
      const wrong = await post(admin, { issuer: gone, currentPassword: "not-the-password" });

      expect(missing.status).toBe(403);
      expect(errorCode(missing.body)).toBe("recent_authentication_required");
      expect(wrong.status).toBe(403);
      expect(errorCode(wrong.body)).toBe("recent_authentication_required");
      expect(await rowsFor(gone)).toHaveLength(1);
      expect(await auditActions()).toEqual([]);
    } finally {
      await fixture.cleanup();
    }
  }, 30_000);

  it("is 409 mail_not_ready in mail mode when the instance has no outgoing mail, and changes nothing", async () => {
    const fixture = await createIntegrationFixture("plr-nomail");
    try {
      const admin = await fixture.session("admin");
      await getDb().insert(localCredentials).values({ userId: admin.userId, passwordHash: await hashPassword(ADMIN_PASSWORD) });
      const gone = newIssuer();
      await member("rt-nm", { password: false, issuers: [gone] });

      const answer = await post(admin, { issuer: gone, mailStranded: true, expiresInDays: 7, currentPassword: ADMIN_PASSWORD });

      expect(answer.status).toBe(409);
      expect(errorCode(answer.body)).toBe("mail_not_ready");
      expect(await rowsFor(gone)).toHaveLength(1);
      expect(await auditActions()).toEqual([]);
    } finally {
      await fixture.cleanup();
    }
  }, 30_000);

  it("is 409 provider_still_configured for the configured issuer", async () => {
    const fixture = await createIntegrationFixture("plr-conf");
    try {
      const admin = await fixture.session("admin");
      await getDb().insert(localCredentials).values({ userId: admin.userId, passwordHash: await hashPassword(ADMIN_PASSWORD) });
      const keeper = await member("rt-conf", { password: true, issuers: [configuredIssuer()] });

      const answer = await post(admin, { issuer: configuredIssuer(), currentPassword: ADMIN_PASSWORD });

      expect(answer.status).toBe(409);
      expect(errorCode(answer.body)).toBe("provider_still_configured");
      expect((await rowsFor(configuredIssuer())).map((row) => row.userId)).toEqual([keeper.id]);
    } finally {
      await fixture.cleanup();
    }
  }, 30_000);

  it("keeps the bare-mode 409 provider_removal_strands_members", async () => {
    const fixture = await createIntegrationFixture("plr-bare");
    try {
      const admin = await fixture.session("admin");
      await getDb().insert(localCredentials).values({ userId: admin.userId, passwordHash: await hashPassword(ADMIN_PASSWORD) });
      const gone = newIssuer();
      await member("rt-bare", { password: false, issuers: [gone] });

      const answer = await post(admin, { issuer: gone, currentPassword: ADMIN_PASSWORD });

      expect(answer.status).toBe(409);
      expect(errorCode(answer.body)).toBe("provider_removal_strands_members");
      expect(await rowsFor(gone)).toHaveLength(1);
    } finally {
      await fixture.cleanup();
    }
  }, 30_000);
});
