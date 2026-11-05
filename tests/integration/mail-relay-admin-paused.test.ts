import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { auditLog, imapIngestionMessages, imapRecipientAliases, mailInMailbox, mailInRelays, mailInSecrets, mailInSenderAddresses } from "@/db/schema";
import { rotateRelayAddress, setRelayIngest } from "@/server/mail-in/relay-settings";
import { readMailboxSettings, setMailboxIngestEnabled, setMailboxSettings, type MailboxSettingsDependencies, type MailboxSettingsInput } from "@/server/mail-in/mailbox-settings";
import { cleanupIntegrationEnvironment, createIntegrationFixture, type IntegrationFixture, type IntegrationSession } from "./support/fixtures";
import { callRouteForSession, loadRoute } from "./support/request-event";

/*
 * #1654: while the administrator has paused ingest, the member's relay
 * settings read (`GET /api/settings/mail-relay`) still carries their address,
 * and says the pause is the administrator's with a boolean `adminPaused`
 * (the name is the test author's choice; the issue only asks for "a paused
 * flag"). A mailbox that was never configured has no address and is not
 * "paused by the administrator".
 */
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
  password: "fake-sender-read-password",
};
const providerReady: MailboxSettingsDependencies = { verifyImap: async () => "ready" };

const RELAY_URL = "http://127.0.0.1:3000/api/settings/mail-relay";

const relayRead = async () => (await loadRoute("settings/mail-relay")).GET;

let fixture: IntegrationFixture;

beforeEach(async () => {
  fixture = await createIntegrationFixture("sender-read");
});

afterEach(async () => {
  const db = getDb();
  await db.delete(imapIngestionMessages);
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

/** The relay read as the browser gets it. */
async function readOverHttp(session: IntegrationSession) {
  const response = await callRouteForSession(await relayRead(), session, { url: RELAY_URL, method: "GET" });
  expect(response.status).toBe(200);
  return (await response.json() as { relay: { address?: string | null; ingest?: string; adminPaused?: boolean } }).relay;
}


describe("GET /api/settings/mail-relay while the administrator has paused ingest (#1654)", () => {
  it("carries the member's address, unchanged, and the paused flag", async () => {
    await turnMailInOn();
    const session = await fixture.session("member");
    const before = await readOverHttp(session);
    expect(before.address, "an address is issued while ingest runs").toEqual(expect.any(String));
    expect(before.adminPaused ?? false).toBe(false);

    const { version } = await readMailboxSettings(fixture.users.admin.id);
    await setMailboxIngestEnabled(fixture.users.admin.id, version!, false);

    const during = await readOverHttp(session);
    expect(during.address).toBe(before.address);
    expect(during.adminPaused).toBe(true);
  });

  it("a member can still rotate their own address while the administrator's pause holds (#1670 A-F3)", async () => {
    await turnMailInOn();
    const session = await fixture.session("member");
    const before = await readOverHttp(session);
    const { version } = await readMailboxSettings(fixture.users.admin.id);
    await setMailboxIngestEnabled(fixture.users.admin.id, version!, false);

    const member = { id: fixture.users.member.id, isInstanceAdmin: false };
    const after = await rotateRelayAddress(member, "rotate");
    expect(after.adminPaused).toBe(true);
    expect(after.address, "rotation must change the address, not silently do nothing").not.toBe(before.address);
  });

  it("a member can still pause their own collection while the administrator's pause holds (#1670 A-F3)", async () => {
    await turnMailInOn();
    const { version } = await readMailboxSettings(fixture.users.admin.id);
    await setMailboxIngestEnabled(fixture.users.admin.id, version!, false);

    const member = { id: fixture.users.member.id, isInstanceAdmin: false };
    await setRelayIngest(member, true);
    const [row] = await getDb().select().from(mailInRelays).where(eq(mailInRelays.userId, member.id));
    expect(row?.ingestPausedAt, "the member's own pause must be recorded").toBeTruthy();
  });

  /* #1670 W-R1 (handed back with #1681): resuming releases the member's held
     rows to processing, and the administrator's pause does not change that:
     no row of the resuming member's may stay `held`. A sibling's held row is
     not theirs to release. */
  it("a member who resumes during the administrator's pause has no row left held (#1670 W-R1)", async () => {
    await turnMailInOn();
    const { version } = await readMailboxSettings(fixture.users.admin.id);
    await setMailboxIngestEnabled(fixture.users.admin.id, version!, false);
    const member = { id: fixture.users.member.id, isInstanceAdmin: false };
    const sibling = { id: fixture.users.owner.id, isInstanceAdmin: false };
    await setRelayIngest(member, true);
    await setRelayIngest(sibling, true);
    const heldRow = (userId: string, uid: number) => ({
      mailbox: "INBOX", mailboxUidValidity: "1670", mailboxUid: uid, contentSha256: randomUUID().replaceAll("-", ""),
      recipientAliasSha256: "w-r1", userId, attributedBy: "sender" as const, status: "held" as const,
      receiptStatus: "cancelled" as const, expiresAt: new Date(Date.now() + 86_400_000),
    });
    await getDb().insert(imapIngestionMessages).values([heldRow(member.id, 1), heldRow(member.id, 2), heldRow(sibling.id, 3)]);

    await setRelayIngest(member, false);

    const stillHeld = await getDb().select({ id: imapIngestionMessages.id }).from(imapIngestionMessages)
      .where(and(eq(imapIngestionMessages.userId, member.id), eq(imapIngestionMessages.status, "held")));
    expect(stillHeld, "no row of the resuming member's stays held").toEqual([]);
    const released = await getDb().select({ status: imapIngestionMessages.status }).from(imapIngestionMessages)
      .where(eq(imapIngestionMessages.userId, member.id));
    expect(released.map((row) => row.status)).toEqual(["processing", "processing"]);
    const siblings = await getDb().select({ status: imapIngestionMessages.status }).from(imapIngestionMessages)
      .where(eq(imapIngestionMessages.userId, sibling.id));
    expect(siblings.map((row) => row.status)).toEqual(["held"]);
  });

  it("a mailbox that was never configured has no address and is not reported as paused by the administrator", async () => {
    const session = await fixture.session("member");
    const relay = await readOverHttp(session);
    expect(relay.address ?? null).toBeNull();
    expect(relay.adminPaused ?? false).toBe(false);
  });
});
