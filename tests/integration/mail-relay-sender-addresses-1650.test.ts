import { and, eq, isNotNull } from "drizzle-orm";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/db";
import {
  auditLog,
  imapIngestionMessages,
  imapRecipientAliases,
  mailInMailbox,
  mailInRelays,
  mailInSecrets,
  mailInSenderAddresses,
  mailInUnattributedReplies,
} from "@/db/schema";
import { readRelaySettings } from "@/server/mail-in/relay-settings";
import {
  listSenderAddresses,
  seedSenderAddress,
  userForVerifiedSender,
  verifiedSenderMatch,
  verifySenderAddress,
} from "@/server/mail-in/sender-addresses";
import { getImapIngestionConfig } from "@/server/mail-in/mailbox-config";
import { setMailboxSettings, type MailboxSettingsDependencies, type MailboxSettingsInput } from "@/server/mail-in/mailbox-settings";
import { reconcileImapRecipientAliases, runImapIngestionCycle, setImapClientFactoryForTests } from "@/server/mail-in/imap-ingestion";
import { cleanupIntegrationEnvironment, createIntegrationFixture, type IntegrationFixture, type IntegrationSession } from "./support/fixtures";
import { callRoute, callRouteForSession, loadRoute } from "./support/request-event";
import { fakeImapMailbox, fixtureHeaders, verifiedSenderFor } from "./support/mail-in";
import { fromOfHeaders, signedSource } from "./support/dkim-fixture";

vi.mock("node:dns/promises", async () => (await import("./support/dkim-fixture")).fixtureDnsModule());

/*
 * #1650, from its specification and the design note (54553) alone: a member
 * may hold up to five sending addresses, the sign-in address included.
 *
 *  - POST   /api/settings/mail-relay/senders        { address }
 *  - DELETE /api/settings/mail-relay/senders/:id
 *  - POST   /api/settings/mail-relay/verification   optional { id }
 *
 * Verification is the exclusive act (first come); an unverified row holds
 * nothing. Not covered here, by instruction: the 30-day removal of unchecked
 * rows (an owner question is open) and the screen.
 *
 * Mail is captured at the transport library, as in mail-relay-verification.
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
  pollSeconds: 300,
  password: "fake-sender-addresses-password",
};
const providerReady: MailboxSettingsDependencies = { verifyImap: async () => "ready" };

const ROOT = "http://127.0.0.1:3000/api/settings/mail-relay";
const SENDERS_URL = `${ROOT}/senders`;
const VERIFICATION_URL = `${ROOT}/verification`;
const VERIFY_URL = `${ROOT}/verify`;

const sendersRoute = async () => loadRoute("settings/mail-relay/senders");
const senderRoute = async () => loadRoute("settings/mail-relay/senders/[id]");
const verificationRoute = async () => (await loadRoute("settings/mail-relay/verification")).POST;
const verifyRoute = async () => (await loadRoute("settings/mail-relay/verify")).GET;

const SECOND = "harlow-second-box@example.test";
const THIRD = "harlow-third-box@example.test";
const UNKNOWN_ID = "00000000-0000-4000-8000-000000000000";

let fixture: IntegrationFixture;
let deleted: string[];
let replies: Array<{ to: string; subject: string; text: string }>;
const savedEnvironment: Record<string, string | undefined> = {};

beforeEach(async () => {
  mail.sent.length = 0;
  deleted = [];
  replies = [];
  for (const name of ["SMTP_PORT", "SMTP_FROM", "SMTP_HOST", "SMTP_USER", "SMTP_PASSWORD"]) savedEnvironment[name] = process.env[name];
  process.env.SMTP_HOST = "smtp.example.test"; process.env.SMTP_PORT = "587"; process.env.SMTP_USER = "orbit-test"; process.env.SMTP_PASSWORD = "fake-smtp-password";
  process.env.SMTP_FROM = "Orbit <orbit@example.test>";
  fixture = await createIntegrationFixture("sender-addresses-1650");
});

afterEach(async () => {
  vi.useRealTimers();
  setImapClientFactoryForTests(undefined);
  for (const [name, value] of Object.entries(savedEnvironment)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  const db = getDb();
  await db.delete(imapIngestionMessages);
  await db.delete(imapRecipientAliases);
  await db.delete(mailInSenderAddresses);
  await db.delete(mailInUnattributedReplies);
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

function jsonInit(body: unknown) {
  return { body: JSON.stringify(body), headers: { "content-type": "application/json" } };
}

async function addAddress(session: IntegrationSession, address: unknown) {
  return callRouteForSession((await sendersRoute()).POST, session, { url: SENDERS_URL, method: "POST", ...jsonInit({ address }) });
}

async function removeRow(session: IntegrationSession, id: string) {
  return callRouteForSession((await senderRoute()).DELETE, session, { url: `${SENDERS_URL}/${id}`, method: "DELETE", params: { id } });
}

async function sendCheck(session: IntegrationSession, body?: unknown) {
  return callRouteForSession(await verificationRoute(), session, {
    url: VERIFICATION_URL,
    method: "POST",
    ...(body === undefined ? { body: null } : jsonInit(body)),
  });
}

async function openLink(session: IntegrationSession, token: string) {
  return callRoute(await verifyRoute(), { url: `${VERIFY_URL}?token=${encodeURIComponent(token)}`, headers: { cookie: session.headers.cookie } });
}

const errorOf = async (response: Response) => (await response.json() as { error: { code: string; message: string } }).error;
const rowsOf = (userId: string) => getDb().select().from(mailInSenderAddresses).where(eq(mailInSenderAddresses.userId, userId));

function passMinute() {
  if (!vi.isFakeTimers()) vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(Date.now() + 61_000));
}

function tokenIn(text: string): string {
  const match = /token=([A-Za-z0-9_-]+)/.exec(text);
  if (!match) throw new Error("the check email carried no link token");
  return match[1];
}

async function idOf(userId: string, address: string): Promise<string> {
  const view = (await listSenderAddresses(userId)).find((row) => row.address === address);
  if (!view) throw new Error(`no row for ${address}`);
  return view.id;
}

/** Adds `address`, sends its check, and opens the link: the member now holds it verified. */
async function addAndVerify(session: IntegrationSession, userId: string, address: string) {
  expect((await addAddress(session, address)).status).toBeLessThan(300);
  passMinute();
  const id = await idOf(userId, address);
  const before = mail.sent.length;
  expect((await sendCheck(session, { id })).status).toBe(202);
  expect(mail.sent).toHaveLength(before + 1);
  const opened = await openLink(session, tokenIn(mail.sent[before].text));
  expect(opened.headers.get("location")).toContain("sender=verified");
  return id;
}

const member = () => fixture.users.member;
const owner = () => fixture.users.owner;

describe("add: POST /api/settings/mail-relay/senders", () => {
  it("refuses a request with no session, and one without the CSRF token", async () => {
    const route = (await sendersRoute()).POST;
    const anonymous = await callRoute(route, { url: SENDERS_URL, method: "POST", ...jsonInit({ address: SECOND }) });
    expect(anonymous.status).toBe(401);
    const session = await fixture.session("member");
    const { "x-csrf-token": _omitted, ...withoutCsrf } = session.headers;
    const noCsrf = await callRoute(route, { url: SENDERS_URL, method: "POST", headers: { ...withoutCsrf, "content-type": "application/json" }, body: JSON.stringify({ address: SECOND }) });
    expect(noCsrf.status).toBe(403);
    expect(await rowsOf(member().id)).toEqual([]);
  });

  it("adds a further address as an unchecked row, answers with the list, and sends no mail", async () => {
    const session = await fixture.session("member");
    await seedSenderAddress(member().id);

    const response = await addAddress(session, SECOND);

    expect([200, 201]).toContain(response.status);
    expect(response.headers.get("cache-control")).toContain("no-store");
    const body = await response.json() as { senders: Array<{ address: string; verified: boolean; verificationPending: boolean; source: string }> };
    expect(body.senders.map((row) => row.address)).toEqual([member().email, SECOND]);
    expect(body.senders[1]).toMatchObject({ verified: false, verificationPending: false, source: "manual" });
    expect(mail.sent).toEqual([]);
    expect(await listSenderAddresses(member().id)).toHaveLength(2);
  });

  it("normalises the address: case and spaces make no second row", async () => {
    const session = await fixture.session("member");
    await seedSenderAddress(member().id);
    expect((await addAddress(session, SECOND)).status).toBeLessThan(300);

    const again = await addAddress(session, `  ${SECOND.toUpperCase()} `);

    expect(again.status).toBe(200);
    expect((await listSenderAddresses(member().id)).map((row) => row.address)).toEqual([member().email, SECOND]);
  });

  it.each([["not an address"], [""], ["two@example.test, three@example.test"], [42], [null]])(
    "refuses %j with 400 sender_address_invalid and adds nothing",
    async (address) => {
      const session = await fixture.session("member");
      await seedSenderAddress(member().id);

      const response = await addAddress(session, address);

      expect(response.status).toBe(400);
      const error = await errorOf(response);
      expect(error.code).toBe("sender_address_invalid");
      expect(error.message).toContain("not an address Orbit can use");
      expect(await listSenderAddresses(member().id)).toHaveLength(1);
    },
  );

  it("refuses a body with no address, and an unparseable body, as invalid", async () => {
    const session = await fixture.session("member");
    const route = (await sendersRoute()).POST;
    const empty = await callRouteForSession(route, session, { url: SENDERS_URL, method: "POST", ...jsonInit({}) });
    expect(empty.status).toBe(400);
    expect((await errorOf(empty)).code).toBe("sender_address_invalid");
    const garbage = await callRouteForSession(route, session, { url: SENDERS_URL, method: "POST", body: "{ nope", headers: { "content-type": "application/json" } });
    expect(garbage.status).toBe(400);
    expect((await errorOf(garbage)).code).toBe("sender_address_invalid");
  });

  it("ignores a user field in the body: the row is the signed-in member's", async () => {
    const session = await fixture.session("member");
    const response = await callRouteForSession((await sendersRoute()).POST, session, {
      url: SENDERS_URL, method: "POST", ...jsonInit({ address: SECOND, userId: owner().id }),
    });
    expect(response.status).toBeLessThan(300);
    expect((await rowsOf(owner().id))).toEqual([]);
    expect((await listSenderAddresses(member().id)).map((row) => row.address)).toContain(SECOND);
  });

  it("is idempotent for an address already on the member's list, the sign-in address included: 200, nothing sent", async () => {
    const session = await fixture.session("member");
    await seedSenderAddress(member().id);
    expect((await addAddress(session, SECOND)).status).toBeLessThan(300);

    for (const address of [SECOND, member().email]) {
      const response = await addAddress(session, address);
      expect(response.status).toBe(200);
      const body = await response.json() as { senders: Array<{ address: string }> };
      expect(body.senders.map((row) => row.address)).toEqual([member().email, SECOND]);
    }
    expect(await rowsOf(member().id)).toHaveLength(2);
    expect(mail.sent).toEqual([]);
  });

  it("lists rows in the order they were added, the sign-in row first, not alphabetically", async () => {
    const session = await fixture.session("member");
    await seedSenderAddress(member().id);
    const zFirst = "zz-added-first@example.test";
    const aSecond = "aa-added-second@example.test";
    const mThird = "mm-added-third@example.test";
    for (const address of [zFirst, aSecond, mThird]) expect((await addAddress(session, address)).status).toBeLessThan(300);

    expect((await listSenderAddresses(member().id)).map((row) => row.address)).toEqual([member().email, zFirst, aSecond, mThird]);
  });

  it("answers the same request made twice at once with one row, not two", async () => {
    const session = await fixture.session("member");
    await seedSenderAddress(member().id);

    const [first, second] = await Promise.all([addAddress(session, SECOND), addAddress(session, SECOND)]);

    expect(first.status).toBeLessThan(300);
    expect(second.status).toBeLessThan(300);
    const rows = (await listSenderAddresses(member().id)).filter((row) => row.address === SECOND);
    expect(rows).toHaveLength(1);
    expect(await rowsOf(member().id)).toHaveLength(2);
  });
});

describe("the cap of five, counting the sign-in row", () => {
  const extras = ["cap-one", "cap-two", "cap-three", "cap-four", "cap-five"].map((name) => `${name}@example.test`);

  it("accepts four extras beside the sign-in address and refuses the fifth with 409 sender_address_limit", async () => {
    const session = await fixture.session("member");
    await seedSenderAddress(member().id);
    for (const address of extras.slice(0, 4)) expect((await addAddress(session, address)).status).toBeLessThan(300);
    expect(await rowsOf(member().id)).toHaveLength(5);

    const response = await addAddress(session, extras[4]);

    expect(response.status).toBe(409);
    const error = await errorOf(response);
    expect(error.code).toBe("sender_address_limit");
    expect(error.message).toContain("five is the most");
    expect(await rowsOf(member().id)).toHaveLength(5);
  });

  it("counts every row, checked or not, and still answers an address already on the list with 200 at the cap", async () => {
    const session = await fixture.session("member");
    await seedSenderAddress(member().id);
    for (const address of extras.slice(0, 4)) expect((await addAddress(session, address)).status).toBeLessThan(300);

    expect((await addAddress(session, extras[0])).status).toBe(200);
    expect((await addAddress(session, member().email)).status).toBe(200);
    expect((await addAddress(session, extras[4])).status).toBe(409);
  });

  it("counts the sign-in row even when the member has not opened Settings yet (no row seeded)", async () => {
    const session = await fixture.session("member");
    for (const address of extras.slice(0, 4)) expect((await addAddress(session, address)).status).toBeLessThan(300);

    const response = await addAddress(session, extras[4]);

    expect(response.status).toBe(409);
    expect((await errorOf(response)).code).toBe("sender_address_limit");
  });

  it("lets the member add again once a row is removed, and leaves another member's cap alone", async () => {
    const session = await fixture.session("member");
    const other = await fixture.session("owner");
    await seedSenderAddress(member().id);
    for (const address of extras.slice(0, 4)) expect((await addAddress(session, address)).status).toBeLessThan(300);
    expect((await addAddress(session, extras[4])).status).toBe(409);

    expect((await removeRow(session, await idOf(member().id, extras[0]))).status).toBeLessThan(300);
    expect((await addAddress(session, extras[4])).status).toBeLessThan(300);

    expect((await addAddress(other, extras[0])).status).toBeLessThan(300);
  });
});

describe("send a check for an extra row: POST /verification with { id }", () => {
  it("sends one check mail to that row's address, answers 202 with it, and verifies only that row", async () => {
    const session = await fixture.session("member");
    await seedSenderAddress(member().id);
    expect((await addAddress(session, SECOND)).status).toBeLessThan(300);
    const id = await idOf(member().id, SECOND);

    const response = await sendCheck(session, { id });

    expect(response.status).toBe(202);
    const body = await response.json() as { address: string; expiresAt: string };
    expect(body.address).toBe(SECOND);
    expect(Date.parse(body.expiresAt)).toBeGreaterThan(Date.now());
    expect(mail.sent.map((message) => message.to)).toEqual([SECOND]);
    expect(mail.sent[0].text).toContain("/api/settings/mail-relay/verify?token=");
    const list = await listSenderAddresses(member().id);
    expect(list.find((row) => row.address === SECOND)).toMatchObject({ verified: false, verificationPending: true });
    expect(list.find((row) => row.address === member().email)).toMatchObject({ verified: false, verificationPending: false });
  });

  it("verifies the extra row through its link, and then attributes that address to the member", async () => {
    const session = await fixture.session("member");
    await seedSenderAddress(member().id);
    expect(await userForVerifiedSender(SECOND)).toBeUndefined();

    await addAndVerify(session, member().id, SECOND);

    expect(await userForVerifiedSender(SECOND)).toBe(member().id);
    expect((await verifiedSenderMatch(SECOND)).state).toBe("matched");
    expect((await listSenderAddresses(member().id)).find((row) => row.address === SECOND)).toMatchObject({ verified: true, verificationPending: false });
    expect(await userForVerifiedSender(member().email)).toBeUndefined();
  });

  it("answers 409 sender_already_verified for a row that is already checked, and sends nothing more", async () => {
    const session = await fixture.session("member");
    const id = await addAndVerify(session, member().id, SECOND);
    mail.sent.length = 0;
    passMinute();

    const response = await sendCheck(session, { id });

    expect(response.status).toBe(409);
    expect((await errorOf(response)).code).toBe("sender_already_verified");
    expect(mail.sent).toEqual([]);
  });

  it("answers 404 sender_address_unknown for an unknown id and for another member's row, and sends nothing", async () => {
    const session = await fixture.session("member");
    const other = await fixture.session("owner");
    expect((await addAddress(other, THIRD)).status).toBeLessThan(300);
    const othersId = await idOf(owner().id, THIRD);

    for (const id of [UNKNOWN_ID, othersId, "not-a-uuid"]) {
      const response = await sendCheck(session, { id });
      expect(response.status).toBe(404);
      expect((await errorOf(response)).code).toBe("sender_address_unknown");
    }
    expect(mail.sent).toEqual([]);
  });

  it("refuses with 409 sender_address_unavailable, and sends nothing, when somebody else has proved the address meanwhile", async () => {
    const session = await fixture.session("member");
    await seedSenderAddress(member().id);
    await seedSenderAddress(owner().id);
    expect((await addAddress(session, owner().email)).status).toBeLessThan(300);
    const id = await idOf(member().id, owner().email);
    /* The owner proves the address without the drop having reached A's row. */
    await getDb().update(mailInSenderAddresses).set({ verifiedAt: new Date() }).where(eq(mailInSenderAddresses.userId, owner().id));

    const response = await sendCheck(session, { id });

    expect(response.status).toBe(409);
    const error = await errorOf(response);
    expect(error.code).toBe("sender_address_unavailable");
    expect(error.message).toContain("can't be added to this account");
    expect(JSON.stringify(error)).not.toContain(owner().email);
    expect(mail.sent).toEqual([]);
  });

  it("sends the same request made twice at once as one mail", async () => {
    const session = await fixture.session("member");
    await seedSenderAddress(member().id);
    expect((await addAddress(session, SECOND)).status).toBeLessThan(300);
    const id = await idOf(member().id, SECOND);

    const statuses = (await Promise.all([sendCheck(session, { id }), sendCheck(session, { id })])).map((response) => response.status).sort();

    expect(statuses).toEqual([202, 429]);
    expect(mail.sent).toHaveLength(1);
  });
});

describe("the sign-in address's own check flow is unchanged (neighbouring case)", () => {
  it("with no body, sends the check to the sign-in address even when the member holds extra rows", async () => {
    const session = await fixture.session("member");
    await seedSenderAddress(member().id);
    expect((await addAddress(session, SECOND)).status).toBeLessThan(300);

    const response = await sendCheck(session);

    expect(response.status).toBe(202);
    expect((await response.json() as { address: string }).address).toBe(member().email);
    expect(mail.sent.map((message) => message.to)).toEqual([member().email]);
    expect(await rowsOf(member().id)).toHaveLength(2);
  });

  it("with no body and no row yet, still seeds the sign-in address and sends there", async () => {
    const session = await fixture.session("member");
    const response = await sendCheck(session);
    expect(response.status).toBe(202);
    expect(mail.sent.map((message) => message.to)).toEqual([member().email]);
    expect(await rowsOf(member().id)).toHaveLength(1);
  });

  it("takes the seeded row's own id as the same thing as no body", async () => {
    const session = await fixture.session("member");
    await seedSenderAddress(member().id);
    const response = await sendCheck(session, { id: await idOf(member().id, member().email) });
    expect(response.status).toBe(202);
    expect(mail.sent.map((message) => message.to)).toEqual([member().email]);
  });

  it("verifies the sign-in address through its link and leaves an unchecked extra row unchecked and non-attributing", async () => {
    const session = await fixture.session("member");
    await seedSenderAddress(member().id);
    expect((await addAddress(session, SECOND)).status).toBeLessThan(300);
    expect((await sendCheck(session)).status).toBe(202);

    const opened = await openLink(session, tokenIn(mail.sent[0].text));

    expect(opened.headers.get("location")).toContain("sender=verified");
    expect(await userForVerifiedSender(member().email)).toBe(member().id);
    expect(await userForVerifiedSender(SECOND)).toBeUndefined();
    expect((await listSenderAddresses(member().id)).find((row) => row.address === SECOND)).toMatchObject({ verified: false });
  });

  it("answers 409 sender_already_verified for a body-less request once the sign-in address is checked", async () => {
    const session = await fixture.session("member");
    await verifiedSenderFor(member().id);
    const response = await sendCheck(session);
    expect(response.status).toBe(409);
    expect((await errorOf(response)).code).toBe("sender_already_verified");
    expect(mail.sent).toEqual([]);
  });
});

describe("the check-mail rate limit is shared across the member's rows", () => {
  it("refuses a second check inside a minute even for a different row, with 429 and no mail", async () => {
    const session = await fixture.session("member");
    await seedSenderAddress(member().id);
    expect((await addAddress(session, SECOND)).status).toBeLessThan(300);
    expect((await sendCheck(session, { id: await idOf(member().id, SECOND) })).status).toBe(202);

    const response = await sendCheck(session);

    expect(response.status).toBe(429);
    expect((await errorOf(response)).code).toBe("sender_check_too_soon");
    expect(mail.sent).toHaveLength(1);
  });

  it("counts five sends in a day across five rows, one each, and refuses the sixth", async () => {
    const session = await fixture.session("member");
    await seedSenderAddress(member().id);
    const extras = ["lim-one", "lim-two", "lim-three", "lim-four"].map((name) => `${name}@example.test`);
    for (const address of extras) expect((await addAddress(session, address)).status).toBeLessThan(300);
    const ids = [await idOf(member().id, member().email), ...await Promise.all(extras.map((address) => idOf(member().id, address)))];

    for (const id of ids) {
      passMinute();
      expect((await sendCheck(session, { id })).status).toBe(202);
    }
    expect(mail.sent).toHaveLength(5);
    passMinute();
    const sixth = await sendCheck(session, { id: ids[0] });

    expect(sixth.status).toBe(429);
    expect((await errorOf(sixth)).code).toBe("sender_check_daily_limit");
    expect(mail.sent).toHaveLength(5);
  });

  it("does not let one member's sends slow another's", async () => {
    const session = await fixture.session("member");
    const other = await fixture.session("owner");
    expect((await sendCheck(session)).status).toBe(202);
    expect((await sendCheck(other)).status).toBe(202);
    expect(mail.sent).toHaveLength(2);
  });
});

describe("removal: DELETE /api/settings/mail-relay/senders/:id", () => {
  it("refuses a request with no session", async () => {
    const response = await callRoute((await senderRoute()).DELETE, { url: `${SENDERS_URL}/${UNKNOWN_ID}`, method: "DELETE", params: { id: UNKNOWN_ID } });
    expect(response.status).toBe(401);
  });

  it("removes an unchecked extra row and nothing else", async () => {
    const session = await fixture.session("member");
    await seedSenderAddress(member().id);
    expect((await addAddress(session, SECOND)).status).toBeLessThan(300);
    expect((await addAddress(session, THIRD)).status).toBeLessThan(300);

    const response = await removeRow(session, await idOf(member().id, SECOND));

    expect(response.status).toBeLessThan(300);
    expect((await listSenderAddresses(member().id)).map((row) => row.address)).toEqual([member().email, THIRD]);
  });

  it("removes a checked extra row even when that leaves the member with no checked address, and the address attributes no more", async () => {
    const session = await fixture.session("member");
    await seedSenderAddress(member().id);
    const id = await addAndVerify(session, member().id, SECOND);
    expect(await userForVerifiedSender(SECOND)).toBe(member().id);

    const response = await removeRow(session, id);

    expect(response.status).toBeLessThan(300);
    expect(await userForVerifiedSender(SECOND)).toBeUndefined();
    expect((await listSenderAddresses(member().id)).map((row) => row.address)).toEqual([member().email]);
  });

  it("refuses the sign-in row with 409 sender_address_seeded, unchecked or checked", async () => {
    const session = await fixture.session("member");
    await seedSenderAddress(member().id);
    const id = await idOf(member().id, member().email);

    const unchecked = await removeRow(session, id);
    expect(unchecked.status).toBe(409);
    const error = await errorOf(unchecked);
    expect(error.code).toBe("sender_address_seeded");
    expect(error.message).toContain("the sign-in address stays");

    await verifiedSenderFor(member().id);
    expect((await removeRow(session, id)).status).toBe(409);
    expect(await rowsOf(member().id)).toHaveLength(1);
    expect(await userForVerifiedSender(member().email)).toBe(member().id);
  });

  it("refuses the sign-in row even when the member also holds a checked extra one", async () => {
    const session = await fixture.session("member");
    await seedSenderAddress(member().id);
    await addAndVerify(session, member().id, SECOND);
    const response = await removeRow(session, await idOf(member().id, member().email));
    expect(response.status).toBe(409);
    expect((await errorOf(response)).code).toBe("sender_address_seeded");
  });

  it("answers 404 sender_address_unknown for an unknown id and for another member's row, and removes nothing", async () => {
    const session = await fixture.session("member");
    const other = await fixture.session("owner");
    expect((await addAddress(other, THIRD)).status).toBeLessThan(300);
    const othersId = await idOf(owner().id, THIRD);

    for (const id of [UNKNOWN_ID, othersId]) {
      const response = await removeRow(session, id);
      expect(response.status).toBe(404);
      expect((await errorOf(response)).code).toBe("sender_address_unknown");
    }
    expect((await listSenderAddresses(owner().id)).map((row) => row.address)).toContain(THIRD);
  });
});

describe("one verified holder per address; an unverified row holds nothing (the note's test list)", () => {
  const ownersAddress = () => owner().email;

  it("lets A add B's unverified sign-in address, leaves B's seed alone, and B's own check still works", async () => {
    const a = await fixture.session("member");
    const b = await fixture.session("owner");
    await seedSenderAddress(owner().id);
    const seedBefore = (await rowsOf(owner().id))[0];

    const added = await addAddress(a, ownersAddress());

    expect(added.status).toBeLessThan(300);
    const seedAfter = (await rowsOf(owner().id))[0];
    expect(seedAfter.id).toBe(seedBefore.id);
    expect(seedAfter.verifiedAt).toBeNull();
    expect(mail.sent).toEqual([]);
    expect(await userForVerifiedSender(ownersAddress())).toBeUndefined();
    const check = await sendCheck(b);
    expect(check.status).toBe(202);
    expect(mail.sent.map((message) => message.to)).toEqual([ownersAddress()]);
  });

  it("lets A add an address before B is seeded for it; seeding B then leaves both rows standing, unverified", async () => {
    const a = await fixture.session("member");
    expect((await addAddress(a, ownersAddress())).status).toBeLessThan(300);

    await seedSenderAddress(owner().id);

    expect(await rowsOf(owner().id)).toHaveLength(1);
    expect((await listSenderAddresses(owner().id)).map((row) => row.address)).toEqual([ownersAddress()]);
    expect((await listSenderAddresses(member().id)).map((row) => row.address)).toContain(ownersAddress());
    expect(await userForVerifiedSender(ownersAddress())).toBeUndefined();
  });

  it("when B verifies while A holds an unverified row for the address, A's row is gone and B holds it", async () => {
    const a = await fixture.session("member");
    const b = await fixture.session("owner");
    await seedSenderAddress(member().id);
    expect((await addAddress(a, ownersAddress())).status).toBeLessThan(300);
    expect((await sendCheck(b)).status).toBe(202);

    const opened = await openLink(b, tokenIn(mail.sent[0].text));

    expect(opened.headers.get("location")).toContain("sender=verified");
    expect(await userForVerifiedSender(ownersAddress())).toBe(owner().id);
    expect((await listSenderAddresses(member().id)).map((row) => row.address)).toEqual([member().email]);
    expect((await rowsOf(member().id)).filter((row) => row.id !== undefined)).toHaveLength(1);
  });

  it("when A tries to verify after B, A's link is refused with sender_verification_invalid (400), and B keeps the address", async () => {
    const a = await fixture.session("member");
    const b = await fixture.session("owner");
    await seedSenderAddress(member().id);
    expect((await addAddress(a, ownersAddress())).status).toBeLessThan(300);
    expect((await sendCheck(a, { id: await idOf(member().id, ownersAddress()) })).status).toBe(202);
    const aToken = tokenIn(mail.sent[0].text);
    expect((await sendCheck(b)).status).toBe(202);
    expect((await openLink(b, tokenIn(mail.sent[1].text))).headers.get("location")).toContain("sender=verified");

    await expect(verifySenderAddress(member().id, aToken)).rejects.toMatchObject({ code: "sender_verification_invalid", status: 400 });
    const viaLink = await openLink(a, aToken);
    expect(viaLink.headers.get("location")).toContain("sender=unverified");

    expect(await userForVerifiedSender(ownersAddress())).toBe(owner().id);
  });

  it("refuses A adding B's verified address with 409 sender_address_unavailable, naming no cause and no member", async () => {
    const a = await fixture.session("member");
    await verifiedSenderFor(owner().id);
    await seedSenderAddress(member().id);

    for (const address of [ownersAddress(), ownersAddress().toUpperCase()]) {
      const response = await addAddress(a, address);
      expect(response.status).toBe(409);
      const error = await errorOf(response);
      expect(error.code).toBe("sender_address_unavailable");
      expect(error.message).toContain("can't be added to this account");
      expect(JSON.stringify(error).toLowerCase()).not.toMatch(/verified|checked|another|other member|owner|taken|in use/);
    }
    expect((await listSenderAddresses(member().id)).map((row) => row.address)).toEqual([member().email]);
    expect(await userForVerifiedSender(ownersAddress())).toBe(owner().id);
  });

  it("refuses A adding a verified extra address of B's, too (not only the sign-in one)", async () => {
    const a = await fixture.session("member");
    const b = await fixture.session("owner");
    await seedSenderAddress(owner().id);
    await addAndVerify(b, owner().id, SECOND);

    const response = await addAddress(a, SECOND);

    expect(response.status).toBe(409);
    expect((await errorOf(response)).code).toBe("sender_address_unavailable");
  });

  it("does not let A's unverified row for an address attribute it, or change what a verified holder gets", async () => {
    const a = await fixture.session("member");
    await seedSenderAddress(owner().id);
    expect((await addAddress(a, ownersAddress())).status).toBeLessThan(300);
    expect(await verifiedSenderMatch(ownersAddress())).toEqual({ state: "no_match" });
  });

  it("does not let one member see or remove another's row through the list or the route", async () => {
    const a = await fixture.session("member");
    const b = await fixture.session("owner");
    expect((await addAddress(b, THIRD)).status).toBeLessThan(300);
    const response = await callRouteForSession((await sendersRoute()).POST, a, { url: SENDERS_URL, method: "POST", ...jsonInit({ address: SECOND }) });
    const body = JSON.stringify(await response.json());
    expect(body).not.toContain(THIRD);
    expect(body).not.toContain(owner().email);
  });
});

describe("a forward from the second address is attributed to its member", () => {
  async function collect(uidValidity: bigint, from: string) {
    const config = await getImapIngestionConfig();
    const headers = fixtureHeaders({ from, verdict: `dmarc=pass header.from=${from.slice(from.lastIndexOf("@") + 1)}` });
    const source = (fromOfHeaders(headers) ? await signedSource(fromOfHeaders(headers)!, "attribution-message\r\n") : Buffer.from("x"));
    setImapClientFactoryForTests(() => fakeImapMailbox({
      uidValidity, search: "all", deleted, messages: [{ uid: 1, headers, source: Buffer.from(source) }],
    }).client);
    await runImapIngestionCycle(config, {
      smtpConfig: () => ({ smtpUrl: "smtps://smtp.example.test", smtpFrom: "orbit@example.test" }) as never,
      sendMail: async (message: { to: string; subject: string; text: string }) => { replies.push(message); },
    });
  }

  async function receiptFor(uidValidity: string) {
    const [row] = await getDb().select({
      userId: imapIngestionMessages.userId,
      status: imapIngestionMessages.status,
      failureCode: imapIngestionMessages.failureCode,
      attributedBy: imapIngestionMessages.attributedBy,
    }).from(imapIngestionMessages).where(eq(imapIngestionMessages.mailboxUidValidity, uidValidity));
    return row;
  }

  it("lands mail from a checked second address in that member's queue, attributed by sender, and not the other member's", async () => {
    await setMailboxSettings(fixture.users.admin.id, null, settings, providerReady);
    await reconcileImapRecipientAliases(await getImapIngestionConfig());
    const a = await fixture.session("owner");
    await verifiedSenderFor(member().id);
    await seedSenderAddress(owner().id);
    await addAndVerify(a, owner().id, SECOND);

    await collect(2001n, SECOND);

    expect(await receiptFor("2001")).toMatchObject({ userId: owner().id, attributedBy: "sender" });
    expect(await getDb().select({ id: imapIngestionMessages.id }).from(imapIngestionMessages).where(eq(imapIngestionMessages.userId, member().id))).toHaveLength(0);
  }, 20_000);

  it("attributes nothing to a second address that is added but not yet checked", async () => {
    await setMailboxSettings(fixture.users.admin.id, null, settings, providerReady);
    await reconcileImapRecipientAliases(await getImapIngestionConfig());
    const a = await fixture.session("owner");
    await verifiedSenderFor(owner().id);
    expect((await addAddress(a, SECOND)).status).toBeLessThan(300);

    await collect(2002n, SECOND);

    expect(await receiptFor("2002")).toEqual({ userId: null, status: "unattributed", failureCode: "sender_unverified", attributedBy: null });
  }, 20_000);

  it("attributes nothing once the checked second address is removed", async () => {
    await setMailboxSettings(fixture.users.admin.id, null, settings, providerReady);
    await reconcileImapRecipientAliases(await getImapIngestionConfig());
    const a = await fixture.session("owner");
    await verifiedSenderFor(owner().id);
    const id = await addAndVerify(a, owner().id, SECOND);
    expect((await removeRow(a, id)).status).toBeLessThan(300);

    await collect(2003n, SECOND);

    expect(await receiptFor("2003")).toMatchObject({ userId: null, status: "unattributed" });
    expect(await getDb().select({ id: imapIngestionMessages.id }).from(imapIngestionMessages)
      .where(and(eq(imapIngestionMessages.userId, owner().id), isNotNull(imapIngestionMessages.userId)))).toHaveLength(0);
  }, 20_000);
});

describe("the settings payload carries the list", () => {
  it("readRelaySettings returns every row in order as `senders`, and keeps `sender` as the first", async () => {
    const session = await fixture.session("member");
    await seedSenderAddress(member().id);
    const zFirst = "zz-payload-first@example.test";
    const aSecond = "aa-payload-second@example.test";
    for (const address of [zFirst, aSecond]) expect((await addAddress(session, address)).status).toBeLessThan(300);
    expect((await sendCheck(session, { id: await idOf(member().id, aSecond) })).status).toBe(202);

    const relay = await readRelaySettings({ id: member().id, isInstanceAdmin: false }) as unknown as {
      sender: { address: string } | null;
      senders: Array<{ id: string; address: string; verified: boolean; verificationPending: boolean }>;
    };

    expect(relay.senders.map((row) => row.address)).toEqual([member().email, zFirst, aSecond]);
    expect(relay.senders.map((row) => [row.verified, row.verificationPending])).toEqual([[false, false], [false, false], [false, true]]);
    expect(relay.sender?.address).toBe(member().email);
    expect(typeof relay.senders[1].id).toBe("string");
  });

  it("GET /api/settings/mail-relay carries the same list, for the signed-in member only", async () => {
    const session = await fixture.session("member");
    const other = await fixture.session("owner");
    await seedSenderAddress(member().id);
    expect((await addAddress(session, SECOND)).status).toBeLessThan(300);
    expect((await addAddress(other, THIRD)).status).toBeLessThan(300);
    const route = (await loadRoute("settings/mail-relay")).GET;

    const response = await callRouteForSession(route, session, { url: ROOT });

    const body = await response.json() as { relay: { senders: Array<{ address: string }> } };
    expect(body.relay.senders.map((row) => row.address)).toEqual([member().email, SECOND]);
    expect(JSON.stringify(body)).not.toContain(THIRD);
  });

  it("after a removal the payload no longer lists the row", async () => {
    const session = await fixture.session("member");
    await seedSenderAddress(member().id);
    expect((await addAddress(session, SECOND)).status).toBeLessThan(300);
    expect((await removeRow(session, await idOf(member().id, SECOND))).status).toBeLessThan(300);
    const relay = await readRelaySettings({ id: member().id, isInstanceAdmin: false }) as unknown as { senders: Array<{ address: string }> };
    expect(relay.senders.map((row) => row.address)).toEqual([member().email]);
  });
});
