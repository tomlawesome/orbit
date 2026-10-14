import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/db";
import {
  auditLog,
  externalIdentities,
  users,
  imapRecipientAliases,
  mailInMailbox,
  mailInRelays,
  mailInSecrets,
  mailInSenderAddresses,
} from "@/db/schema";
import { resetDocumentConfigForTests } from "@/server/documents/config";
import { resetMetadataKeyCacheForTests } from "@/server/metadata/keys";
import { provisionIdentity } from "@/lib/auth/provision";
import { setMailboxSettings, type MailboxSettingsDependencies, type MailboxSettingsInput } from "@/server/mail-in/mailbox-settings";
import { readRelaySettings } from "@/server/mail-in/relay-settings";
import { listSenderAddresses, requestSenderCheck, seedSenderAddress, setSenderSendDeadlineForTests, verifySenderAddress } from "@/server/mail-in/sender-addresses";
import { cleanupIntegrationEnvironment, createIntegrationFixture, senderAddressColumns, type IntegrationFixture, type IntegrationSession } from "./support/fixtures";
import { callRouteForSession, loadRoute } from "./support/request-event";

/*
 * Issue #1403 D2, the second review of the sender check email,
 * `POST /api/settings/mail-relay/verification`. One group per finding,
 * written from the behaviour the review asked for:
 *
 *   1. The whole send has a deadline of about 15 seconds. A mailer that never
 *      answers ends the request with 503 and a stable code, and does not hold
 *      the member's relay read up. The attempt still counts (release audit,
 *      #1316: the limit counts attempts, not deliveries). (Real timers, with the deadline shortened by
 *      `setSenderSendDeadlineForTests`; faking timers would also stop the
 *      database driver's own.)
 *   2. A mailer that throws is a 503 with a stable code, not 500
 *      `internal_error`; the attempt still counts.
 *   3. A stored address that fails authentication while the key IS available
 *      is damaged, not locked: the press replaces it with the registered
 *      address, unchecked, and sends the check there; the relay read shows
 *      the registered address (release audit, #1316).
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
  setSenderSendDeadlineForTests(null);
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
async function send(existing?: IntegrationSession) {
  const session: IntegrationSession = existing ?? await fixture.session("member");
  return callRouteForSession((await loadRoute("settings/mail-relay/verification")).POST, session, {
    url: VERIFICATION_URL,
    method: "POST",
    body: null,
  });
}

async function codeOf(response: Response): Promise<string> {
  return ((await response.json()) as { error: { code: string } }).error.code;
}

/** The error envelope's code and message (`{ error: { code, message } }`). */
async function envelopeOf(response: Response): Promise<{ code: string; message: string }> {
  return ((await response.json()) as { error: { code: string; message: string } }).error;
}

/*
 * ADR-0034 decision 4 (#1410 note 38589): the engine words every refusal once,
 * in `error.message`; the browser shows it and never rewrites it. These are
 * the words, in one voice: "not sent — <why>. <what to do>".
 */
const WORDS = {
  alreadyChecked: "already checked — nothing to send",
  noAddress: "not sent — this account has no registered email address to check",
  noMail: "not sent — Orbit has no outbound mail set up yet. ask your administrator",
  locked: "not sent — Orbit cannot read your address right now. try again later",
  tooSoon: "not sent — too soon. try again in a few minutes",
  mailerTimeout: "not sent — the mail server did not answer in time. try again later",
  mailerRefused: "not sent — the mail server refused the message. try again later",
  unreadable: "not sent — Orbit cannot read the address it holds for you. ask your administrator",
  noAppUrl: "not sent — Orbit does not know its own web address. ask your administrator",
} as const;

/** Freezes the clock at `T0 + offsetSeconds`. Only `Date` is faked. */
function at(offsetSeconds: number) {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(T0 + offsetSeconds * SECOND);
}

/** Five accepted presses, 61 seconds apart, the last at 244 s: the daily limit is spent. */
async function usedFive() {
  for (let index = 0; index < 5; index += 1) {
    at(index * 61);
    expect((await send()).status).toBe(202);
  }
  expect(mail.sent).toHaveLength(5);
}

/** The failed attempt counted once for this member, and nothing was sent. */
async function expectCountedNotSent() {
  const rows = await rowsOf(fixture.users.member.id);
  expect(rows.flatMap((row) => row.checkSentAt)).toHaveLength(1);
  expect(mail.sent).toEqual([]);
}

describe("finding 1: a mailer that never answers", () => {
  it("ends the request at the send deadline (shortened to 300 ms here) with a stable 503, still counts, and does not hold up the relay read", async () => {
    await turnMailInOn();
    mail.mode = "stall";
    setSenderSendDeadlineForTests(300);
    const started = Date.now();

    const sending = send().then((response) => ({ response, at: Date.now() - started }));
    await new Promise((resolve) => setTimeout(resolve, 50));
    const reading = readRelaySettings(memberActor()).then(() => Date.now() - started);
    const guard = new Promise<"hung">((resolve) => setTimeout(() => resolve("hung"), 5 * SECOND));

    const outcome = await Promise.race([Promise.all([sending, reading]), guard]);

    expect(outcome).not.toBe("hung");
    const [sent, readAt] = outcome as [{ response: Response; at: number }, number];
    expect(sent.at).toBeLessThan(3 * SECOND);
    expect(readAt).toBeLessThan(3 * SECOND);
    expect(sent.response.status).toBe(503);
    const { code, message } = await envelopeOf(sent.response);
    expect(code).toMatch(CODE_SHAPE);
    expect(code).not.toBe("internal_error");
    expect(code).not.toBe("metadata_locked");
    expect(message).toBe(WORDS.mailerTimeout);
    await expectCountedNotSent();

    /* The stalled attempt counted: an immediate next press is too soon. */
    for (const release of mail.stalled.splice(0)) release();
    mail.mode = "ok";
    const next = await send();
    expect(next.status).toBe(429);
    expect(await codeOf(next)).toBe("sender_check_too_soon");
    expect(mail.sent).toEqual([]);
  }, 15 * SECOND);
});

describe("finding 2: the mailer refuses the message", () => {
  it("answers 503 with a stable code, not 500 internal_error, and still counts", async () => {
    await turnMailInOn();
    mail.mode = "throw";

    const response = await send();

    expect(response.status).toBe(503);
    const { code, message } = await envelopeOf(response);
    expect(code).toMatch(CODE_SHAPE);
    expect(code).not.toBe("internal_error");
    expect(message).toBe(WORDS.mailerRefused);
    await expectCountedNotSent();

    /* Counted: an immediate second press is "too soon". */
    mail.mode = "ok";
    expect((await send()).status).toBe(429);
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

  it("replaces the damaged row and sends the check to the registered address, not the key-unavailable 503", async () => {
    const rowId = await damagedRow();

    const response = await send();

    expect(response.status).toBe(202);
    expect(mail.sent.map((message) => message.to)).toEqual([fixture.users.member.email]);
    expect((await rowsOf(fixture.users.member.id)).map((row) => row.id)).not.toContain(rowId);
  });

  it("lets the relay read show the registered address, unchecked, in place of the damaged row", async () => {
    await turnMailInOn();
    const rowId = await damagedRow();

    const reading = await readRelaySettings(memberActor());

    expect(reading.sender?.address).toBe(fixture.users.member.email);
    expect(reading.sender?.verified).toBe(false);
    expect((await rowsOf(fixture.users.member.id)).map((row) => row.id)).not.toContain(rowId);
    const [view] = await listSenderAddresses(fixture.users.member.id);
    expect(view.metadataStatus?.address).toBeUndefined();
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
    expect(await codeOf(sixth)).toBe("sender_check_daily_limit");
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
    expect(await codeOf(later)).toBe("sender_check_daily_limit");
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
    expect(await codeOf(later)).toBe("sender_check_daily_limit");
    expect(mail.sent).toHaveLength(5);
  });
});

describe("ADR-0034 decision 4: the engine words every refusal of the check", () => {
  it("409 sender_already_verified", async () => {
    await seedSenderAddress(fixture.users.member.id);
    await getDb().update(mailInSenderAddresses).set({ verifiedAt: new Date() }).where(eq(mailInSenderAddresses.userId, fixture.users.member.id));

    const response = await send();

    expect(response.status).toBe(409);
    expect(await envelopeOf(response)).toEqual({ code: "sender_already_verified", message: WORDS.alreadyChecked });
  });

  it("409 sender_address_unavailable", async () => {
    await getDb().update(users).set({ emailEnc: null }).where(eq(users.id, fixture.users.member.id));

    const response = await send();

    expect(response.status).toBe(409);
    expect(await envelopeOf(response)).toEqual({ code: "sender_address_unavailable", message: WORDS.noAddress });
  });

  it("503 smtp_not_configured", async () => {
    delete process.env.SMTP_HOST;

    const response = await send();

    expect(response.status).toBe(503);
    expect(await envelopeOf(response)).toEqual({ code: "smtp_not_configured", message: WORDS.noMail });
  });

  it("503 app_url_not_configured", async () => {
    const session = await fixture.session("member");
    delete process.env.APP_URL;

    const response = await send(session);

    expect(response.status).toBe(503);
    expect(await envelopeOf(response)).toEqual({ code: "app_url_not_configured", message: WORDS.noAppUrl });
  });

  it("503 metadata_locked, when the key is gone after the member is signed in", async () => {
    await seedSenderAddress(fixture.users.member.id);
    const session = await fixture.session("member");
    const original = process.env.DOCUMENT_KEK;
    delete process.env.DOCUMENT_KEK;
    resetDocumentConfigForTests();
    resetMetadataKeyCacheForTests();
    try {
      const response = await callRouteForSession((await loadRoute("settings/mail-relay/verification")).POST, session, {
        url: VERIFICATION_URL, method: "POST", body: null,
      });

      expect(response.status).toBe(503);
      expect(await envelopeOf(response)).toEqual({ code: "metadata_locked", message: WORDS.locked });
    } finally {
      if (original === undefined) delete process.env.DOCUMENT_KEK;
      else process.env.DOCUMENT_KEK = original;
      resetDocumentConfigForTests();
      resetMetadataKeyCacheForTests();
    }
  });

  it("429 sender_check_too_soon", async () => {
    at(0);
    expect((await send()).status).toBe(202);

    at(10);
    const response = await send();

    expect(response.status).toBe(429);
    expect(await envelopeOf(response)).toEqual({ code: "sender_check_too_soon", message: WORDS.tooSoon });
  });

  it("429 sender_check_daily_limit, in words that say tomorrow, with Retry-After for the rest of the day", async () => {
    await usedFive();

    at(5 * 61);
    const response = await send();

    expect(response.status).toBe(429);
    expect(await envelopeOf(response)).toEqual({
      code: "sender_check_daily_limit",
      message: "not sent — daily limit reached. try again tomorrow.",
    });
    expect(response.headers.get("retry-after")).toBe(String(24 * 3600 - 5 * 61));
    expect(mail.sent).toHaveLength(5);
  });

  it("guard: the first press is accepted, and a press 10 seconds later is still the short wait (too soon, a few minutes)", async () => {
    at(0);
    expect((await send()).status).toBe(202);

    at(10);
    const response = await send();

    expect(response.status).toBe(429);
    expect(await envelopeOf(response)).toEqual({ code: "sender_check_too_soon", message: WORDS.tooSoon });
  });

  it("guard: after the daily limit, a press more than a day after the first send is accepted again", async () => {
    await usedFive();
    at(5 * 61);
    expect((await send()).status).toBe(429);

    at(24 * 3600 + 1);
    expect((await send()).status).toBe(202);
    expect(mail.sent).toHaveLength(6);
  });
});

/*
 * Release-audit M-R8 (#1316): an attempt counts the moment it is made, not
 * only when the mailer accepts. A failing or hanging mailer must neither let
 * the next press send again nor hold the member's lock (and a pool connection)
 * across the mailer call, which queued every other press and the relay read.
 */
describe("M-R8: a send attempt counts when it starts, and the mailer call holds no lock", () => {
  type Outcome = { ok: true } | { ok: false; code: string };
  const outcomeOf = (call: Promise<unknown>): Promise<Outcome> =>
    call.then(
      () => ({ ok: true as const }),
      (error: { code?: string }) => ({ ok: false as const, code: String(error?.code) }),
    );
  const within = <T,>(promise: Promise<T>, milliseconds: number) =>
    Promise.race([promise, new Promise<"hung">((resolve) => setTimeout(() => resolve("hung"), milliseconds))]);
  async function untilMailerHasTheMessage() {
    const deadline = Date.now() + 5 * SECOND;
    while (mail.stalled.length < 1) {
      if (Date.now() > deadline) throw new Error("the first press never reached the mailer");
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  /** Lets every stalled and later press finish, then waits for the given calls. */
  async function releaseAndSettle(...calls: Array<Promise<unknown>>) {
    mail.mode = "ok";
    for (const release of mail.stalled.splice(0)) release();
    await Promise.allSettled(calls);
  }

  it("a mailer that throws still counts: the press refuses with the mailer code, and a second one second later is sender_check_too_soon", async () => {
    mail.mode = "throw";

    at(0);
    const first = await outcomeOf(requestSenderCheck(fixture.users.member.id));
    expect(first.ok).toBe(false);
    expect((first as { code: string }).code).toMatch(/^sender_mailer_/);

    at(1);
    const second = await outcomeOf(requestSenderCheck(fixture.users.member.id));

    expect(second).toEqual({ ok: false, code: "sender_check_too_soon" });
    expect(mail.sent).toEqual([]);
  });

  /* The row is written before the mailer is called, so a refusal must not
     leave a token nobody was sent (release audit, #1316, M-R8). */
  it("a mailer that throws leaves no pending link: the route answers 503 sender_mailer_refused and the relay read and the list report none", async () => {
    await turnMailInOn();
    mail.mode = "throw";

    at(0);
    const response = await send();

    expect(response.status).toBe(503);
    expect((await envelopeOf(response)).code).toBe("sender_mailer_refused");
    const reading = (await readRelaySettings(memberActor())).sender;
    expect(reading).toMatchObject({ verificationPending: false, expiresAt: null });
    const views = await listSenderAddresses(fixture.users.member.id);
    expect(views.filter((view) => view.verificationPending)).toEqual([]);
    expect(views.map((view) => view.expiresAt)).toEqual(views.map(() => null));
  });

  it("a mailer that throws on a later press leaves the earlier delivered link working", async () => {
    mail.mode = "ok";
    at(0);
    expect((await send()).status).toBe(202);
    expect(mail.sent).toHaveLength(1);
    const match = /token=([A-Za-z0-9_-]+)/.exec(mail.sent[0].text);
    if (!match) throw new Error("the check email carried no link token");
    const firstToken = match[1];

    mail.mode = "throw";
    at(61);
    expect((await send()).status).toBe(503);

    const verified = await verifySenderAddress(fixture.users.member.id, firstToken);
    expect(verified.verified).toBe(true);
    const rows = await rowsOf(fixture.users.member.id);
    expect(rows.map((row) => row.verifiedAt !== null)).toEqual([true]);
  });

  it("guard: the failed attempt still counts, so a press a second later is sender_check_too_soon", async () => {
    await turnMailInOn();
    mail.mode = "throw";
    at(0);
    expect((await send()).status).toBe(503);

    at(1);
    const again = await send();

    expect(again.status).toBe(429);
    expect(await codeOf(again)).toBe("sender_check_too_soon");
  });

  describe("a busy member lock (guards: the lock is tried, never waited for)", () => {
    const lockKey = () => `orbit:mail-relay-sender:${fixture.users.member.id}`;
    /** Holds the member's advisory lock in an open transaction until the returned function is called. */
    async function holdLock() {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      let acquired!: () => void;
      const locked = new Promise<void>((resolve) => { acquired = resolve; });
      const holder = getDb().transaction(async (tx) => {
        await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${lockKey()}, 0))`);
        acquired();
        await gate;
      });
      holder.catch(() => undefined);
      await locked;
      return async () => { release(); await holder; };
    }

    it("the route press answers 429 sender_check_too_soon with Retry-After 5, sends nothing and records no attempt", async () => {
      await seedSenderAddress(fixture.users.member.id);
      const before = (await rowsOf(fixture.users.member.id)).flatMap((row) => row.checkSentAt);
      const release = await holdLock();
      try {
        at(0);
        const response = await send();

        expect(response.status).toBe(429);
        expect(await codeOf(response)).toBe("sender_check_too_soon");
        expect(response.headers.get("retry-after")).toBe("5");
        expect(mail.sent).toEqual([]);
        const after = (await rowsOf(fixture.users.member.id)).flatMap((row) => row.checkSentAt);
        expect(after).toEqual(before);
      } finally {
        await release();
      }
    });

    it("the relay read resolves within 2 s and seeds no row; once the lock is released a read seeds one", async () => {
      await turnMailInOn();
      expect(await rowsOf(fixture.users.member.id)).toEqual([]);
      const release = await holdLock();
      let released = false;
      try {
        const result = await within(readRelaySettings(memberActor()).then(() => "read" as const), 2 * SECOND);

        expect(result).toBe("read");
        expect(await rowsOf(fixture.users.member.id)).toEqual([]);
        await release();
        released = true;
        await readRelaySettings(memberActor());
        expect(await rowsOf(fixture.users.member.id)).toHaveLength(1);
      } finally {
        if (!released) await release();
      }
    }, 30 * SECOND);
  });

  it("a second press while the first is stuck in the mailer is refused sender_check_too_soon within 2 s, not queued behind it", async () => {
    mail.mode = "stall";
    const first = outcomeOf(requestSenderCheck(fixture.users.member.id));
    let second: Promise<Outcome> | undefined;
    try {
      await untilMailerHasTheMessage();

      second = outcomeOf(requestSenderCheck(fixture.users.member.id));
      const result = await within(second, 2 * SECOND);

      expect(result).toEqual({ ok: false, code: "sender_check_too_soon" });
    } finally {
      await releaseAndSettle(first, ...(second ? [second] : []));
    }
  }, 30 * SECOND);

  it("the relay settings read for that member resolves within 2 s while the mailer is stuck", async () => {
    await turnMailInOn();
    mail.mode = "stall";
    const first = outcomeOf(requestSenderCheck(fixture.users.member.id));
    let reading: Promise<unknown> | undefined;
    try {
      await untilMailerHasTheMessage();

      reading = readRelaySettings(memberActor());
      const result = await within(reading.then(() => "read" as const), 2 * SECOND);

      expect(result).toBe("read");
    } finally {
      await releaseAndSettle(first, ...(reading ? [reading] : []));
    }
  }, 30 * SECOND);
});
