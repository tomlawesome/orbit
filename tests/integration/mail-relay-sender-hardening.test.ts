import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/db";
import {
  auditLog,
  externalIdentities,
  imapRecipientAliases,
  mailInMailbox,
  mailInRelays,
  mailInSecrets,
  mailInSenderAddresses,
} from "@/db/schema";
import { provisionIdentity } from "@/lib/auth/provision";
import { setMailboxSettings, type MailboxSettingsDependencies, type MailboxSettingsInput } from "@/server/mail-in/mailbox-settings";
import { readRelaySettings } from "@/server/mail-in/relay-settings";
import { hasVerifiedSenderAddress, listSenderAddresses, seedSenderAddress, userForVerifiedSender } from "@/server/mail-in/sender-addresses";
import { cleanupIntegrationEnvironment, createIntegrationFixture, senderAddressColumns, type IntegrationFixture, type IntegrationSession } from "./support/fixtures";
import { callRoute, callRouteForSession, loadRoute } from "./support/request-event";

/*
 * Issue #1403, the review of the decision 7c code. One failing case per
 * finding, written from the behaviour the review asked for:
 *
 *   1. With the key working, a stored sender row that fails authentication is
 *      damaged: a relay read or a send attempt replaces it with a row for the
 *      registered address, unchecked if the damaged row was unchecked and
 *      verified if it was verified (release audit, #1316). With several rows, rows that decrypt to another address
 *      go too, and the registered row stays. (The locked-key case, where such
 *      a row is kept, is in mail-relay-sender-read.test.ts.)
 *   2. When the registered address changes outside the settings screen (the
 *      single sign-on path), mail from the old address stops attributing to
 *      the member and an outstanding link for it stops verifying, with no
 *      relay read in between.
 *   3. If the mailer fails, the relay read afterwards reports no pending link.
 *   4. (A lapsed link reporting its expiry is asserted in
 *      mail-relay-sender-read.test.ts, where the old expectation lived.)
 *   5. With APP_URL empty or unset, a send answers 503 with a stable code, not 500.
 *   6. A member's only sending address is their registered one (decision 7c):
 *      a stored, verified row for any other address, whatever its source,
 *      attributes nothing and does not count as a verified address.
 *
 * Mail is captured at the transport library; nothing opens a socket.
 */
const mail = vi.hoisted(() => ({
  sent: [] as Array<{ from: string; to: string; subject: string; text: string }>,
  failing: false,
}));

vi.mock("nodemailer", () => {
  const createTransport = () => ({
    async sendMail(message: { from: string; to: string; subject: string; text: string }) {
      if (mail.failing) throw new Error("the mail server refused the message");
      mail.sent.push({ from: message.from, to: message.to, subject: message.subject, text: message.text });
      return { messageId: "fixture" };
    },
    async verify() { return true; },
    close() {},
  });
  return { default: { createTransport }, createTransport };
});

const settings: MailboxSettingsInput = {
  host: "imap.example.test",
  port: 993,
  accountUser: "intake@example.test",
  mailbox: "INBOX",
  tlsServerName: "imap.example.test",
  providerProfile: "mailcow",
  trustedRecipientHeader: "X-Original-To",
  trustedAuthservId: "mx.provider.test",
  pollSeconds: 300,
  password: "fake-sender-hardening-password",
};
const providerReady: MailboxSettingsDependencies = { verifyImap: async () => "ready" };

const VERIFICATION_URL = "http://127.0.0.1:3000/api/settings/mail-relay/verification";
const VERIFY_URL = "http://127.0.0.1:3000/api/settings/mail-relay/verify";

const verificationRoute = async () => (await loadRoute("settings/mail-relay/verification")).POST;
const verifyRoute = async () => (await loadRoute("settings/mail-relay/verify")).GET;

let fixture: IntegrationFixture;
const savedEnvironment: Record<string, string | undefined> = {};

beforeEach(async () => {
  mail.sent.length = 0;
  mail.failing = false;
  for (const name of ["SMTP_PORT", "SMTP_FROM", "SMTP_HOST", "SMTP_USER", "SMTP_PASSWORD", "APP_URL"]) savedEnvironment[name] = process.env[name];
  delete process.env.SMTP_HOST;
  delete process.env.SMTP_USER;
  delete process.env.SMTP_PASSWORD;
  process.env.SMTP_HOST = "smtp.example.test"; process.env.SMTP_PORT = "587"; process.env.SMTP_USER = "orbit-test"; process.env.SMTP_PASSWORD = "fake-smtp-password";
  process.env.SMTP_FROM = "Orbit <orbit@example.test>";
  fixture = await createIntegrationFixture("sender-hardening");
});

afterEach(async () => {
  for (const [name, value] of Object.entries(savedEnvironment)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  const db = getDb();
  await db.delete(imapRecipientAliases);
  await db.delete(mailInSenderAddresses);
  await db.delete(mailInRelays);
  await db.update(mailInMailbox).set({ passwordSecretId: null, aliasKeySecretId: null });
  await db.delete(mailInMailbox);
  await db.delete(mailInSecrets);
  await db.delete(auditLog);
  await fixture.cleanup();
});

afterAll(async () => {
  await cleanupIntegrationEnvironment();
});

const turnMailInOn = () => setMailboxSettings(fixture.users.admin.id, null, settings, providerReady);
const memberActor = () => ({ id: fixture.users.member.id, isInstanceAdmin: false });

async function send(session: IntegrationSession) {
  return callRouteForSession(await verificationRoute(), session, { url: VERIFICATION_URL, method: "POST", body: null });
}

async function openLink(session: IntegrationSession, token: string) {
  return callRoute(await verifyRoute(), {
    url: `${VERIFY_URL}?token=${encodeURIComponent(token)}`,
    headers: { cookie: session.headers.cookie },
  });
}

function tokenIn(text: string): string {
  const match = /token=([A-Za-z0-9_-]+)/.exec(text);
  if (!match) throw new Error("the check email carried no link token");
  return match[1];
}

const rowsOf = (userId: string) => getDb().select().from(mailInSenderAddresses).where(eq(mailInSenderAddresses.userId, userId));

/** Seeds the member's row, then damages its stored (encrypted) address so it can no longer be read. */
async function seedUnreadableRow(userId: string) {
  await seedSenderAddress(userId);
  const [row] = await rowsOf(userId);
  if (!row.addressEnc) throw new Error("the seeded row holds no encrypted address to damage");
  const damaged = row.addressEnc.slice(0, -2) + (row.addressEnc.endsWith("A") ? "BB" : "AA");
  await getDb().update(mailInSenderAddresses).set({ addressEnc: damaged }).where(eq(mailInSenderAddresses.id, row.id));
  const [view] = await listSenderAddresses(userId);
  expect(view.address).toBeNull();
  return row.id;
}

/** The sign-in path that rewrites an account's address: the provider now reports a new one. */
async function providerReportsNewAddress(userId: string, email: string) {
  const [identity] = await getDb().select().from(externalIdentities).where(eq(externalIdentities.userId, userId));
  await provisionIdentity({
    issuer: identity.issuer,
    subject: identity.subject,
    email,
    emailVerified: true,
    displayName: "Integration member",
    avatarUrl: null,
  });
}

/** The damaged row is gone and one unverified row stands in its place. */
async function expectReplaced(rowId: string) {
  const rows = await rowsOf(fixture.users.member.id);
  expect(rows.map((row) => row.id)).not.toContain(rowId);
  expect(rows).toHaveLength(1);
  expect(rows[0].verifiedAt).toBeNull();
}

describe("finding 1: a damaged stored address is replaced, unverified", () => {
  it("keeps a damaged VERIFIED row's verification on the replacement through a relay read", async () => {
    await turnMailInOn();
    const rowId = await seedUnreadableRow(fixture.users.member.id);
    await getDb().update(mailInSenderAddresses).set({ verifiedAt: new Date() }).where(eq(mailInSenderAddresses.id, rowId));

    await readRelaySettings(memberActor());

    const rows = await rowsOf(fixture.users.member.id);
    expect(rows.map((row) => row.id)).not.toContain(rowId);
    expect(rows).toHaveLength(1);
    expect(rows[0].verifiedAt).not.toBeNull();
  });

  it("keeps a damaged VERIFIED row's verification on the replacement through a send attempt", async () => {
    const rowId = await seedUnreadableRow(fixture.users.member.id);
    await getDb().update(mailInSenderAddresses).set({ verifiedAt: new Date() }).where(eq(mailInSenderAddresses.id, rowId));
    const session = await fixture.session("member");

    const response = await send(session);

    expect(response.status).toBe(409);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe("sender_already_verified");
    expect(mail.sent).toHaveLength(0);
  });

  it("replaces a damaged unchecked row through a relay read", async () => {
    await turnMailInOn();
    const rowId = await seedUnreadableRow(fixture.users.member.id);

    await readRelaySettings(memberActor());

    await expectReplaced(rowId);
  });

  it("replaces a damaged unchecked row through a send attempt", async () => {
    const rowId = await seedUnreadableRow(fixture.users.member.id);
    const session = await fixture.session("member");

    await send(session);

    await expectReplaced(rowId);
  });

  /* Three rows for one member: the registered address, another readable
     address, and a damaged one. Only the registered address stays. */
  async function threeRows() {
    const userId = fixture.users.member.id;
    await seedSenderAddress(userId);
    const [registered] = await rowsOf(userId);
    const otherId = randomUUID();
    const [other] = await getDb().insert(mailInSenderAddresses).values({
      id: otherId,
      userId,
      ...await senderAddressColumns(otherId, "harlow-someone-else@example.test"),
      source: "manual",
    }).returning({ id: mailInSenderAddresses.id });
    const [unreadable] = await getDb().insert(mailInSenderAddresses).values({
      userId,
      addressEnc: `${registered.addressEnc?.slice(0, -2) ?? "damaged"}ZZ`,
      source: "manual",
    }).returning({ id: mailInSenderAddresses.id });
    return { registered: registered.id, other: other.id, unreadable: unreadable.id };
  }

  it("with several rows, a relay read keeps only the registered address", async () => {
    await turnMailInOn();
    const ids = await threeRows();

    await readRelaySettings(memberActor());

    const kept = (await rowsOf(fixture.users.member.id)).map((row) => row.id);
    expect(kept).toEqual([ids.registered]);
    expect(kept).not.toContain(ids.unreadable);
    expect(kept).not.toContain(ids.other);
  });

  it("with several rows, a send attempt keeps only the registered address", async () => {
    const ids = await threeRows();
    const session = await fixture.session("member");

    await send(session);

    const kept = (await rowsOf(fixture.users.member.id)).map((row) => row.id);
    expect(kept).toEqual([ids.registered]);
    expect(kept).not.toContain(ids.unreadable);
    expect(kept).not.toContain(ids.other);
  });
});

describe("finding 2: the registered address changes outside the settings screen", () => {
  const newAddress = "harlow-moved-by-provider@example.test";

  it("stops attributing mail from the old address to the member, with no relay read in between", async () => {
    const oldAddress = fixture.users.member.email;
    const session = await fixture.session("member");
    expect((await send(session)).status).toBe(202);
    await openLink(session, tokenIn(mail.sent[0].text));
    expect(await userForVerifiedSender(oldAddress)).toBe(fixture.users.member.id);

    await providerReportsNewAddress(fixture.users.member.id, newAddress);

    expect(await userForVerifiedSender(oldAddress)).toBeUndefined();
    expect(await userForVerifiedSender(newAddress)).toBeUndefined();
    expect(await hasVerifiedSenderAddress(fixture.users.member.id)).toBe(false);
  });

  it("stops an outstanding link for the old address from verifying anything", async () => {
    const oldAddress = fixture.users.member.email;
    const session = await fixture.session("member");
    expect((await send(session)).status).toBe(202);
    const token = tokenIn(mail.sent[0].text);

    await providerReportsNewAddress(fixture.users.member.id, newAddress);
    const response = await openLink(session, token);

    expect(response.headers.get("location")).toContain("sender=unverified");
    expect(await hasVerifiedSenderAddress(fixture.users.member.id)).toBe(false);
    expect(await userForVerifiedSender(oldAddress)).toBeUndefined();
    expect(await userForVerifiedSender(newAddress)).toBeUndefined();
  });
});

describe("finding 6: no sending address but the registered one attributes", () => {
  it("does not attribute mail to a member from a verified stored address that is not their registered one", async () => {
    const userId = fixture.users.member.id;
    const stranger = "harlow-not-registered@example.test";
    expect(stranger).not.toBe(fixture.users.member.email);
    const strangerId = randomUUID();
    await getDb().insert(mailInSenderAddresses).values({
      id: strangerId, userId, ...await senderAddressColumns(strangerId, stranger), source: "manual", verifiedAt: new Date(),
    });

    expect(await userForVerifiedSender(stranger)).toBeUndefined();
    expect(await hasVerifiedSenderAddress(userId)).toBe(false);
  });
});

describe("finding 3: the mailer fails", () => {
  /* The attempt and its link are recorded before the mailer is called, so a
     failed send leaves the link outstanding (the limit counts attempts). */
  it("leaves the attempt's link outstanding, and the relay read reports it", async () => {
    await turnMailInOn();
    const session = await fixture.session("member");
    mail.failing = true;

    const response = await send(session);

    expect(response.status).not.toBe(202);
    expect(mail.sent).toEqual([]);
    const reading = (await readRelaySettings(memberActor())).sender;
    expect(reading).toMatchObject({ verified: false, verificationPending: true });
    const [view] = await listSenderAddresses(fixture.users.member.id);
    expect(view.verificationPending).toBe(true);
  });
});

describe("finding 5: APP_URL is missing", () => {
  for (const [label, apply] of [
    ["unset", () => { delete process.env.APP_URL; }],
    ["empty", () => { process.env.APP_URL = ""; }],
  ] as const) {
    it(`answers 503 with a stable code, not 500, when APP_URL is ${label}, and sends nothing`, async () => {
      const session = await fixture.session("member");
      apply();

      const response = await send(session);

      expect(response.status).toBe(503);
      const body = await response.json() as { error: { code: string } };
      expect(body.error.code).toMatch(/^[a-z][a-z0-9_]*$/);
      expect(mail.sent).toEqual([]);
    });
  }
});
