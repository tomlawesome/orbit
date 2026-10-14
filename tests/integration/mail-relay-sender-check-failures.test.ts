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
import { listSenderAddresses, seedSenderAddress } from "@/server/mail-in/sender-addresses";
import { cleanupIntegrationEnvironment, createIntegrationFixture, senderAddressColumns, type IntegrationFixture, type IntegrationSession } from "./support/fixtures";
import { callRouteForSession, loadRoute } from "./support/request-event";

/*
 * Issue #1403 D2, the second review of the sender check email,
 * `POST /api/settings/mail-relay/verification`. One group per finding,
 * written from the behaviour the review asked for:
 *
 *   1. The whole send has a deadline of about 15 seconds. A mailer that never
 *      answers ends the request with 503 and a stable code, counts nothing,
 *      leaves no pending link, and does not hold the member's relay read up
 *      beyond that deadline. (Real timers: the deadline is not configurable,
 *      and faking timers would also stop the database driver's own.)
 *   2. A mailer that throws is a 503 with a stable code, not 500
 *      `internal_error`; nothing is counted and no link is left pending.
 *   3. A stored address that cannot be read while the key IS available is a
 *      distinct refusal (409 `sender_address_unreadable`), not the "key
 *      unavailable" 503 `metadata_locked`; the relay read reports the state.
 *   4. The send times belong to the member, not the address: changing the
 *      registered address, even to one another member already claims, does
 *      not hand back the five sends.
 *
 * Mail is captured at the transport library; nothing opens a socket.
 */
const mail = vi.hoisted(() => ({
  sent: [] as Array<{ from: string; to: string; subject: string; text: string }>,
  mode: "ok" as "ok" | "throw" | "stall",
  stalled: [] as Array<() => void>,
}));

vi.mock("nodemailer", () => {
  const createTransport = () => ({
    async sendMail(message: { from: string; to: string; subject: string; text: string }) {
      if (mail.mode === "throw") throw new Error("the mail server refused the message");
      if (mail.mode === "stall") {
        await new Promise<void>((resolve) => { mail.stalled.push(resolve); });
        return { messageId: "never-recorded" };
      }
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
  password: "fake-sender-check-failures-password",
};
const providerReady: MailboxSettingsDependencies = { verifyImap: async () => "ready" };

const VERIFICATION_URL = "http://127.0.0.1:3000/api/settings/mail-relay/verification";
const SECOND = 1000;
const T0 = Date.UTC(2031, 2, 4, 9, 0, 0);
const CODE_SHAPE = /^[a-z][a-z0-9_]*$/;

let fixture: IntegrationFixture;
const savedEnvironment: Record<string, string | undefined> = {};

beforeEach(async () => {
  mail.sent.length = 0;
  mail.stalled.length = 0;
  mail.mode = "ok";
  for (const name of ["SMTP_PORT", "SMTP_FROM", "SMTP_HOST", "SMTP_USER", "SMTP_PASSWORD", "APP_URL"]) savedEnvironment[name] = process.env[name];
  process.env.SMTP_HOST = "smtp.example.test"; process.env.SMTP_PORT = "587"; process.env.SMTP_USER = "orbit-test"; process.env.SMTP_PASSWORD = "fake-smtp-password";
  process.env.SMTP_FROM = "Orbit <orbit@example.test>";
  fixture = await createIntegrationFixture("sender-check-failures");
});

afterEach(async () => {
  vi.useRealTimers();
  for (const release of mail.stalled.splice(0)) release();
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
const rowsOf = (userId: string) => getDb().select().from(mailInSenderAddresses).where(eq(mailInSenderAddresses.userId, userId));

/** A session made at the current (possibly faked) time, so it never reads as expired. */
async function send() {
  const session: IntegrationSession = await fixture.session("member");
  return callRouteForSession((await loadRoute("settings/mail-relay/verification")).POST, session, {
    url: VERIFICATION_URL,
    method: "POST",
    body: null,
  });
}

async function codeOf(response: Response): Promise<string> {
  return ((await response.json()) as { error: { code: string } }).error.code;
}

/** Freezes the clock at `T0 + offsetSeconds`. Only `Date` is faked. */
function at(offsetSeconds: number) {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(T0 + offsetSeconds * SECOND);
}

/** Nothing counted and nothing pending for this member. */
async function expectNothingLeft() {
  const rows = await rowsOf(fixture.users.member.id);
  for (const row of rows) {
    expect(row.checkSentAt).toEqual([]);
    expect(row.verificationTokenDigest).toBeNull();
  }
  for (const view of await listSenderAddresses(fixture.users.member.id)) expect(view.verificationPending).toBe(false);
  expect(mail.sent).toEqual([]);
}

describe("finding 1: a mailer that never answers", () => {
  it("ends the request within about 15 s with a stable 503, counts nothing, and does not hold up the relay read", async () => {
    await turnMailInOn();
    mail.mode = "stall";
    const started = Date.now();

    const sending = send().then((response) => ({ response, at: Date.now() - started }));
    await new Promise((resolve) => setTimeout(resolve, 500));
    const reading = readRelaySettings(memberActor()).then(() => Date.now() - started);
    const guard = new Promise<"hung">((resolve) => setTimeout(() => resolve("hung"), 22 * SECOND));

    const outcome = await Promise.race([Promise.all([sending, reading]), guard]);

    expect(outcome).not.toBe("hung");
    const [sent, readAt] = outcome as [{ response: Response; at: number }, number];
    expect(sent.at).toBeLessThan(20 * SECOND);
    expect(readAt).toBeLessThan(20 * SECOND);
    expect(sent.response.status).toBe(503);
    const code = await codeOf(sent.response);
    expect(code).toMatch(CODE_SHAPE);
    expect(code).not.toBe("internal_error");
    expect(code).not.toBe("metadata_locked");
    await expectNothingLeft();

    /* The stalled attempt was not counted: the next press goes out at once. */
    for (const release of mail.stalled.splice(0)) release();
    mail.mode = "ok";
    expect((await send()).status).toBe(202);
    expect(mail.sent).toHaveLength(1);
  }, 45 * SECOND);
});

describe("finding 2: the mailer refuses the message", () => {
  it("answers 503 with a stable code, not 500 internal_error, and counts nothing", async () => {
    await turnMailInOn();
    mail.mode = "throw";

    const response = await send();

    expect(response.status).toBe(503);
    const code = await codeOf(response);
    expect(code).toMatch(CODE_SHAPE);
    expect(code).not.toBe("internal_error");
    await expectNothingLeft();

    /* Not counted: an immediate second press is not "too soon". */
    mail.mode = "ok";
    expect((await send()).status).toBe(202);
  });
});

describe("finding 3: a damaged stored address while the key is available", () => {
  async function damagedRow() {
    const userId = fixture.users.member.id;
    await seedSenderAddress(userId);
    const [row] = await rowsOf(userId);
    if (!row.addressEnc) throw new Error("the seeded row holds no encrypted address to damage");
    const damaged = row.addressEnc.slice(0, -2) + (row.addressEnc.endsWith("A") ? "BB" : "AA");
    await getDb().update(mailInSenderAddresses).set({ addressEnc: damaged }).where(eq(mailInSenderAddresses.id, row.id));
    const [view] = await listSenderAddresses(userId);
    expect(view.address).toBeNull();
    expect(view.metadataStatus?.address).toBe("metadata_integrity_failed");
    return row.id;
  }

  it("answers 409 sender_address_unreadable, not the key-unavailable 503, and sends nothing", async () => {
    await damagedRow();

    const response = await send();

    expect(response.status).toBe(409);
    expect(await codeOf(response)).toBe("sender_address_unreadable");
    expect(mail.sent).toEqual([]);
  });

  it("lets the relay read report the state without crashing, and without an address", async () => {
    await turnMailInOn();
    const rowId = await damagedRow();

    const reading = await readRelaySettings(memberActor());

    expect(reading.sender?.address ?? null).toBeNull();
    expect((await rowsOf(fixture.users.member.id)).map((row) => row.id)).toContain(rowId);
    const [view] = await listSenderAddresses(fixture.users.member.id);
    expect(view.metadataStatus?.address).toBe("metadata_integrity_failed");
  });
});

describe("finding 4: send times carry over when the registered address changes", () => {
  const newAddress = "harlow-changed-address@example.test";

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

  async function usedFive() {
    for (let index = 0; index < 5; index += 1) {
      at(index * 61);
      expect((await send()).status).toBe(202);
    }
    expect(mail.sent).toHaveLength(5);
  }

  /** Another member already holds this address, as a row of their own. */
  async function otherMemberClaims(address: string) {
    const id = randomUUID();
    await getDb().insert(mailInSenderAddresses).values({
      id, userId: fixture.users.owner.id, ...await senderAddressColumns(id, address), source: "manual",
    });
    return id;
  }

  it("is still limited (429) after a change to a free address, until the window passes", async () => {
    await usedFive();

    at(5 * 61);
    await providerReportsNewAddress(fixture.users.member.id, newAddress);
    const sixth = await send();

    expect(sixth.status).toBe(429);
    expect(await codeOf(sixth)).toBe("sender_check_too_soon");
    expect(mail.sent).toHaveLength(5);

    at(24 * 3600 + 1);
    expect((await send()).status).toBe(202);
  });

  it("is still limited after a change to an address another member claims, once that claim is gone (send path)", async () => {
    await usedFive();
    const claim = await otherMemberClaims(newAddress);

    at(5 * 61);
    await providerReportsNewAddress(fixture.users.member.id, newAddress);
    expect((await send()).status).not.toBe(202);
    expect(mail.sent).toHaveLength(5);

    await getDb().delete(mailInSenderAddresses).where(eq(mailInSenderAddresses.id, claim));
    at(5 * 61 + 5);
    const later = await send();

    expect(later.status).toBe(429);
    expect(mail.sent).toHaveLength(5);
  });

  it("is still limited after a change to an address another member claims, once that claim is gone (relay read path)", async () => {
    await turnMailInOn();
    await usedFive();
    const claim = await otherMemberClaims(newAddress);

    at(5 * 61);
    await providerReportsNewAddress(fixture.users.member.id, newAddress);
    await readRelaySettings(memberActor());

    await getDb().delete(mailInSenderAddresses).where(eq(mailInSenderAddresses.id, claim));
    at(5 * 61 + 5);
    const later = await send();

    expect(later.status).toBe(429);
    expect(mail.sent).toHaveLength(5);
  });
});
