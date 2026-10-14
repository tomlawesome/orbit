import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/db";
import {
  auditLog,
  imapRecipientAliases,
  mailInMailbox,
  mailInRelays,
  mailInSecrets,
  mailInSenderAddresses,
  users,
} from "@/db/schema";
import { requireInstanceMetadataWriter } from "@/server/metadata/fields";
import { setMailboxSettings, type MailboxSettingsDependencies, type MailboxSettingsInput } from "@/server/mail-in/mailbox-settings";
import { RELAY_LISTENING, RELAY_NOT_USABLE, readRelaySettings } from "@/server/mail-in/relay-settings";
import { hasVerifiedSenderAddress, seedSenderAddress, userForVerifiedSender } from "@/server/mail-in/sender-addresses";
import { cleanupIntegrationEnvironment, createIntegrationFixture, type IntegrationFixture, type IntegrationSession } from "./support/fixtures";
import { callRoute, callRouteForSession, loadRoute } from "./support/request-event";

/*
 * ADR-0017 decision 3, amended by decision 7c: the member's registered address
 * is their only sending address, and exactly one route sends the check email,
 * `POST /api/settings/mail-relay/verification`.
 *
 * Mail is captured at the lowest seam, the transport library itself, so these
 * cases say nothing about which module the route sends through. Nothing opens a
 * socket.
 */
const mail = vi.hoisted(() => ({
  sent: [] as Array<{ from: string; to: string; subject: string; text: string }>,
}));

vi.mock("nodemailer", () => {
  const createTransport = () => ({
    async sendMail(message: { from: string; to: string; subject: string; text: string }) {
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
  password: "fake-sender-check-password",
};
const providerReady: MailboxSettingsDependencies = { verifyImap: async () => "ready" };

const VERIFICATION_URL = "http://127.0.0.1:3000/api/settings/mail-relay/verification";
const VERIFY_URL = "http://127.0.0.1:3000/api/settings/mail-relay/verify";
const DAY_MS = 24 * 3_600_000;

/* Loaded inside the cases, not at module scope: until the route exists, a
   missing module must fail the case that needs it, not the whole file. */
const verificationRoute = async () => (await loadRoute("settings/mail-relay/verification")).POST;
const verifyRoute = async () => (await loadRoute("settings/mail-relay/verify")).GET;

let fixture: IntegrationFixture;
const savedEnvironment: Record<string, string | undefined> = {};

beforeEach(async () => {
  mail.sent.length = 0;
  for (const name of ["SMTP_URL", "SMTP_FROM", "SMTP_HOST", "SMTP_USER", "SMTP_PASSWORD"]) savedEnvironment[name] = process.env[name];
  delete process.env.SMTP_HOST;
  delete process.env.SMTP_USER;
  delete process.env.SMTP_PASSWORD;
  process.env.SMTP_URL = "smtp://orbit-test:fake-smtp-password@smtp.example.test:587";
  process.env.SMTP_FROM = "Orbit <orbit@example.test>";
  fixture = await createIntegrationFixture("sender-check");
});

afterEach(async () => {
  vi.useRealTimers();
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

async function send(session: IntegrationSession, init: { body?: BodyInit; headers?: Record<string, string> } = {}) {
  return callRouteForSession(await verificationRoute(), session, {
    url: VERIFICATION_URL,
    method: "POST",
    headers: init.headers,
    body: init.body ?? null,
  });
}

const rowsOf = (userId: string) => getDb().select().from(mailInSenderAddresses).where(eq(mailInSenderAddresses.userId, userId));

async function markVerified(userId: string) {
  await getDb().update(mailInSenderAddresses).set({ verifiedAt: new Date() }).where(eq(mailInSenderAddresses.userId, userId));
}

/* The check email is limited to one per 60 seconds per member (#1403), so a
   case that asks twice lets the clock pass between the asks. Only `Date` is
   faked, as in mail-relay-verification-limit.test.ts. */
function passMinute() {
  if (!vi.isFakeTimers()) vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(Date.now() + 61_000));
}

function tokenIn(text: string): string {
  const match = /token=([A-Za-z0-9_-]+)/.exec(text);
  if (!match) throw new Error("the check email carried no link token");
  return match[1];
}

/** Opens a link as the member does: signed in, a plain GET. */
async function openLink(session: IntegrationSession, token: string) {
  return callRoute(await verifyRoute(), {
    url: `${VERIFY_URL}?token=${encodeURIComponent(token)}`,
    headers: { cookie: session.headers.cookie },
  });
}

/** Changes the account's registered address the way the account stores it (encrypted, with its index). */
async function changeRegisteredAddress(userId: string, email: string) {
  const cipher = await requireInstanceMetadataWriter();
  await getDb().update(users).set({
    email: null,
    emailEnc: cipher.encryptText("users.email", userId, email),
    emailIndex: cipher.emailIndex(email),
  }).where(eq(users.id, userId));
}

describe("POST /api/settings/mail-relay/verification (decision 7c)", () => {
  it("refuses a request with no session, and sends nothing", async () => {
    const response = await callRoute(await verificationRoute(), { url: VERIFICATION_URL, method: "POST" });
    expect(response.status).toBe(401);
    expect(mail.sent).toEqual([]);
  });

  it("refuses a session without the CSRF token, and sends nothing", async () => {
    const session = await fixture.session("member");
    const { "x-csrf-token": _omitted, ...withoutCsrf } = session.headers;
    const response = await callRoute(await verificationRoute(), { url: VERIFICATION_URL, method: "POST", headers: withoutCsrf });
    expect(response.status).toBe(403);
    expect(mail.sent).toEqual([]);
  });

  it("sends one check email to the registered address and answers 202 with that address and an expiry", async () => {
    const session = await fixture.session("member");
    await seedSenderAddress(fixture.users.member.id);
    const before = Date.now();

    const response = await send(session);

    expect(response.status).toBe(202);
    expect(response.headers.get("cache-control")).toContain("no-store");
    const body = await response.json() as { address: string; expiresAt: string };
    expect(Object.keys(body).sort()).toEqual(["address", "expiresAt"]);
    expect(body.address).toBe(fixture.users.member.email);
    const expires = Date.parse(body.expiresAt);
    expect(expires).toBeGreaterThan(before);
    expect(expires).toBeLessThanOrEqual(Date.now() + DAY_MS);

    expect(mail.sent).toHaveLength(1);
    expect(mail.sent[0].to).toBe(fixture.users.member.email);
    expect(mail.sent[0].from).toBe("Orbit <orbit@example.test>");
    expect(mail.sent[0].text).toContain("/api/settings/mail-relay/verify?token=");
    expect(await hasVerifiedSenderAddress(fixture.users.member.id)).toBe(false);
  });

  it("seeds the registered address first when the member has no row yet", async () => {
    const session = await fixture.session("member");
    expect(await rowsOf(fixture.users.member.id)).toEqual([]);

    const response = await send(session);

    expect(response.status).toBe(202);
    expect(await rowsOf(fixture.users.member.id)).toHaveLength(1);
    expect(mail.sent.map((message) => message.to)).toEqual([fixture.users.member.email]);
  });

  it("names the other member's address nowhere: each member's check goes to their own registered address", async () => {
    const first = await fixture.session("member");
    const second = await fixture.session("owner");

    expect((await send(first)).status).toBe(202);
    expect((await send(second)).status).toBe(202);

    expect(mail.sent.map((message) => message.to)).toEqual([fixture.users.member.email, fixture.users.owner.email]);
  });

  it("ignores a body that names another address: the check still goes to the registered address only", async () => {
    const session = await fixture.session("member");
    const elsewhere = "harlow-elsewhere@example.test";

    const response = await send(session, {
      body: JSON.stringify({ address: elsewhere, to: elsewhere, email: elsewhere, userId: fixture.users.owner.id }),
      headers: { "content-type": "application/json" },
    });

    expect(response.status).toBe(202);
    expect((await response.json() as { address: string }).address).toBe(fixture.users.member.email);
    expect(mail.sent.map((message) => message.to)).toEqual([fixture.users.member.email]);
    expect(await rowsOf(fixture.users.owner.id)).toEqual([]);
    expect(await userForVerifiedSender(elsewhere)).toBeUndefined();
    expect(await rowsOf(fixture.users.member.id)).toHaveLength(1);
  });

  it("does not read the body at all: an unparseable one changes nothing", async () => {
    const session = await fixture.session("member");

    const response = await send(session, { body: "{ this is not json", headers: { "content-type": "application/json" } });

    expect(response.status).toBe(202);
    expect(mail.sent.map((message) => message.to)).toEqual([fixture.users.member.email]);
  });

  it("answers 409 sender_already_verified once the address is checked, and sends nothing more", async () => {
    const session = await fixture.session("member");
    await seedSenderAddress(fixture.users.member.id);
    await markVerified(fixture.users.member.id);

    const response = await send(session);

    expect(response.status).toBe(409);
    expect((await response.json() as { error: { code: string } }).error.code).toBe("sender_already_verified");
    expect(mail.sent).toEqual([]);
  });

  it("leaves one row for the member however often the check is asked for", async () => {
    const session = await fixture.session("member");

    for (let attempt = 0; attempt < 3; attempt += 1) {
      passMinute();
      expect((await send(session)).status).toBe(202);
    }

    expect(await rowsOf(fixture.users.member.id)).toHaveLength(1);
    expect(mail.sent).toHaveLength(3);
  });

  it("makes the link from the newest email the only one that works", async () => {
    const session = await fixture.session("member");
    expect((await send(session)).status).toBe(202);
    passMinute();
    expect((await send(session)).status).toBe(202);
    const [older, newer] = mail.sent.map((message) => tokenIn(message.text));

    const stale = await openLink(session, older);
    expect(stale.headers.get("location")).toContain("sender=unverified");
    expect(await hasVerifiedSenderAddress(fixture.users.member.id)).toBe(false);

    const fresh = await openLink(session, newer);
    expect(fresh.headers.get("location")).toContain("sender=verified");
    expect(await hasVerifiedSenderAddress(fixture.users.member.id)).toBe(true);
  });

  it("verifies through the emailed link, only for the member who is signed in, and then refuses a second send", async () => {
    const member = await fixture.session("member");
    const owner = await fixture.session("owner");
    expect((await send(member)).status).toBe(202);
    const token = tokenIn(mail.sent[0].text);

    const wrongMember = await openLink(owner, token);
    expect(wrongMember.status).toBe(303);
    expect(wrongMember.headers.get("location")).toContain("sender=unverified");
    expect(await hasVerifiedSenderAddress(fixture.users.member.id)).toBe(false);
    expect(await userForVerifiedSender(fixture.users.member.email)).toBeUndefined();

    const rightMember = await openLink(member, token);
    expect(rightMember.status).toBe(303);
    expect(rightMember.headers.get("location")).toContain("sender=verified");
    expect(await hasVerifiedSenderAddress(fixture.users.member.id)).toBe(true);

    const again = await send(member);
    expect(again.status).toBe(409);
    expect(mail.sent).toHaveLength(1);
  });

  it("starts verification over when the registered address changes", async () => {
    const session = await fixture.session("member");
    const oldAddress = fixture.users.member.email;
    const newAddress = "harlow-new-address@example.test";
    expect((await send(session)).status).toBe(202);
    await openLink(session, tokenIn(mail.sent[0].text));
    expect(await userForVerifiedSender(oldAddress)).toBe(fixture.users.member.id);
    mail.sent.length = 0;

    await changeRegisteredAddress(fixture.users.member.id, newAddress);
    passMinute();
    const response = await send(session);

    expect(response.status).toBe(202);
    expect((await response.json() as { address: string }).address).toBe(newAddress);
    expect(mail.sent.map((message) => message.to)).toEqual([newAddress]);
    expect(await rowsOf(fixture.users.member.id)).toHaveLength(1);
    expect(await hasVerifiedSenderAddress(fixture.users.member.id)).toBe(false);
    expect(await userForVerifiedSender(oldAddress)).toBeUndefined();
    expect(await userForVerifiedSender(newAddress)).toBeUndefined();
  });
});

describe("what a verified registered address attributes (unchanged by 7c)", () => {
  it("attributes to its member once checked, and to nobody before, nor for any other address", async () => {
    const address = fixture.users.member.email;
    await seedSenderAddress(fixture.users.member.id);
    expect(await userForVerifiedSender(address)).toBeUndefined();

    await markVerified(fixture.users.member.id);

    expect(await userForVerifiedSender(address)).toBe(fixture.users.member.id);
    expect(await userForVerifiedSender(address.toUpperCase())).toBe(fixture.users.member.id);
    expect(await userForVerifiedSender("harlow-someone-else@example.test")).toBeUndefined();
    expect(await userForVerifiedSender(`x${address}`)).toBeUndefined();
  });

  it("attributes nothing for a disabled account", async () => {
    await seedSenderAddress(fixture.users.disabled.id);
    await markVerified(fixture.users.disabled.id);
    expect(await userForVerifiedSender(fixture.users.disabled.email)).toBe(fixture.users.disabled.id);

    await fixture.disableUser("disabled");

    expect(await userForVerifiedSender(fixture.users.disabled.email)).toBeUndefined();
  });
});

describe("the relay settings read reports the one row's state (decision 7c)", () => {
  it("lists exactly one row, the registered address, and follows it from not-checked to link-sent to checked", async () => {
    const { listSenderAddresses } = await import("@/server/mail-in/sender-addresses");
    const session = await fixture.session("member");
    await seedSenderAddress(fixture.users.member.id);

    const unchecked = await listSenderAddresses(fixture.users.member.id);
    expect(unchecked).toHaveLength(1);
    expect(unchecked[0]).toMatchObject({ address: fixture.users.member.email, verified: false, verificationPending: false });

    expect((await send(session)).status).toBe(202);
    const sent = await listSenderAddresses(fixture.users.member.id);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ verified: false, verificationPending: true });

    await openLink(session, tokenIn(mail.sent[0].text));
    const checked = await listSenderAddresses(fixture.users.member.id);
    expect(checked).toHaveLength(1);
    expect(checked[0]).toMatchObject({ verified: true, verificationPending: false });
  });

  it("reports the relay unusable until the registered address is checked, then listening", async () => {
    await setMailboxSettings(fixture.users.admin.id, null, settings, providerReady);
    const session = await fixture.session("member");
    const member = { id: fixture.users.member.id, isInstanceAdmin: false };

    const before = await readRelaySettings(member);
    expect(before.listening).toBe(RELAY_NOT_USABLE);
    expect(await rowsOf(fixture.users.member.id)).toHaveLength(1);

    expect((await send(session)).status).toBe(202);
    await openLink(session, tokenIn(mail.sent[0].text));

    expect((await readRelaySettings(member)).listening).toBe(RELAY_LISTENING);
    expect(await rowsOf(fixture.users.member.id)).toHaveLength(1);
  });
});
