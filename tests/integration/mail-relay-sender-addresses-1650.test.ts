import { and, eq, isNotNull, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/db";
import {
  auditLog,
  imapIngestionAttachments,
  imapIngestionMessages,
  imapRecipientAliases,
  mailInMailbox,
  mailInRelays,
  mailInSecrets,
  mailInSenderAddresses,
  mailInUnattributedReplies,
  users,
} from "@/db/schema";
import { requireInstanceMetadataWriter } from "@/server/metadata/fields";
import { discardImapReviewItem, getImapReview, listImapInbox, purgeExpiredImapStaging } from "@/server/mail-in/imap-inbox";
import { readHeldImapAttachmentPreview } from "@/server/mail-in/imap-attachment-preview";
import { setRelayIngestPaused } from "@/server/mail-in/relays";
import { readRelaySettings } from "@/server/mail-in/relay-settings";
import { log } from "@/lib/logger";
import {
  listSenderAddresses,
  requestSenderCheck,
  SENDER_VERIFICATION_TTL_MS,
  seedSenderAddress,
  userForVerifiedSender,
  verifiedSenderMatch,
  verifySenderAddress,
} from "@/server/mail-in/sender-addresses";
import { getImapIngestionConfig } from "@/server/mail-in/mailbox-config";
import { setMailboxSettings, type MailboxSettingsDependencies, type MailboxSettingsInput } from "@/server/mail-in/mailbox-settings";
import { reconcileImapRecipientAliases, runImapIngestionCycle, setImapClientFactoryForTests } from "@/server/mail-in/imap-ingestion";
import { cleanupIntegrationEnvironment, createIntegrationFixture, damageEnvelope, withRequiredScanMode, type IntegrationFixture, type IntegrationSession } from "./support/fixtures";
import { callRoute, callRouteForSession, loadRoute } from "./support/request-event";
import { clearSending, setUpSending } from "./support/mail-sending-1629";
import { fakeImapMailbox, fixtureHeaders, verifiedSenderFor } from "./support/mail-in";
import { fixtureDnsGate, fromOfHeaders, signedSource } from "./support/dkim-fixture";
import { syntheticPdf } from "../support/synthetic-documents";

vi.mock("node:dns/promises", async () => (await import("./support/dkim-fixture")).fixtureDnsModule());

// A held mail that carries a document is scanned once it is released; the
// verdict is not what these tests are about, so it answers clean.
vi.mock("@/server/documents/scanner", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/server/documents/scanner")>(),
  scanFileWithClamAv: vi.fn(async () => ({ status: "clean" as const })),
}));

/*
 * #1650, from its specification and the design note (54553) alone: a member
 * may hold up to five sending addresses, the sign-in address included.
 *
 *  - POST   /api/settings/mail-relay/senders        { address }
 *  - DELETE /api/settings/mail-relay/senders/:id
 *  - POST   /api/settings/mail-relay/verification   optional { id }
 *
 * Verification is the exclusive act (first come); an unverified row holds
 * nothing. An unchecked extra row is removed 14 days after it was added (owner
 * decision, note 54816, which overrules the 30 days of note 54553). Mail from
 * a listed but unchecked address is held in that member's inbox, not addable,
 * and sends the check mail again (54816); when two members list it, it is held
 * for nobody (55316). The screens are in tests/unit/v19-mail-sender-rows-1650.test.mjs.
 *
 * Names the build must provide that the notes do not fix (decided by the test
 * author, to be matched by the build or renegotiated in the issue):
 *  - an inbox item (listImapInbox / GET /api/imap-inbox) from a held arrival
 *    carries `needsSenderCheck: true` and `canApprove: false`; once the
 *    address is checked the same item carries `needsSenderCheck: false`;
 *  - PUT /api/imap-inbox/:id (the "add to Orbit" action) on a held item is
 *    refused 409 `sender_unchecked` with the words "Please verify sending
 *    address";
 *  - each settings `senders` entry carries `daysLeft` (whole days, rounded up)
 *    for an unchecked extra row, and none for the seeded or a checked row;
 *  - the sweep is `purgeExpiredImapStaging` (src/server/mail-in/imap-inbox.ts).
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

beforeEach(async () => {
  mail.sent.length = 0;
  deleted = [];
  replies = [];
  fixture = await createIntegrationFixture("sender-addresses-1650");
  /* Outgoing mail is the sending row since #1629, not SMTP_* (ADR-0017 amendment). */
  await setUpSending(fixture.users.admin.id);
});

afterEach(async () => {
  vi.useRealTimers();
  setImapClientFactoryForTests(undefined);
  const db = getDb();
  await db.delete(imapIngestionMessages);
  await db.delete(imapRecipientAliases);
  await db.delete(mailInSenderAddresses);
  await db.delete(mailInUnattributedReplies);
  await db.delete(mailInRelays);
  await db.update(mailInMailbox).set({ passwordSecretId: null, aliasKeySecretId: null });
  await db.delete(mailInMailbox);
  await clearSending();
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

  /* #1810 item 2 supersedes the 409 here: the press answers as for any address, and no mail goes. */
  it("answers 202 and sends nothing, naming nobody, when somebody else has proved the address meanwhile", async () => {
    const session = await fixture.session("member");
    await seedSenderAddress(member().id);
    await seedSenderAddress(owner().id);
    expect((await addAddress(session, owner().email)).status).toBeLessThan(300);
    const id = await idOf(member().id, owner().email);
    /* The owner proves the address without the drop having reached A's row. */
    await getDb().update(mailInSenderAddresses).set({ verifiedAt: new Date() }).where(eq(mailInSenderAddresses.userId, owner().id));

    const response = await sendCheck(session, { id });

    expect(response.status).toBe(202);
    expect(Object.keys(await response.json() as object).sort()).toEqual(["address", "expiresAt"]);
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

  /* #1810 item 2 supersedes the 409 here: the add answers as for any address. */
  it("adds B's verified address for A as an unchecked row, as any address, and B keeps it", async () => {
    const a = await fixture.session("member");
    await verifiedSenderFor(owner().id);
    await seedSenderAddress(member().id);

    expect((await addAddress(a, ownersAddress())).status).toBe(201);
    expect((await addAddress(a, ownersAddress().toUpperCase())).status).toBeLessThan(300);
    const view = await listSenderAddresses(member().id);
    expect(view.map((row) => row.address)).toEqual([member().email, ownersAddress()]);
    expect(view[1].verified).toBe(false);
    expect(await userForVerifiedSender(ownersAddress())).toBe(owner().id);
  });

  /* #1810 item 2 supersedes the 409 here. */
  it("adds a verified extra address of B's for A as unchecked, too (not only the sign-in one)", async () => {
    const a = await fixture.session("member");
    const b = await fixture.session("owner");
    await seedSenderAddress(owner().id);
    await addAndVerify(b, owner().id, SECOND);

    const response = await addAddress(a, SECOND);

    expect(response.status).toBe(201);
    expect((await listSenderAddresses(member().id)).find((row) => row.address === SECOND)?.verified).toBe(false);
    expect(await userForVerifiedSender(SECOND)).toBe(owner().id);
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

  it("holds mail from a second address that is added but not yet checked: the member's, not addable (54816)", async () => {
    await setMailboxSettings(fixture.users.admin.id, null, settings, providerReady);
    await reconcileImapRecipientAliases(await getImapIngestionConfig());
    const a = await fixture.session("owner");
    await verifiedSenderFor(owner().id);
    expect((await addAddress(a, SECOND)).status).toBeLessThan(300);

    await collect(2002n, SECOND);

    const items = (await listImapInbox(owner().id)).receipts as unknown as Array<{ needsSenderCheck?: boolean; canApprove: boolean }>;
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ needsSenderCheck: true, canApprove: false });
    expect(await userForVerifiedSender(SECOND)).toBeUndefined();
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

/* ------------------------------------------------------------------------- */
/* The 14-day life of an unchecked extra row (note 54816, over 54553's 30)   */
/* ------------------------------------------------------------------------- */

const DAY = 86_400_000;
const daysAgo = (days: number) => new Date(Date.now() - days * DAY);
/** Moves the clock on, as passMinute does; backdate first, then advance. */
function advanceClock(ms: number) {
  if (!vi.isFakeTimers()) vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(Date.now() + ms));
}
const backdate = (userId: string, address: string, days: number) => idOf(userId, address).then((id) =>
  getDb().update(mailInSenderAddresses).set({ createdAt: daysAgo(days) }).where(eq(mailInSenderAddresses.id, id)));

/** A receipt held under a sender row, written the way the filer writes it (#1810). */
async function insertHeldReceipt(executor: Pick<ReturnType<typeof getDb>, "insert">, userId: string, senderAddressId: string, uid = 1) {
  const [row] = await executor.insert(imapIngestionMessages).values({
    mailbox: "INBOX",
    mailboxUidValidity: "9001",
    mailboxUid: uid,
    contentSha256: uid.toString(16).padStart(64, "0"),
    recipientAliasSha256: uid.toString(16).padStart(64, "1"),
    userId,
    expiresAt: new Date(Date.now() + 30 * DAY),
    status: "processing",
    receiptStatus: "processing",
    heldSenderAddressId: senderAddressId,
  }).returning({ id: imapIngestionMessages.id });
  return row.id;
}

describe("an unchecked extra row is removed 14 days after it was added", () => {
  it("sweeps a 15-day unchecked extra row and keeps a 13-day one", async () => {
    const session = await fixture.session("member");
    await seedSenderAddress(member().id);
    expect((await addAddress(session, SECOND)).status).toBeLessThan(300);
    expect((await addAddress(session, THIRD)).status).toBeLessThan(300);
    await backdate(member().id, SECOND, 15);
    await backdate(member().id, THIRD, 13);

    await purgeExpiredImapStaging(new Date());

    expect((await listSenderAddresses(member().id)).map((row) => row.address)).toEqual([member().email, THIRD]);
  });

  it("never sweeps the seeded sign-in row, however old, and not a checked extra row either", async () => {
    const session = await fixture.session("member");
    await seedSenderAddress(member().id);
    await addAndVerify(session, member().id, SECOND);
    await getDb().update(mailInSenderAddresses).set({ createdAt: daysAgo(400) }).where(eq(mailInSenderAddresses.userId, member().id));

    await purgeExpiredImapStaging(new Date());

    expect((await listSenderAddresses(member().id)).map((row) => row.address)).toEqual([member().email, SECOND]);
  });

  it("sweeps quietly: no mail is sent", async () => {
    const session = await fixture.session("member");
    await seedSenderAddress(member().id);
    expect((await addAddress(session, SECOND)).status).toBeLessThan(300);
    await backdate(member().id, SECOND, 20);
    await purgeExpiredImapStaging(new Date());
    expect(await listSenderAddresses(member().id)).toHaveLength(1);
    expect(mail.sent).toEqual([]);
  });

  /* #1810 item 5 re-cuts this: a send at 15 days is now refused (see that
     block), so the send here is made just inside the 14 days. */
  it("a check sent near the deadline defers removal to the link's lapse and never restarts the 14 days", async () => {
    const session = await fixture.session("member");
    await seedSenderAddress(member().id);
    expect((await addAddress(session, SECOND)).status).toBeLessThan(300);
    await backdate(member().id, SECOND, 13.99);
    expect((await sendCheck(session, { id: await idOf(member().id, SECOND) })).status).toBe(202);

    advanceClock(0.5 * DAY);
    await purgeExpiredImapStaging(new Date());
    expect((await listSenderAddresses(member().id)).map((row) => row.address)).toEqual([member().email, SECOND]);

    advanceClock(SENDER_VERIFICATION_TTL_MS + 60_000);
    await purgeExpiredImapStaging(new Date());

    expect((await listSenderAddresses(member().id)).map((row) => row.address)).toEqual([member().email]);
    expect(mail.sent).toHaveLength(1);
  });

  it("keeps a row past 14 days while the check link sent in its last day is still good, and the link still verifies", async () => {
    const session = await fixture.session("member");
    await seedSenderAddress(member().id);
    expect((await addAddress(session, SECOND)).status).toBeLessThan(300);
    await backdate(member().id, SECOND, 13.5);
    expect((await sendCheck(session, { id: await idOf(member().id, SECOND) })).status).toBe(202);
    const token = tokenIn(mail.sent[0].text);

    advanceClock(0.6 * DAY);
    await purgeExpiredImapStaging(new Date());

    expect((await listSenderAddresses(member().id)).map((row) => row.address)).toContain(SECOND);
    /* The clock move ends the earlier sign-in: open the link with a fresh session. */
    const later = await fixture.session("member");
    expect((await openLink(later, token)).headers.get("location")).toContain("sender=verified");
    const view = (await listSenderAddresses(member().id)).find((row) => row.address === SECOND);
    expect(view?.verified).toBe(true);
  });

  it("still removes an unchecked row at 14 days when its link has lapsed, and one that never had a link", async () => {
    const session = await fixture.session("member");
    await seedSenderAddress(member().id);
    expect((await addAddress(session, SECOND)).status).toBeLessThan(300);
    expect((await addAddress(session, THIRD)).status).toBeLessThan(300);
    expect((await sendCheck(session, { id: await idOf(member().id, SECOND) })).status).toBe(202);
    await backdate(member().id, SECOND, 15);
    await backdate(member().id, THIRD, 15);

    advanceClock(25 * 3_600_000);
    await purgeExpiredImapStaging(new Date());

    expect((await listSenderAddresses(member().id)).map((row) => row.address)).toEqual([member().email]);
    const stored = (await listSenderAddresses(member().id)).map((row) => row.address);
    expect(stored).not.toContain(SECOND);
    expect(stored).not.toContain(THIRD);
    expect(await rowsOf(member().id)).toHaveLength(1);
  });

  /* #1810 item 5: no link can be sent past day 14, so the link is sent inside
     the 14 days and the row is then overdue. */
  it("says one day left, not none, for an overdue row whose link is still good", async () => {
    const session = await fixture.session("member");
    await seedSenderAddress(member().id);
    expect((await addAddress(session, SECOND)).status).toBeLessThan(300);
    await backdate(member().id, SECOND, 13.5);
    expect((await sendCheck(session, { id: await idOf(member().id, SECOND) })).status).toBe(202);
    advanceClock(0.7 * DAY);

    const view = (await listSenderAddresses(member().id)).find((row) => row.address === SECOND);

    expect(view?.daysLeft).toBe(1);
  });

  it("frees the slot: a swept row no longer counts toward the cap of five", async () => {
    const session = await fixture.session("member");
    await seedSenderAddress(member().id);
    const names = ["life-one", "life-two", "life-three", "life-four", "life-five"].map((name) => `${name}@example.test`);
    for (const address of names.slice(0, 4)) expect((await addAddress(session, address)).status).toBeLessThan(300);
    await backdate(member().id, names[0], 15);
    await purgeExpiredImapStaging(new Date());
    expect((await addAddress(session, names[4])).status).toBeLessThan(300);
  });
});

/* ------------------------------------------------------------------------- */
/* Mail from a listed, unchecked address is held for its member (note 54816) */
/* ------------------------------------------------------------------------- */

const CHECK_SUBJECT = "Check your Orbit sending address";
const NO_MATCH_SUBJECT = "Orbit could not match your message";
const HELD_WORDS = "Please verify sending address";

describe("mail from a listed but unchecked address", () => {
  async function arrive(uidValidity: bigint, from: string, options: { signed?: boolean; document?: boolean } = {}) {
    const config = await getImapIngestionConfig();
    const headers = fixtureHeaders({ from, verdict: `dmarc=pass header.from=${from.slice(from.lastIndexOf("@") + 1)}` });
    const source = options.signed === false
      ? Buffer.from(`${headers.toString()}held-message-unsigned\r\n`)
      : Buffer.from(await signedSource(fromOfHeaders(headers)!, "held-message\r\n"));
    const document = options.document ? {
      bodyStructure: {
        part: "1", type: "application", subtype: "pdf", disposition: "attachment",
        dispositionParameters: { filename: "receipt.pdf" }, size: 64,
      } as never,
      size: 64,
    } : {};
    setImapClientFactoryForTests(() => fakeImapMailbox({
      uidValidity, search: "all", deleted, messages: [{ uid: 1, headers, source, ...document }],
      ...(options.document ? { download: () => syntheticPdf("held then checked") } : {}),
    }).client);
    const cycle = () => runImapIngestionCycle(config, {
      smtpConfig: () => ({ smtpUrl: "smtps://smtp.example.test", smtpFrom: "orbit@example.test" }) as never,
      sendMail: async (message: { to: string; subject: string; text: string }) => { replies.push(message); },
    });
    await (options.document ? withRequiredScanMode(cycle) : cycle());
  }

  /** Every mail Orbit sent, whichever transport carried it. */
  const outbound = () => [...mail.sent, ...replies];
  const checkMails = () => outbound().filter((message) => message.subject === CHECK_SUBJECT);
  const noMatchMails = () => outbound().filter((message) => message.subject === NO_MATCH_SUBJECT);
  const heldItems = async (userId: string) => (await listImapInbox(userId)).receipts as unknown as Array<{ id: string; needsSenderCheck?: boolean; canApprove: boolean }>;

  async function ready() {
    await setMailboxSettings(fixture.users.admin.id, null, settings, providerReady);
    await reconcileImapRecipientAliases(await getImapIngestionConfig());
  }

  async function memberWithUncheckedSecond() {
    await ready();
    const session = await fixture.session("member");
    await verifiedSenderFor(member().id);
    expect((await addAddress(session, SECOND)).status).toBeLessThan(300);
    return session;
  }

  const assignHousehold = async (session: IntegrationSession, receiptId: string) =>
    callRouteForSession((await loadRoute("imap-inbox/[receiptId]")).PUT, session, {
      url: `http://127.0.0.1:3000/api/imap-inbox/${receiptId}`, method: "PUT", params: { receiptId },
      ...jsonInit({ householdId: fixture.household.id }),
    });

  it("lands in that member's inbox as held, not addable, and in nobody else's", async () => {
    await memberWithUncheckedSecond();

    await arrive(3001n, SECOND);

    const items = await heldItems(member().id);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ needsSenderCheck: true, canApprove: false });
    expect(await heldItems(owner().id)).toHaveLength(0);
  }, 20_000);

  it("refuses the add-to-Orbit action on held mail, in the server's words, and files nothing", async () => {
    const session = await memberWithUncheckedSecond();
    await arrive(3002n, SECOND);
    const [item] = await heldItems(member().id);

    const response = await assignHousehold(session, item.id);

    expect(response.status).toBe(409);
    const error = await errorOf(response);
    expect(error.code).toBe("sender_unchecked");
    expect(error.message).toContain(HELD_WORDS);
    const [row] = await getDb().select({ householdId: imapIngestionMessages.householdId }).from(imapIngestionMessages).where(eq(imapIngestionMessages.id, item.id));
    expect(row.householdId).toBeNull();
  }, 20_000);

  /* #1810 item 1 (owner answer 22a): the check releases the envelope-only
     hold, and the mail is fetched and becomes addable one worker cycle later. */
  it("becomes addable one worker cycle after the address is checked", async () => {
    const session = await memberWithUncheckedSecond();
    await arrive(3003n, SECOND, { document: true });
    const [before] = await heldItems(member().id);
    expect(before.needsSenderCheck).toBe(true);
    const [checkMail] = checkMails();
    expect(checkMail, "the arrival sent a check mail").toBeDefined();

    expect((await openLink(session, tokenIn(checkMail.text))).headers.get("location")).toContain("sender=verified");
    await secondCycle();

    const [after] = await heldItems(member().id);
    expect(after.id).toBe(before.id);
    expect(after.needsSenderCheck).toBe(false);
    const response = await assignHousehold(session, after.id);
    expect(response.status).toBe(200);
    const [row] = await getDb().select({ householdId: imapIngestionMessages.householdId }).from(imapIngestionMessages).where(eq(imapIngestionMessages.id, after.id));
    expect(row.householdId).toBe(fixture.household.id);
  }, 20_000);

  it("sends the check mail again on arrival, to that address, and no 'could not match' mail", async () => {
    await memberWithUncheckedSecond();

    await arrive(3004n, SECOND);

    expect(checkMails().map((message) => message.to)).toEqual([SECOND]);
    expect(checkMails()[0].text).toContain("/api/settings/mail-relay/verify?token=");
    expect(noMatchMails()).toEqual([]);
  }, 20_000);

  it("sends no second check mail for a second arrival inside the rate limit, and still holds that mail", async () => {
    await memberWithUncheckedSecond();

    await arrive(3005n, SECOND);
    await arrive(3006n, SECOND);

    expect(checkMails()).toHaveLength(1);
    expect(noMatchMails()).toEqual([]);
    expect(await heldItems(member().id)).toHaveLength(2);
  }, 20_000);

  it("shares the check-mail limit with the member's own send check: one a minute", async () => {
    const session = await memberWithUncheckedSecond();
    expect((await sendCheck(session, { id: await idOf(member().id, SECOND) })).status).toBe(202);
    const before = checkMails().length;

    await arrive(3007n, SECOND);

    expect(checkMails()).toHaveLength(before);
    expect(await heldItems(member().id)).toHaveLength(1);
  }, 20_000);

  it("keeps the mail held under such a row until the link lapses, and frees it when the link is opened", async () => {
    await memberWithUncheckedSecond();
    await backdate(member().id, SECOND, 13.5);
    await arrive(3030n, SECOND);
    expect(checkMails()).toHaveLength(1);

    advanceClock(0.6 * DAY);
    await purgeExpiredImapStaging(new Date());

    const held = await heldItems(member().id);
    expect(held).toHaveLength(1);
    expect(held[0].needsSenderCheck).toBe(true);
    const later = await fixture.session("member");
    expect((await openLink(later, tokenIn(checkMails()[0].text))).headers.get("location")).toContain("sender=verified");
    const [after] = await heldItems(member().id);
    expect(after.needsSenderCheck).toBe(false);
    const [row] = await getDb().select({ held: imapIngestionMessages.heldSenderAddressId }).from(imapIngestionMessages).where(eq(imapIngestionMessages.id, after.id));
    expect(row.held).toBeNull();
  }, 20_000);

  it("carries the days left on the held item: 14 for a row added now, fewer as it ages", async () => {
    await memberWithUncheckedSecond();
    await arrive(3020n, SECOND);
    expect(((await heldItems(member().id)) as unknown as Array<{ senderDaysLeft: number }>)[0].senderDaysLeft).toBe(14);

    await backdate(member().id, SECOND, 12.5);

    expect(((await heldItems(member().id)) as unknown as Array<{ senderDaysLeft: number }>)[0].senderDaysLeft).toBe(2);
  }, 20_000);

  it("holds mail from the member's unchecked sign-in address too", async () => {
    await ready();
    await seedSenderAddress(member().id);

    await arrive(3008n, member().email);

    expect(await heldItems(member().id)).toHaveLength(1);
    expect(checkMails().map((message) => message.to)).toEqual([member().email]);
    expect(noMatchMails()).toEqual([]);
  }, 20_000);

  it("answers an address on nobody's list with 'could not match', deletes the mail, and holds nothing", async () => {
    await memberWithUncheckedSecond();

    await arrive(3009n, "stranger-box@example.test");

    expect(noMatchMails().map((message) => message.to)).toEqual(["stranger-box@example.test"]);
    expect(checkMails()).toEqual([]);
    expect(deleted.length).toBeGreaterThan(0);
    expect(await heldItems(member().id)).toHaveLength(0);
  }, 20_000);

  it("does not hold mail that fails DKIM from that address: nothing in the inbox, no check mail", async () => {
    await memberWithUncheckedSecond();

    await arrive(3010n, SECOND, { signed: false });

    expect(await heldItems(member().id)).toHaveLength(0);
    expect(checkMails()).toEqual([]);
    expect(await getDb().select({ id: imapIngestionMessages.id }).from(imapIngestionMessages).where(eq(imapIngestionMessages.userId, member().id))).toHaveLength(0);
  }, 20_000);

  it("goes when the row is removed: the held mail is no longer in the inbox", async () => {
    const session = await memberWithUncheckedSecond();
    await arrive(3011n, SECOND);
    expect(await heldItems(member().id)).toHaveLength(1);

    expect((await removeRow(session, await idOf(member().id, SECOND))).status).toBeLessThan(300);

    expect(await heldItems(member().id)).toHaveLength(0);
    expect(await getDb().select({ id: imapIngestionMessages.id }).from(imapIngestionMessages).where(eq(imapIngestionMessages.userId, member().id))).toHaveLength(0);
  }, 20_000);

  it("goes with the row when the 14-day sweep removes it, and mail held under other rows stays", async () => {
    const session = await memberWithUncheckedSecond();
    expect((await addAddress(session, THIRD)).status).toBeLessThan(300);
    await arrive(3012n, SECOND);
    passMinute();
    await arrive(3013n, THIRD);
    expect(await heldItems(member().id)).toHaveLength(2);
    await backdate(member().id, SECOND, 15);
    /* SECOND's check link (sent on arrival) must have lapsed: a live link defers removal (A-S2). */
    advanceClock(SENDER_VERIFICATION_TTL_MS + 60_000);

    await purgeExpiredImapStaging(new Date());

    expect((await listSenderAddresses(member().id)).map((row) => row.address)).toEqual([member().email, THIRD]);
    expect(await heldItems(member().id)).toHaveLength(1);
  }, 20_000);

  it("holds for nobody when two members list the address unchecked: 'could not match', deleted, no check mail", async () => {
    await ready();
    const a = await fixture.session("member");
    const b = await fixture.session("owner");
    await verifiedSenderFor(member().id);
    await verifiedSenderFor(owner().id);
    expect((await addAddress(a, SECOND)).status).toBeLessThan(300);
    expect((await addAddress(b, SECOND)).status).toBeLessThan(300);

    await arrive(3014n, SECOND);

    expect(await heldItems(member().id)).toHaveLength(0);
    expect(await heldItems(owner().id)).toHaveLength(0);
    expect(noMatchMails().map((message) => message.to)).toEqual([SECOND]);
    expect(checkMails()).toEqual([]);
    expect(deleted.length).toBeGreaterThan(0);
  }, 20_000);

  it("sends no new check on arrival while a check sent in the last 24 hours is still good, so its link and the daily five are untouched", async () => {
    const session = await memberWithUncheckedSecond();
    const id = await idOf(member().id, SECOND);
    expect((await sendCheck(session, { id })).status).toBe(202);
    const firstLink = tokenIn(mail.sent[0].text);
    passMinute();

    await arrive(3030n, SECOND);

    expect(checkMails()).toHaveLength(1);
    expect((await rowsOf(member().id)).find((row) => row.id === id)?.checkSentAt).toHaveLength(1);
    expect(await heldItems(member().id)).toHaveLength(1);
    expect((await openLink(session, firstLink)).headers.get("location")).toContain("sender=verified");
  }, 20_000);

  it("when member B verifies the address, A's unverified row goes and so does the mail held under it", async () => {
    await memberWithUncheckedSecond();
    const b = await fixture.session("owner");
    await arrive(3031n, SECOND);
    expect(await heldItems(member().id)).toHaveLength(1);
    expect((await addAddress(b, SECOND)).status).toBeLessThan(300);
    expect((await sendCheck(b, { id: await idOf(owner().id, SECOND) })).status).toBe(202);
    const link = tokenIn(mail.sent.filter((message) => message.to === SECOND).at(-1)!.text);

    expect((await openLink(b, link)).headers.get("location")).toContain("sender=verified");

    expect((await listSenderAddresses(member().id)).map((row) => row.address)).toEqual([member().email]);
    expect(await heldItems(member().id)).toHaveLength(0);
    expect(await getDb().select({ id: imapIngestionMessages.id }).from(imapIngestionMessages).where(eq(imapIngestionMessages.userId, member().id))).toHaveLength(0);
    expect(await userForVerifiedSender(SECOND)).toBe(owner().id);
  }, 20_000);

  /* #1810 item 3 (A-R5 = A-S4): the lister is read, then the DKIM key is
     looked up, then the receipt is filed. Each test holds the key lookup open,
     changes the sender row meanwhile, and releases it. */
  async function arriveWhileHolding(uidValidity: bigint, from: string, during: () => Promise<void>) {
    let entered!: () => void;
    const reached = new Promise<void>((resolve) => { entered = resolve; });
    let release!: () => void;
    fixtureDnsGate.wait = new Promise<void>((resolve) => { release = resolve; });
    fixtureDnsGate.entered = entered;
    const arriving = arrive(uidValidity, from, { document: true }).then(() => "finished" as const);
    try {
      const first = await Promise.race([reached.then(() => "held" as const), arriving]);
      if (first === "finished") throw new Error("the arrival finished without reaching a key lookup");
      await during();
    } finally {
      fixtureDnsGate.wait = undefined;
      fixtureDnsGate.entered = undefined;
      release();
    }
    await arriving;
  }
  const receiptsOf = (userId: string) => getDb().select().from(imapIngestionMessages).where(eq(imapIngestionMessages.userId, userId));
  const allReceipts = () => getDb().select().from(imapIngestionMessages);

  it("1810 item 3: a row verified while its mail is being filed leaves no dangling marker, and the mail is addable", async () => {
    const session = await memberWithUncheckedSecond();
    expect((await sendCheck(session, { id: await idOf(member().id, SECOND) })).status).toBe(202);
    const token = tokenIn(checkMails()[0].text);

    await arriveWhileHolding(3101n, SECOND, async () => {
      expect((await openLink(session, token)).headers.get("location")).toContain("sender=verified");
    });

    const [receipt] = await receiptsOf(member().id);
    expect(receipt.heldSenderAddressId).toBeNull();
    const [item] = await heldItems(member().id);
    expect(item.needsSenderCheck).toBe(false);
    expect(item.canApprove).toBe(true);
    const response = await assignHousehold(session, item.id);
    if (response.status === 409) expect((await errorOf(response)).code).not.toBe("sender_unchecked");
    else expect(response.status).toBe(200);
  }, 30_000);

  it("1810 item 3: a row removed while its mail is being filed takes the mail with it: a stranger's, held for nobody", async () => {
    const session = await memberWithUncheckedSecond();
    const id = await idOf(member().id, SECOND);

    await arriveWhileHolding(3102n, SECOND, async () => {
      expect((await removeRow(session, id)).status).toBeLessThan(300);
    });

    expect(await receiptsOf(member().id)).toHaveLength(0);
    expect(await heldItems(member().id)).toHaveLength(0);
    for (const row of await allReceipts()) expect(row.heldSenderAddressId).toBeNull();
  }, 30_000);

  it("1810 item 3: a row swept while its mail is being filed takes the mail with it", async () => {
    await memberWithUncheckedSecond();
    await backdate(member().id, SECOND, 15);

    await arriveWhileHolding(3103n, SECOND, async () => {
      await purgeExpiredImapStaging(new Date());
      expect((await listSenderAddresses(member().id)).map((row) => row.address)).toEqual([member().email]);
    });

    expect(await receiptsOf(member().id)).toHaveLength(0);
    expect(await heldItems(member().id)).toHaveLength(0);
    for (const row of await allReceipts()) expect(row.heldSenderAddressId).toBeNull();
  }, 30_000);

  it("1810 item 3: removing a row waits for a filer holding its row lock, then detaches the receipt that filer wrote", async () => {
    const session = await memberWithUncheckedSecond();
    const id = await idOf(member().id, SECOND);
    let locked!: () => void;
    const isLocked = new Promise<void>((resolve) => { locked = resolve; });
    let commit!: () => void;
    const mayCommit = new Promise<void>((resolve) => { commit = resolve; });
    const filer = getDb().transaction(async (tx) => {
      await tx.execute(sql`select id from mail_in_sender_addresses where id = ${id} for share`);
      locked();
      await mayCommit;
      await insertHeldReceipt(tx, member().id, id);
    });
    await isLocked;
    const removing = removeRow(session, id);
    /* Wait until the removal is blocked on the lock (bounded), then let the filer commit. */
    for (let tries = 0; tries < 100; tries += 1) {
      const waiting = await getDb().execute(sql`select count(*)::int as n from pg_stat_activity where wait_event_type = 'Lock'`);
      if (Number((waiting as unknown as Array<{ n: number }>)[0].n) > 0) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    commit();
    await filer;

    expect((await removing).status).toBeLessThan(300);
    const rows = await allReceipts();
    expect(rows).toHaveLength(1);
    expect(rows[0].userId).toBeNull();
    expect(rows[0].receiptStatus).toBe("cancelled");
  }, 30_000);

  /* #1810 item 1 (A-S1), design A (owner, 2026-11-11): an envelope-only hold.
     Nothing about mail from an unchecked address is fetched, extracted,
     stored or previewable until the address is proven; the proof releases it
     through the update the pause resume uses. */
  const attachmentRowsOf = async (receiptId: string) =>
    getDb().select().from(imapIngestionAttachments).where(eq(imapIngestionAttachments.messageId, receiptId));
  const secondCycle = async () => {
    const config = await getImapIngestionConfig();
    await withRequiredScanMode(() => runImapIngestionCycle(config, {
      smtpConfig: () => ({ smtpUrl: "smtps://smtp.example.test", smtpFrom: "orbit@example.test" }) as never,
      sendMail: async (message: { to: string; subject: string; text: string }) => { replies.push(message); },
    }));
  };
  const rowOf = async (receiptId: string) =>
    (await getDb().select().from(imapIngestionMessages).where(eq(imapIngestionMessages.id, receiptId)))[0];

  it("1810 item 1: files the receipt held and cancelled under the claimed row, with nothing staged", async () => {
    await memberWithUncheckedSecond();

    await arrive(3201n, SECOND, { document: true });

    const [receipt] = await receiptsOf(member().id);
    expect(receipt.status).toBe("held");
    expect(receipt.receiptStatus).toBe("cancelled");
    expect(receipt.heldSenderAddressId).toBe(await idOf(member().id, SECOND));
    expect(await attachmentRowsOf(receipt.id)).toHaveLength(0);
    expect(await getDb().select().from(imapIngestionAttachments)).toHaveLength(0);
  }, 30_000);

  it("1810 item 1: the inbox list shows the held card with no draft, no evidence, no attachment names and attachmentCount 0", async () => {
    await memberWithUncheckedSecond();
    await arrive(3202n, SECOND, { document: true });

    const [item] = await heldItems(member().id) as unknown as Array<{
      needsSenderCheck: boolean; attachmentCount: number; attachments: unknown[]; proposal: unknown; fieldEvidence?: unknown;
    }>;

    expect(item.needsSenderCheck).toBe(true);
    expect(item.attachmentCount).toBe(0);
    expect(item.attachments).toHaveLength(0);
    expect(item.proposal).toEqual({});
    expect(item.fieldEvidence ?? {}).toEqual({});
  }, 30_000);

  it("1810 item 1 PIN: the review read returns no draft and no attachments for the held receipt (fixture mail has no extractable draft, so passes on current code too)", async () => {
    await memberWithUncheckedSecond();
    await arrive(3203n, SECOND, { document: true });
    const [receipt] = await receiptsOf(member().id);
    /* A held receipt has no household yet (the add is refused); the review read
       is reachable only for one that carries it, so give it one directly. */
    await getDb().update(imapIngestionMessages).set({ householdId: fixture.household.id }).where(eq(imapIngestionMessages.id, receipt.id));

    const review = await getImapReview(member().id, receipt.id, fixture.household.id) as unknown as {
      proposal?: unknown; metadata?: unknown; attachments?: unknown[]; fieldEvidence?: unknown;
    };

    expect(review.proposal ?? review.metadata ?? {}).toEqual({});
    expect(review.attachments ?? []).toEqual([]);
    expect(review.fieldEvidence ?? {}).toEqual({});
  }, 30_000);

  it("1810 item 1: the held attachment preview is refused as not found", async () => {
    await memberWithUncheckedSecond();
    await arrive(3204n, SECOND, { document: true });
    const [receipt] = await receiptsOf(member().id);

    /* Under design A no attachment row exists; until then use the real one so a
       refusal can only come from the hold, not from a made-up id. */
    const [stored] = await attachmentRowsOf(receipt.id);

    await expect(readHeldImapAttachmentPreview(member().id, receipt.id, stored?.id ?? UNKNOWN_ID)).rejects.toMatchObject({ code: "inbox_receipt_not_found", status: 404 });
  }, 30_000);

  it("1810 item 1: proving the address releases the mail to processing, and one worker cycle makes it addable with its draft", async () => {
    const session = await memberWithUncheckedSecond();
    await arrive(3205n, SECOND, { document: true });
    const [held] = await receiptsOf(member().id);
    expect(held.status).toBe("held");

    expect((await openLink(session, tokenIn(checkMails()[0].text))).headers.get("location")).toContain("sender=verified");

    const released = await rowOf(held.id);
    expect(released.status).toBe("processing");
    expect(released.receiptStatus).toBe("processing");
    expect(released.heldSenderAddressId).toBeNull();

    await secondCycle();

    const done = await rowOf(held.id);
    expect(done.status).toBe("pending_review");
    expect(await attachmentRowsOf(held.id)).toHaveLength(1);
    const [item] = await heldItems(member().id) as unknown as Array<{ canApprove: boolean; needsSenderCheck: boolean; attachmentCount: number }>;
    expect(item.needsSenderCheck).toBe(false);
    expect(item.canApprove).toBe(true);
    expect(item.attachmentCount).toBe(1);
  }, 40_000);

  it("1810 item 1: a member who paused: proving the address leaves the mail held, unmarked, and the resume releases it", async () => {
    const session = await memberWithUncheckedSecond();
    await arrive(3206n, SECOND, { document: true });
    const [held] = await receiptsOf(member().id);
    expect(held.status).toBe("held");
    expect(held.heldSenderAddressId).not.toBeNull();
    await setRelayIngestPaused(member().id, true);

    expect((await openLink(session, tokenIn(checkMails()[0].text))).headers.get("location")).toContain("sender=verified");

    const afterProof = await rowOf(held.id);
    expect(afterProof.status).toBe("held");
    expect(afterProof.heldSenderAddressId).toBeNull();

    await setRelayIngestPaused(member().id, false);

    expect((await rowOf(held.id)).status).toBe("processing");
  }, 40_000);

  it("1810 item 1: a resume does not release mail whose address is still unchecked", async () => {
    await memberWithUncheckedSecond();
    await arrive(3207n, SECOND, { document: true });
    const [held] = await receiptsOf(member().id);
    const rowId = await idOf(member().id, SECOND);
    expect(held.status).toBe("held");
    expect(held.heldSenderAddressId).toBe(rowId);
    await setRelayIngestPaused(member().id, true);

    await setRelayIngestPaused(member().id, false);

    const after = await rowOf(held.id);
    expect(after.status).toBe("held");
    expect(after.heldSenderAddressId).toBe(rowId);
  }, 30_000);

  /* #1810 review: a dismiss that read the envelope-only hold, and then lost the
     row to a verify releasing it, must not answer success while the mail comes
     back addable a cycle later. The release is made to land between dismiss's
     read and its write by holding the receipt's row lock until dismiss waits. */
  it("1810 review: a dismiss racing the verify's release is refused (409, retry), and the released mail can then be dismissed", async () => {
    await memberWithUncheckedSecond();
    await arrive(3208n, SECOND, { document: true });
    const [held] = await receiptsOf(member().id);
    expect(held.status).toBe("held");
    let locked!: () => void;
    const isLocked = new Promise<void>((resolve) => { locked = resolve; });
    let commit!: () => void;
    const mayCommit = new Promise<void>((resolve) => { commit = resolve; });
    /* Stands in for verify's release: the update a resume applies. */
    const releaser = getDb().transaction(async (tx) => {
      await tx.execute(sql`select id from imap_ingestion_messages where id = ${held.id} for update`);
      locked();
      await mayCommit;
      await tx.update(imapIngestionMessages).set({
        status: "processing", receiptStatus: "processing", heldSenderAddressId: null,
        attachmentProcessingNextAttemptAt: new Date(), updatedAt: new Date(),
      }).where(eq(imapIngestionMessages.id, held.id));
    });
    await isLocked;
    const dismissing = discardImapReviewItem(member().id, held.id).then(
      () => ({ ok: true as const }),
      (error: { code?: string; status?: number }) => ({ ok: false as const, code: error.code, status: error.status }),
    );
    let blocked = false;
    for (let tries = 0; tries < 100 && !blocked; tries += 1) {
      const waiting = await getDb().execute(sql`select count(*)::int as n from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'`);
      blocked = Number((waiting as unknown as Array<{ n: number }>)[0].n) > 0;
      if (!blocked) await new Promise((resolve) => setTimeout(resolve, 50));
    }
    commit();
    await releaser;

    expect(blocked, "the dismiss reached its write while the row was locked").toBe(true);
    expect(await dismissing).toEqual({ ok: false, code: "staging_cleanup_busy", status: 409 });
    expect((await rowOf(held.id)).status).toBe("processing");

    await secondCycle();
    expect((await rowOf(held.id)).status).toBe("pending_review");
    await discardImapReviewItem(member().id, held.id);
    expect((await rowOf(held.id)).status).toBe("discarded");
  }, 40_000);
});

/* ------------------------------------------------------------------------- */
/* The settings payload: state and days left per row                         */
/* ------------------------------------------------------------------------- */

describe("the settings payload carries each row's state and days left", () => {
  type Sender = { address: string; verified: boolean; verificationPending: boolean; source: string; daysLeft?: number | null };
  const sendersOf = async (userId: string) =>
    (await readRelaySettings({ id: userId, isInstanceAdmin: false }) as unknown as { senders: Sender[] }).senders;

  it("lists seeded first, then extras in the order added, each with its state", async () => {
    const session = await fixture.session("member");
    await seedSenderAddress(member().id);
    /* #1813: passMinute freezes Date, so each add gets its own clock reading;
       rows added on one frozen instant tie on created_at. */
    passMinute();
    await addAndVerify(session, member().id, SECOND);
    expect((await addAddress(session, THIRD)).status).toBeLessThan(300);
    passMinute();
    const fourth = "harlow-fourth-box@example.test";
    expect((await addAddress(session, fourth)).status).toBeLessThan(300);
    passMinute();
    expect((await sendCheck(session, { id: await idOf(member().id, fourth) })).status).toBe(202);

    const senders = await sendersOf(member().id);

    expect(senders.map((row) => row.address)).toEqual([member().email, SECOND, THIRD, fourth]);
    expect(senders.map((row) => [row.source, row.verified, row.verificationPending])).toEqual([
      [expect.stringMatching(/^(account|sso)$/), false, false],
      ["manual", true, false],
      ["manual", false, false],
      ["manual", false, true],
    ]);
  });

  it("gives an unchecked extra row its whole days left, and the seeded and checked rows none", async () => {
    const session = await fixture.session("member");
    await seedSenderAddress(member().id);
    await addAndVerify(session, member().id, SECOND);
    expect((await addAddress(session, THIRD)).status).toBeLessThan(300);
    const fourth = "harlow-fourth-box@example.test";
    expect((await addAddress(session, fourth)).status).toBeLessThan(300);
    await backdate(member().id, THIRD, 5);
    await backdate(member().id, fourth, 13.5);
    await getDb().update(mailInSenderAddresses).set({ createdAt: daysAgo(100) }).where(eq(mailInSenderAddresses.id, await idOf(member().id, member().email)));

    const senders = await sendersOf(member().id);
    const left = (address: string) => senders.find((row) => row.address === address)?.daysLeft ?? null;

    expect(left(member().email)).toBeNull();
    expect(left(SECOND)).toBeNull();
    expect(left(THIRD)).toBe(9);
    expect(left(fourth)).toBe(1);
  });

  it("says 14 days for a row added just now", async () => {
    const session = await fixture.session("member");
    await seedSenderAddress(member().id);
    expect((await addAddress(session, SECOND)).status).toBeLessThan(300);
    const response = await callRouteForSession((await loadRoute("settings/mail-relay")).GET, session, { url: ROOT });
    const body = await response.json() as { relay: { senders: Sender[] } };
    expect(body.relay.senders.find((row) => row.address === SECOND)?.daysLeft).toBe(14);
  });
});

/* ------------------------------------------------------------------------- */
/* Review findings                                                           */
/* ------------------------------------------------------------------------- */

describe("removing a row does not reset the member's send history (review 1)", () => {
  it("refuses a check inside the minute after add, send, remove, re-add", async () => {
    const session = await fixture.session("member");
    await seedSenderAddress(member().id);
    expect((await addAddress(session, SECOND)).status).toBeLessThan(300);
    passMinute();
    expect((await sendCheck(session, { id: await idOf(member().id, SECOND) })).status).toBe(202);
    expect((await removeRow(session, await idOf(member().id, SECOND))).status).toBeLessThan(300);
    expect((await addAddress(session, SECOND)).status).toBeLessThan(300);

    const again = await sendCheck(session, { id: await idOf(member().id, SECOND) });

    expect(again.status).toBe(429);
    expect((await errorOf(again)).code).toBe("sender_check_too_soon");
    expect(mail.sent).toHaveLength(1);
  });

  it("sends at most five check mails in a day across any add and remove loop", async () => {
    const session = await fixture.session("member");
    await seedSenderAddress(member().id);
    const statuses: number[] = [];
    for (let round = 0; round < 7; round += 1) {
      expect((await addAddress(session, SECOND)).status).toBeLessThan(300);
      passMinute();
      statuses.push((await sendCheck(session, { id: await idOf(member().id, SECOND) })).status);
      expect((await removeRow(session, await idOf(member().id, SECOND))).status).toBeLessThan(300);
    }
    expect(mail.sent).toHaveLength(5);
    expect(statuses).toEqual([202, 202, 202, 202, 202, 429, 429]);
  });

  it("keeps the history when the sweep removes the row too", async () => {
    const session = await fixture.session("member");
    await seedSenderAddress(member().id);
    expect((await addAddress(session, SECOND)).status).toBeLessThan(300);
    passMinute();
    expect((await sendCheck(session, { id: await idOf(member().id, SECOND) })).status).toBe(202);
    /* Past the 15 days no row outlives (#1810 item 5), so the sweep removes it
       although the link sent just now is still good. */
    await backdate(member().id, SECOND, 16);
    await purgeExpiredImapStaging(new Date());
    expect(await idOf(member().id, SECOND).catch(() => null)).toBeNull();
    expect((await addAddress(session, SECOND)).status).toBeLessThan(300);
    const again = await sendCheck(session, { id: await idOf(member().id, SECOND) });
    expect(again.status).toBe(429);
  });
});

describe("a sign-in address that changes to one already on the extra list (review 2)", () => {
  async function changeSignIn(userId: string, email: string) {
    const cipher = await requireInstanceMetadataWriter();
    await getDb().update(users).set({
      emailEnc: cipher.encryptText("users.email", userId, email),
      emailIndex: cipher.emailIndex(email),
    }).where(eq(users.id, userId));
  }
  const relayOf = async () => await readRelaySettings({ id: member().id, isInstanceAdmin: false }) as unknown as { sender: { address: string } | null; senders: Array<{ id: string; address: string; source: string }> };

  it("makes that row the seeded one: account or sso source, `sender` is it, no second row", async () => {
    const session = await fixture.session("member");
    await seedSenderAddress(member().id);
    expect((await addAddress(session, SECOND)).status).toBeLessThan(300);

    await changeSignIn(member().id, SECOND);
    const relay = await relayOf();

    expect(relay.sender?.address).toBe(SECOND);
    expect(relay.senders.map((row) => row.address)).toEqual([SECOND]);
    expect(relay.senders[0].source).toMatch(/^(account|sso)$/);
  });

  it("is then not removable (409 sender_address_seeded) and never swept", async () => {
    const session = await fixture.session("member");
    await seedSenderAddress(member().id);
    expect((await addAddress(session, SECOND)).status).toBeLessThan(300);
    await changeSignIn(member().id, SECOND);
    const [row] = (await relayOf()).senders;

    const response = await removeRow(session, row.id);

    expect(response.status).toBe(409);
    expect((await errorOf(response)).code).toBe("sender_address_seeded");
    await getDb().update(mailInSenderAddresses).set({ createdAt: daysAgo(400) }).where(eq(mailInSenderAddresses.id, row.id));
    await purgeExpiredImapStaging(new Date());
    expect((await relayOf()).senders.map((one) => one.address)).toEqual([SECOND]);
  });

  it("counts five real rows afterwards: the fifth is accepted and the sixth refused", async () => {
    const session = await fixture.session("member");
    await seedSenderAddress(member().id);
    const extras = ["chg-one", "chg-two", "chg-three"].map((name) => `${name}@example.test`);
    for (const address of [SECOND, ...extras]) expect((await addAddress(session, address)).status).toBeLessThan(300);

    await changeSignIn(member().id, SECOND);
    expect((await relayOf()).senders).toHaveLength(4);

    expect((await addAddress(session, "chg-four@example.test")).status).toBeLessThan(300);
    const sixth = await addAddress(session, "chg-five@example.test");
    expect(sixth.status).toBe(409);
    expect((await errorOf(sixth)).code).toBe("sender_address_limit");
  });
});

describe("two members verifying the same address at once (review 5)", () => {
  async function bothHoldChecks() {
    const a = await fixture.session("member");
    const b = await fixture.session("owner");
    await seedSenderAddress(member().id);
    await seedSenderAddress(owner().id);
    expect((await addAddress(a, SECOND)).status).toBeLessThan(300);
    expect((await addAddress(b, SECOND)).status).toBeLessThan(300);
    expect((await sendCheck(a, { id: await idOf(member().id, SECOND) })).status).toBe(202);
    expect((await sendCheck(b, { id: await idOf(owner().id, SECOND) })).status).toBe(202);
    return { a, b, aLink: tokenIn(mail.sent[0].text), bLink: tokenIn(mail.sent[1].text) };
  }

  it("lets one win and answers the other without a server error", async () => {
    const { a, b, aLink, bLink } = await bothHoldChecks();

    const outcomes = await Promise.allSettled([openLink(a, aLink), openLink(b, bLink)]);

    for (const outcome of outcomes) {
      expect(outcome.status).toBe("fulfilled");
      expect((outcome as PromiseFulfilledResult<Response>).value.status).toBeLessThan(500);
    }
    const places = outcomes.map((outcome) => (outcome as PromiseFulfilledResult<Response>).value.headers.get("location") ?? "");
    expect(places.filter((place) => place.includes("sender=verified"))).toHaveLength(1);
    expect([member().id, owner().id]).toContain(await userForVerifiedSender(SECOND));
  });

  it.each([["a unique violation", "23505"], ["a deadlock", "40P01"], ["a serialization failure", "40001"]])(
    "maps %s from the database to sender_verification_invalid (400), not a 500",
    async (_label, code) => {
      const { aLink } = await bothHoldChecks();
      const spy = vi.spyOn(getDb(), "transaction").mockRejectedValueOnce(Object.assign(new Error("database said no"), { code }));
      try {
        await expect(verifySenderAddress(member().id, aLink)).rejects.toMatchObject({ code: "sender_verification_invalid", status: 400 });
      } finally {
        spy.mockRestore();
      }
    },
  );
});

/* ------------------------------------------------------------------------- */
/* #1810 item 2 (A-S2 = A-S3): no answer tells a member which addresses are   */
/* verified on the instance                                                  */
/* ------------------------------------------------------------------------- */

describe("1810 item 2: an address another member has verified answers like any other", () => {
  it("adds it as an unchecked row with the same status as an address nobody holds", async () => {
    const a = await fixture.session("member");
    const held = await verifiedSenderFor(owner().id);
    await seedSenderAddress(member().id);

    const heldResponse = await addAddress(a, held);
    const freeResponse = await addAddress(a, SECOND);

    expect(heldResponse.status).toBe(201);
    expect(freeResponse.status).toBe(201);
    type Body = { senders: Array<{ address: string; verified: boolean; verificationPending: boolean; source: string; daysLeft: number | null }> };
    const shape = (body: Body, address: string) => {
      const { address: _address, ...rest } = body.senders.find((row) => row.address === address)!;
      return rest;
    };
    expect(shape(await heldResponse.json() as Body, held)).toMatchObject({ verified: false });
    expect(shape(await freeResponse.json() as Body, SECOND)).toMatchObject({ verified: false });
    const view = await listSenderAddresses(member().id);
    expect(view.find((row) => row.address === held)?.verified).toBe(false);
    expect(view.find((row) => row.address === SECOND)?.verified).toBe(false);
    expect(await userForVerifiedSender(held)).toBe(owner().id);
  });

  async function rowHeldElsewhere(session: IntegrationSession) {
    /* A lists the address first; B then proves it, without the drop having reached A's row. */
    await seedSenderAddress(member().id);
    await seedSenderAddress(owner().id);
    expect((await addAddress(session, owner().email)).status).toBeLessThan(300);
    const id = await idOf(member().id, owner().email);
    await getDb().update(mailInSenderAddresses).set({ verifiedAt: new Date() }).where(eq(mailInSenderAddresses.userId, owner().id));
    return id;
  }

  it("answers the check press 202 with a live expiry, records it, and delivers no mail", async () => {
    const a = await fixture.session("member");
    const id = await rowHeldElsewhere(a);

    const response = await sendCheck(a, { id });

    expect(response.status).toBe(202);
    const body = await response.json() as { expiresAt: string };
    expect(Math.abs(Date.parse(body.expiresAt) - (Date.now() + SENDER_VERIFICATION_TTL_MS))).toBeLessThan(120_000);
    expect(mail.sent).toEqual([]);
    const [row] = await getDb().select().from(mailInSenderAddresses).where(eq(mailInSenderAddresses.id, id));
    expect(row.verificationTokenDigest).not.toBeNull();
    expect(row.verificationExpiresAt).not.toBeNull();
    expect((await listSenderAddresses(member().id)).find((view) => view.id === id)?.verificationPending).toBe(true);
  });

  it("still sends one mail for an address nobody holds", async () => {
    const a = await fixture.session("member");
    await seedSenderAddress(member().id);
    expect((await addAddress(a, SECOND)).status).toBeLessThan(300);

    expect((await sendCheck(a, { id: await idOf(member().id, SECOND) })).status).toBe(202);

    expect(mail.sent.map((message) => message.to)).toEqual([SECOND]);
  });

  it("counts the undelivered check against the daily five", async () => {
    const a = await fixture.session("member");
    const id = await rowHeldElsewhere(a);
    expect((await addAddress(a, SECOND)).status).toBeLessThan(300);

    for (let press = 0; press < 5; press += 1) {
      passMinute();
      expect((await sendCheck(a, { id })).status).toBe(202);
    }
    passMinute();
    const sixth = await sendCheck(a, { id: await idOf(member().id, SECOND) });

    expect(sixth.status).toBe(429);
    expect((await errorOf(sixth)).code).toBe("sender_check_daily_limit");
    expect(mail.sent).toEqual([]);
  });

  it("leaves the verified holder's row alone, and the prober's row lapses with the 14-day sweep", async () => {
    const a = await fixture.session("member");
    const id = await rowHeldElsewhere(a);
    expect((await sendCheck(a, { id })).status).toBe(202);
    await backdate(member().id, owner().email, 15);
    advanceClock(SENDER_VERIFICATION_TTL_MS + 60_000);

    await purgeExpiredImapStaging(new Date());

    expect((await listSenderAddresses(member().id)).map((row) => row.address)).toEqual([member().email]);
    expect(await userForVerifiedSender(owner().email)).toBe(owner().id);
  });
});

/* ------------------------------------------------------------------------- */
/* #1810 item 4 (run1 A-S1): a Settings read never deletes a damaged row      */
/* ------------------------------------------------------------------------- */

describe("1810 item 4: a damaged extra sender row is kept, listed unreadable, and removable", () => {
  async function damage(id: string) {
    const [row] = await getDb().select().from(mailInSenderAddresses).where(eq(mailInSenderAddresses.id, id));
    if (!row.addressEnc) throw new Error("the row holds no encrypted address to damage");
    await getDb().update(mailInSenderAddresses).set({ addressEnc: damageEnvelope(row.addressEnc) }).where(eq(mailInSenderAddresses.id, id));
  }
  const readSettings = () => readRelaySettings({ id: member().id, isInstanceAdmin: false });

  it("keeps a checked damaged row through a Settings read, still unreadable, still verified, still attributing", async () => {
    const session = await fixture.session("member");
    await seedSenderAddress(member().id);
    const id = await addAndVerify(session, member().id, SECOND);
    await damage(id);

    await readSettings();

    const row = (await listSenderAddresses(member().id)).find((view) => view.id === id);
    expect(row).toBeDefined();
    expect(row?.address).toBeNull();
    expect(row?.verified).toBe(true);
    expect(row?.metadataStatus?.address).toBe("metadata_integrity_failed");
    expect(await getDb().select({ id: mailInSenderAddresses.id }).from(mailInSenderAddresses).where(eq(mailInSenderAddresses.id, id))).toHaveLength(1);
    expect(await userForVerifiedSender(SECOND)).toBe(member().id);
  });

  it("keeps mail held under a damaged unchecked row, still the member's", async () => {
    const session = await fixture.session("member");
    await seedSenderAddress(member().id);
    expect((await addAddress(session, SECOND)).status).toBeLessThan(300);
    const id = await idOf(member().id, SECOND);
    const receiptId = await insertHeldReceipt(getDb(), member().id, id);
    await damage(id);

    await readSettings();

    const [receipt] = await getDb().select().from(imapIngestionMessages).where(eq(imapIngestionMessages.id, receiptId));
    expect(receipt.userId).toBe(member().id);
    expect(receipt.heldSenderAddressId).toBe(id);
    expect(await getDb().select({ id: mailInSenderAddresses.id }).from(mailInSenderAddresses).where(eq(mailInSenderAddresses.id, id))).toHaveLength(1);
  });

  it("PIN: the member can remove the damaged row, and its held mail is detached", async () => {
    const session = await fixture.session("member");
    await seedSenderAddress(member().id);
    expect((await addAddress(session, SECOND)).status).toBeLessThan(300);
    const id = await idOf(member().id, SECOND);
    const receiptId = await insertHeldReceipt(getDb(), member().id, id);
    await damage(id);

    const response = await removeRow(session, id);

    expect(response.status).toBe(200);
    expect(await getDb().select({ id: mailInSenderAddresses.id }).from(mailInSenderAddresses).where(eq(mailInSenderAddresses.id, id))).toHaveLength(0);
    const [receipt] = await getDb().select().from(imapIngestionMessages).where(eq(imapIngestionMessages.id, receiptId));
    expect(receipt.userId).toBeNull();
    expect(receipt.receiptStatus).toBe("cancelled");
  });

  it("repairs a damaged manual row whose index is the registered address: same id, verified state and held mail kept", async () => {
    const session = await fixture.session("member");
    await seedSenderAddress(member().id);
    const id = await addAndVerify(session, member().id, SECOND);
    const receiptId = await insertHeldReceipt(getDb(), member().id, id);
    await damage(id);
    const cipher = await requireInstanceMetadataWriter();
    await getDb().update(users).set({
      emailEnc: cipher.encryptText("users.email", member().id, SECOND),
      emailIndex: cipher.emailIndex(SECOND),
    }).where(eq(users.id, member().id));

    const relay = await readSettings() as unknown as { senders: Array<{ id: string; address: string; source: string; verified: boolean }> };

    const rows = await rowsOf(member().id);
    const onIndex = rows.filter((row) => row.addressIndex === (rows.find((one) => one.id === id)?.addressIndex ?? "none"));
    expect(onIndex).toHaveLength(1);
    expect(onIndex[0].id).toBe(id);
    expect(onIndex[0].source).toMatch(/^(account|sso)$/);
    expect(relay.senders.find((row) => row.id === id)).toMatchObject({ address: SECOND, verified: true });
    const [receipt] = await getDb().select().from(imapIngestionMessages).where(eq(imapIngestionMessages.id, receiptId));
    expect(receipt.heldSenderAddressId).toBe(id);
    expect(receipt.userId).toBe(member().id);
  });
});

/* ------------------------------------------------------------------------- */
/* #1810 R1: the Settings read carries a damaged row, so it can be seen and  */
/* removed                                                                   */
/* ------------------------------------------------------------------------- */

describe("1810 R1: readRelaySettings lists a damaged extra row with its id and metadataStatus", () => {
  async function damage(id: string) {
    const [row] = await getDb().select().from(mailInSenderAddresses).where(eq(mailInSenderAddresses.id, id));
    if (!row.addressEnc) throw new Error("the row holds no encrypted address to damage");
    await getDb().update(mailInSenderAddresses).set({ addressEnc: damageEnvelope(row.addressEnc) }).where(eq(mailInSenderAddresses.id, id));
  }
  type Row = { id: string; source: string; address?: string | null; verified: boolean; metadataStatus?: { address?: string } };
  const sendersOfRead = async () => (await readRelaySettings({ id: member().id, isInstanceAdmin: false })).senders as unknown as Row[];

  it("an unchecked damaged row is in `senders` with its id and metadata_integrity_failed", async () => {
    const session = await fixture.session("member");
    await seedSenderAddress(member().id);
    expect((await addAddress(session, SECOND)).status).toBeLessThan(300);
    const id = await idOf(member().id, SECOND);
    await damage(id);

    const row = (await sendersOfRead()).find((one) => one.id === id);

    expect(row).toBeDefined();
    expect(row?.metadataStatus?.address).toBe("metadata_integrity_failed");
    expect(row?.source).toBe("manual");
    expect(row?.verified).toBe(false);
  });

  it("a checked damaged row is listed too, still verified", async () => {
    const session = await fixture.session("member");
    await seedSenderAddress(member().id);
    const id = await addAndVerify(session, member().id, SECOND);
    await damage(id);

    const row = (await sendersOfRead()).find((one) => one.id === id);

    expect(row?.metadataStatus?.address).toBe("metadata_integrity_failed");
    expect(row?.verified).toBe(true);
  });

  it("the id the read gave removes the damaged row (200), and the next read no longer lists it", async () => {
    const session = await fixture.session("member");
    await seedSenderAddress(member().id);
    expect((await addAddress(session, SECOND)).status).toBeLessThan(300);
    await damage(await idOf(member().id, SECOND));
    const listed = (await sendersOfRead()).find((one) => one.metadataStatus?.address === "metadata_integrity_failed");
    expect(listed, "the damaged row is in the read").toBeDefined();

    const response = await removeRow(session, listed!.id);

    expect(response.status).toBe(200);
    expect((await sendersOfRead()).find((one) => one.id === listed!.id)).toBeUndefined();
  });

  it("PIN: a healthy row carries no metadataStatus, and the sign-in row is still first", async () => {
    const session = await fixture.session("member");
    await seedSenderAddress(member().id);
    expect((await addAddress(session, SECOND)).status).toBeLessThan(300);

    const rows = await sendersOfRead();

    expect(rows.map((one) => one.address)).toEqual([member().email, SECOND]);
    expect(rows.every((one) => one.metadataStatus === undefined)).toBe(true);
  });
});

/* ------------------------------------------------------------------------- */
/* #1810 R2: the check press answers at once for every row; the mail goes     */
/* afterwards and its failures are the administrator's                        */
/* ------------------------------------------------------------------------- */

describe("1810 R2: the check press answers 202 before the mail is sent", () => {
  async function rowHeldElsewhere(session: IntegrationSession) {
    await seedSenderAddress(member().id);
    await seedSenderAddress(owner().id);
    expect((await addAddress(session, owner().email)).status).toBeLessThan(300);
    const id = await idOf(member().id, owner().email);
    await getDb().update(mailInSenderAddresses).set({ verifiedAt: new Date() }).where(eq(mailInSenderAddresses.userId, owner().id));
    return id;
  }
  async function freeRow(session: IntegrationSession) {
    await seedSenderAddress(member().id);
    expect((await addAddress(session, SECOND)).status).toBeLessThan(300);
    return idOf(member().id, SECOND);
  }
  const rowOfId = async (id: string) => (await getDb().select().from(mailInSenderAddresses).where(eq(mailInSenderAddresses.id, id)))[0];
  const senderWarns = (spy: { mock: { calls: unknown[][] } }) =>
    spy.mock.calls.filter((call) => (call[0] as { event?: string } | undefined)?.event === "mail-relay.sender");

  it.each([
    ["a row another member holds verified", rowHeldElsewhere],
    ["a free row", freeRow],
  ])("%s: answers 202 with expiresAt about now + 24h while sendMail is still blocked", async (_name, makeRow) => {
    const session = await fixture.session("member");
    const id = await makeRow(session);
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const sendMail = vi.fn(async () => { await gate; });
    const timedOut = Symbol("blocked behind the mailer");

    try {
      const answer = await Promise.race([
        requestSenderCheck(member().id, { sendMail }, id),
        new Promise<symbol>((resolve) => setTimeout(() => resolve(timedOut), 3_000)),
      ]);

      expect(answer, "the press waited for the mailer").not.toBe(timedOut);
      const { expiresAt } = answer as { expiresAt: Date };
      expect(Math.abs(expiresAt.getTime() - (Date.now() + SENDER_VERIFICATION_TTL_MS))).toBeLessThan(120_000);
    } finally {
      release();
    }
  });

  it("a free row: the mail is sent after the answer, once", async () => {
    const session = await fixture.session("member");
    const id = await freeRow(session);
    const sendMail = vi.fn(async () => {});

    await requestSenderCheck(member().id, { sendMail }, id);

    await vi.waitFor(() => expect(sendMail).toHaveBeenCalledTimes(1));
  });

  it("a mailer that rejects: the press still answers 202, the row keeps this press's token and expiry, one mail-relay.sender warning", async () => {
    const session = await fixture.session("member");
    const id = await freeRow(session);
    const warn = vi.spyOn(log, "warn").mockImplementation(() => undefined);
    try {
      const sendMail = vi.fn(async () => { throw new Error("smtp down"); });

      const answer = await requestSenderCheck(member().id, { sendMail }, id);

      expect(answer.expiresAt.getTime()).toBeGreaterThan(Date.now());
      await vi.waitFor(() => expect(senderWarns(warn)).toHaveLength(1));
      const row = await rowOfId(id);
      expect(row.verificationTokenDigest).not.toBeNull();
      expect(row.verificationExpiresAt?.getTime()).toBe(answer.expiresAt.getTime());
      expect(senderWarns(warn)).toHaveLength(1);
    } finally {
      warn.mockRestore();
    }
  });

  it("five refused presses count: the sixth is 429 sender_check_daily_limit", async () => {
    const session = await fixture.session("member");
    const id = await freeRow(session);
    const warn = vi.spyOn(log, "warn").mockImplementation(() => undefined);
    try {
      const sendMail = async () => { throw new Error("smtp down"); };
      for (let press = 0; press < 5; press += 1) {
        passMinute();
        await requestSenderCheck(member().id, { sendMail }, id);
      }
      passMinute();

      await expect(requestSenderCheck(member().id, { sendMail }, id)).rejects.toMatchObject({ code: "sender_check_daily_limit", status: 429 });
    } finally {
      warn.mockRestore();
    }
  });

  it.each([
    ["a row another member holds verified", rowHeldElsewhere],
    ["a free row", freeRow],
  ])("PIN, %s: no mailer configured is 503 smtp_not_configured, and nothing was reserved", async (_name, makeRow) => {
    const session = await fixture.session("member");
    const id = await makeRow(session);
    await clearSending();

    const response = await sendCheck(session, { id });

    expect(response.status).toBe(503);
    expect((await errorOf(response)).code).toBe("smtp_not_configured");
    const row = await rowOfId(id);
    expect(row.verificationTokenDigest).toBeNull();
    expect(row.verificationExpiresAt).toBeNull();
    expect(row.checkSentAt).toEqual([]);
  });
});

/* ------------------------------------------------------------------------- */
/* #1810 item 5 (FIX-S1): a daily re-send cannot keep an unchecked row alive  */
/* ------------------------------------------------------------------------- */

describe("1810 item 5: no check can be sent once the 14 days have passed", () => {
  const LAPSED_WORDS = "not sent \u2014 that address was not checked within 14 days and is being removed. add it again";

  it("refuses a send past day 14 with 409 sender_address_lapsed and sends nothing, then the sweep removes the row and its mail", async () => {
    const session = await fixture.session("member");
    await seedSenderAddress(member().id);
    expect((await addAddress(session, SECOND)).status).toBeLessThan(300);
    const id = await idOf(member().id, SECOND);
    const receiptId = await insertHeldReceipt(getDb(), member().id, id);
    await backdate(member().id, SECOND, 13.5);
    expect((await sendCheck(session, { id })).status).toBe(202);

    advanceClock(0.9 * DAY);
    /* The clock move ends the earlier sign-in: press with a fresh session. */
    const late = await sendCheck(await fixture.session("member"), { id });

    expect(late.status).toBe(409);
    const error = await errorOf(late);
    expect(error.code).toBe("sender_address_lapsed");
    expect(error.message).toBe(LAPSED_WORDS);
    expect(mail.sent).toHaveLength(1);

    advanceClock(0.2 * DAY);
    await purgeExpiredImapStaging(new Date());
    expect((await listSenderAddresses(member().id)).map((row) => row.address)).toEqual([member().email]);
    const [receipt] = await getDb().select().from(imapIngestionMessages).where(eq(imapIngestionMessages.id, receiptId));
    expect(receipt.userId).toBeNull();
  });

  it("no row outlives 15 days: a row past that with a live link is removed", async () => {
    const session = await fixture.session("member");
    await seedSenderAddress(member().id);
    expect((await addAddress(session, THIRD)).status).toBeLessThan(300);
    await backdate(member().id, THIRD, 15.1);
    await getDb().update(mailInSenderAddresses).set({
      verificationTokenDigest: "f".repeat(64),
      verificationExpiresAt: new Date(Date.now() + DAY),
    }).where(eq(mailInSenderAddresses.id, await idOf(member().id, THIRD)));

    await purgeExpiredImapStaging(new Date());

    expect((await listSenderAddresses(member().id)).map((row) => row.address)).toEqual([member().email]);
  });

  it("a send every day cannot extend the row: the press on day 14 is refused and the row then goes", async () => {
    const session = await fixture.session("member");
    await seedSenderAddress(member().id);
    expect((await addAddress(session, "renew-fourth@example.test")).status).toBeLessThan(300);
    const id = await idOf(member().id, "renew-fourth@example.test");

    for (let day = 0; day < 14; day += 1) {
      /* The clock move ends the earlier sign-in: press with a fresh session. */
      expect((await sendCheck(await fixture.session("member"), { id })).status, `press on day ${day}`).toBe(202);
      advanceClock(DAY);
    }
    const fourteenth = await sendCheck(await fixture.session("member"), { id });

    expect(fourteenth.status).toBe(409);
    expect((await errorOf(fourteenth)).code).toBe("sender_address_lapsed");
    expect(mail.sent).toHaveLength(14);
    advanceClock(DAY);
    await purgeExpiredImapStaging(new Date());
    expect((await listSenderAddresses(member().id)).map((row) => row.address)).toEqual([member().email]);
  }, 30_000);

  it("days left: 1 for an overdue row with a good link, 0 once the link has lapsed, never more than 1 whatever the stored expiry", async () => {
    const session = await fixture.session("member");
    await seedSenderAddress(member().id);
    expect((await addAddress(session, SECOND)).status).toBeLessThan(300);
    const id = await idOf(member().id, SECOND);
    const daysLeft = async () => (await listSenderAddresses(member().id)).find((row) => row.id === id)?.daysLeft;
    await backdate(member().id, SECOND, 13.5);
    expect((await sendCheck(session, { id })).status).toBe(202);

    advanceClock(0.9 * DAY);
    expect(await daysLeft()).toBe(1);

    await getDb().update(mailInSenderAddresses).set({ verificationExpiresAt: new Date(Date.now() + 10 * DAY) }).where(eq(mailInSenderAddresses.id, id));
    expect(await daysLeft()).toBe(1);

    advanceClock(0.2 * DAY);
    await getDb().update(mailInSenderAddresses).set({ verificationExpiresAt: new Date(Date.now() - 1000) }).where(eq(mailInSenderAddresses.id, id));
    expect(await daysLeft()).toBe(0);
  });

  it("re-cut of the deadline case: a send at 15 days is refused, not honoured, and the sweep removes the row", async () => {
    const session = await fixture.session("member");
    await seedSenderAddress(member().id);
    expect((await addAddress(session, SECOND)).status).toBeLessThan(300);
    await backdate(member().id, SECOND, 15);

    const response = await sendCheck(session, { id: await idOf(member().id, SECOND) });

    expect(response.status).toBe(409);
    expect((await errorOf(response)).code).toBe("sender_address_lapsed");
    expect(mail.sent).toEqual([]);
    await purgeExpiredImapStaging(new Date());
    expect((await listSenderAddresses(member().id)).map((row) => row.address)).toEqual([member().email]);
  });
});
