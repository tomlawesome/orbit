import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
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
  metadataKeyOutages,
} from "@/db/schema";
import { listImapInbox, purgeExpiredImapStaging } from "@/server/mail-in/imap-inbox";
import { addSenderAddress, listSenderAddresses, requestSenderCheck, seedSenderAddress } from "@/server/mail-in/sender-addresses";
import { getImapIngestionConfig } from "@/server/mail-in/mailbox-config";
import { setMailboxSettings, type MailboxSettingsDependencies, type MailboxSettingsInput } from "@/server/mail-in/mailbox-settings";
import { reconcileImapRecipientAliases } from "@/server/mail-in/imap-ingestion";
import { cleanupIntegrationEnvironment, createIntegrationFixture, senderAddressColumns, type IntegrationFixture } from "./support/fixtures";
import { clearSending, setUpSending } from "./support/mail-sending-1629";

/*
 * #1848 A-F2 (note 59272), from the specification alone. The key is available
 * but a `metadata_key_outages` window is still `open` (started at S): the
 * window the next purge cycle would close. A-S2's rule is that an unchecked
 * extra address's 14 days do not run while the key is away, so every place
 * that reads the clock (the check press, the add, the list, the held-receipt
 * inbox) must read it as min(now, S), and a row added after S has used no time.
 * The sweep, after it closes the window, credits created_at by
 * `ended_at - max(S, created_at)`; the read paths must agree with it.
 *
 * Case 1 reads the held receipt through listImapInbox, which takes no `now`
 * seam, so that one test fakes Date (only) for its duration.
 */
/* Mail is captured at the transport library; nothing opens a socket. */
vi.mock("nodemailer", () => {
  const createTransport = () => ({
    async sendMail() { return { messageId: "fixture" }; },
    async verify() { return true; },
    close() {},
  });
  return { default: { createTransport }, createTransport };
});

const DAY = 86_400_000;
const HOUR = 3_600_000;
const SECOND_ADDRESS = "harlow-outage-clock@example.test";
const S = new Date("2026-06-01T12:00:00.000Z");
const at = (base: Date, ms: number) => new Date(base.getTime() + ms);

const settings: MailboxSettingsInput = {
  host: "imap.example.test",
  port: 993,
  accountUser: "intake@example.test",
  mailbox: "INBOX",
  tlsServerName: "imap.example.test",
  providerProfile: "mailcow",
  trustedRecipientHeader: "X-Original-To",
  pollSeconds: 300,
  password: "fake-outage-clock-password",
};
const providerReady: MailboxSettingsDependencies = { verifyImap: async () => "ready" };

let fixture: IntegrationFixture;
const member = () => fixture.users.member;

beforeEach(async () => {
  fixture = await createIntegrationFixture("sender-outage-clock");
  await setUpSending(fixture.users.admin.id);
});

afterEach(async () => {
  vi.useRealTimers();
  const db = getDb();
  await db.delete(metadataKeyOutages);
  await db.delete(imapIngestionMessages);
  await db.delete(imapRecipientAliases);
  await db.delete(mailInSenderAddresses);
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

async function openOutage(startedAt: Date) {
  await getDb().insert(metadataKeyOutages).values({ status: "open", startedAt });
}

/** The member's sign-in row plus one unchecked extra row created at `createdAt`. */
async function uncheckedExtra(createdAt: Date): Promise<string> {
  await seedSenderAddress(member().id);
  const id = randomUUID();
  await getDb().insert(mailInSenderAddresses).values({
    id, userId: member().id, ...await senderAddressColumns(id, SECOND_ADDRESS), source: "manual", createdAt, updatedAt: createdAt,
  });
  return id;
}

const rowIds = async () => (await getDb().select({ id: mailInSenderAddresses.id }).from(mailInSenderAddresses)
  .where(eq(mailInSenderAddresses.userId, member().id))).map((row) => row.id);

const deps = (now: Date) => ({ now: () => now, sendMail: vi.fn(async () => {}) });

/** The check press's outcome as data, so a wrong answer fails an assertion, not the harness. */
async function press(id: string, now: Date): Promise<string> {
  try {
    await requestSenderCheck(member().id, deps(now), id);
    return "sent";
  } catch (error) {
    return (error as { code?: string }).code ?? `unexpected: ${String(error)}`;
  }
}

const daysLeftOf = async (now: Date) =>
  (await listSenderAddresses(member().id, deps(now))).find((view) => view.address === SECOND_ADDRESS)?.daysLeft;

async function expectNotLapsed(id: string, now: Date) {
  expect(await press(id, now)).toBe("sent");
  const added = await addSenderAddress(member().id, SECOND_ADDRESS, deps(now));
  expect(added.added).toBe(false);
  expect(added.senders.find((view) => view.address === SECOND_ADDRESS)?.id).toBe(id);
  expect(await rowIds()).toContain(id);
  expect(await daysLeftOf(now)).toBeGreaterThanOrEqual(1);
}

async function heldReceiptUnder(senderAddressId: string) {
  await setMailboxSettings(fixture.users.admin.id, null, settings, providerReady);
  await reconcileImapRecipientAliases(await getImapIngestionConfig());
  await getDb().insert(imapIngestionMessages).values({
    mailbox: "INBOX",
    mailboxUidValidity: "9001",
    mailboxUid: 1,
    recipientAliasSha256: "1".padStart(64, "1"),
    userId: member().id,
    expiresAt: new Date(Date.now() + 30 * DAY),
    status: "processing",
    receiptStatus: "processing",
    heldSenderAddressId: senderAddressId,
  });
}

const heldDaysLeft = async () =>
  ((await listImapInbox(member().id)).receipts as unknown as Array<{ senderDaysLeft: number | null }>)[0]?.senderDaysLeft;

describe("an open key outage stops the 14-day clock on the read paths (#1848 A-F2)", () => {
  it("case 1: a row 13 days old outside the outage is not lapsed on press, add or list, nor on a held receipt", async () => {
    const now = at(S, 3 * DAY);
    const id = await uncheckedExtra(at(S, -13 * DAY));
    await openOutage(S);

    await expectNotLapsed(id, now);

    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(now);
    await heldReceiptUnder(id);
    expect(await heldDaysLeft()).toBeGreaterThanOrEqual(1);
  }, 30_000);

  it("case 2: with no open outage the same row, 16 days old, is lapsed: 409, replaced on re-add, 0 days left", async () => {
    const now = at(S, 3 * DAY);
    const id = await uncheckedExtra(at(S, -13 * DAY));

    expect(await daysLeftOf(now)).toBe(0);
    expect(await press(id, now)).toBe("sender_address_lapsed");
    const added = await addSenderAddress(member().id, SECOND_ADDRESS, deps(now));
    expect(added.added).toBe(true);
    const replacement = added.senders.find((view) => view.address === SECOND_ADDRESS);
    expect(replacement?.id).not.toBe(id);
    expect(await rowIds()).not.toContain(id);
  });

  it("case 3: a row added after the outage began, still open, has used no time at 20 days later", async () => {
    const now = at(S, 20 * DAY);
    const id = await uncheckedExtra(at(S, HOUR));
    await openOutage(S);

    await expectNotLapsed(id, now);
  });

  it("case 4: a row whose 14 days ended before the outage began is lapsed one day into it", async () => {
    const now = at(S, 1 * DAY);
    const id = await uncheckedExtra(at(S, -15 * DAY));
    await openOutage(S);

    expect(await daysLeftOf(now)).toBe(0);
    expect(await press(id, now)).toBe("sender_address_lapsed");
    const added = await addSenderAddress(member().id, SECOND_ADDRESS, deps(now));
    expect(added.added).toBe(true);
    expect(added.senders.find((view) => view.address === SECOND_ADDRESS)?.id).not.toBe(id);
  });

  it("case 5: after the purge cycle closes the window, the sweep keeps the case-1 row and the read paths give the same answers", async () => {
    const now = at(S, 3 * DAY);
    const id = await uncheckedExtra(at(S, -13 * DAY));
    await openOutage(S);

    await purgeExpiredImapStaging(now);

    const [window] = await getDb().select().from(metadataKeyOutages);
    expect(window.status).toBe("closed");
    expect(await rowIds()).toContain(id);
    const [row] = await getDb().select().from(mailInSenderAddresses).where(eq(mailInSenderAddresses.id, id));
    expect(row.createdAt.getTime()).toBe(at(S, -10 * DAY).getTime());
    await expectNotLapsed(id, now);

    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(now);
    await heldReceiptUnder(id);
    expect(await heldDaysLeft()).toBeGreaterThanOrEqual(1);
  }, 30_000);
});
