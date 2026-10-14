import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/db";
import { auditLog, imapRecipientAliases, mailInMailbox, mailInRelays, mailInSecrets, mailInSenderAddresses } from "@/db/schema";
import { setMailboxSettings, type MailboxSettingsDependencies, type MailboxSettingsInput } from "@/server/mail-in/mailbox-settings";
import { readRelaySettings } from "@/server/mail-in/relay-settings";
import { listSenderAddresses, seedSenderAddress } from "@/server/mail-in/sender-addresses";
import { cleanupIntegrationEnvironment, createIntegrationFixture, type IntegrationFixture, type IntegrationSession } from "./support/fixtures";
import { callRouteForSession, loadRoute } from "./support/request-event";

/*
 * ADR-0017 decision 3, amended by decision 7c: the relay settings read
 * (`GET /api/settings/mail-relay`) reports the member's one sending-address
 * row as `sender: { address, verified, verificationPending, expiresAt }`, and
 * the sender module's own view carries the same `expiresAt`.
 *
 * The three states are put into the database directly, so these cases say
 * nothing about the route that sends the check email.
 */
interface SenderReading {
  address: string;
  verified: boolean;
  verificationPending: boolean;
  expiresAt: string | null;
}

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
const HOUR_MS = 3_600_000;

const relayRead = async () => (await loadRoute("settings/mail-relay")).GET;

let fixture: IntegrationFixture;

beforeEach(async () => {
  fixture = await createIntegrationFixture("sender-read");
});

afterEach(async () => {
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

/** The relay read as the browser gets it, and what its body says about the sender. */
async function readOverHttp(session: IntegrationSession) {
  const response = await callRouteForSession(await relayRead(), session, { url: RELAY_URL, method: "GET" });
  expect(response.status).toBe(200);
  const body = await response.json() as { relay: { sender?: SenderReading | null } };
  return body.relay.sender;
}

async function linkSent(userId: string, expiresAt: Date) {
  await getDb().update(mailInSenderAddresses)
    .set({ verificationTokenDigest: "f".repeat(64), verificationExpiresAt: expiresAt })
    .where(eq(mailInSenderAddresses.userId, userId));
}

async function markChecked(userId: string) {
  await getDb().update(mailInSenderAddresses)
    .set({ verifiedAt: new Date(), verificationTokenDigest: null, verificationExpiresAt: null })
    .where(eq(mailInSenderAddresses.userId, userId));
}

describe("GET /api/settings/mail-relay reports the sender check (decision 7c)", () => {
  it("not yet checked: the registered address, unchecked, with no live link", async () => {
    await turnMailInOn();
    const session = await fixture.session("member");

    expect(await readOverHttp(session)).toEqual({
      address: fixture.users.member.email,
      verified: false,
      verificationPending: false,
      expiresAt: null,
    });
  });

  it("check email sent and the link still good: pending, with the time the link lapses", async () => {
    await turnMailInOn();
    const session = await fixture.session("member");
    await seedSenderAddress(fixture.users.member.id);
    const lapses = new Date(Date.now() + 6 * HOUR_MS);
    await linkSent(fixture.users.member.id, lapses);

    expect(await readOverHttp(session)).toEqual({
      address: fixture.users.member.email,
      verified: false,
      verificationPending: true,
      expiresAt: lapses.toISOString(),
    });
  });

  it("checked: verified, and no longer pending", async () => {
    await turnMailInOn();
    const session = await fixture.session("member");
    await seedSenderAddress(fixture.users.member.id);
    await markChecked(fixture.users.member.id);

    const sender = await readOverHttp(session);

    expect(sender).toMatchObject({ address: fixture.users.member.email, verified: true, verificationPending: false });
  });

  it("a lapsed link, still unchecked, reads as not pending", async () => {
    await turnMailInOn();
    const session = await fixture.session("member");
    await seedSenderAddress(fixture.users.member.id);
    await linkSent(fixture.users.member.id, new Date(Date.now() - HOUR_MS));

    const sender = await readOverHttp(session);

    expect(sender).toMatchObject({ address: fixture.users.member.email, verified: false, verificationPending: false });
  });

  it("is null for an instance administrator", async () => {
    await turnMailInOn();
    const session = await fixture.session("admin");

    expect(await readOverHttp(session)).toBeNull();
  });

  it("is null when mail-in is off", async () => {
    const session = await fixture.session("member");

    expect(await readOverHttp(session)).toBeNull();
  });

  it("is the same reading from the settings module the route calls", async () => {
    await turnMailInOn();
    const member = { id: fixture.users.member.id, isInstanceAdmin: false };
    const lapses = new Date(Date.now() + 2 * HOUR_MS);

    expect((await readRelaySettings(member)).sender).toEqual({
      address: fixture.users.member.email,
      verified: false,
      verificationPending: false,
      expiresAt: null,
    });
    await linkSent(fixture.users.member.id, lapses);
    expect((await readRelaySettings(member)).sender).toMatchObject({ verificationPending: true, expiresAt: lapses.toISOString() });
    await markChecked(fixture.users.member.id);
    expect((await readRelaySettings(member)).sender).toMatchObject({ verified: true, verificationPending: false });
    expect((await readRelaySettings({ id: fixture.users.admin.id, isInstanceAdmin: true })).sender).toBeNull();
  });
});

describe("the sender module's view carries the link's expiry (decision 7c)", () => {
  it("reports null with no live link, the ISO time while one is good, and null once checked", async () => {
    await seedSenderAddress(fixture.users.member.id);
    const [unchecked] = await listSenderAddresses(fixture.users.member.id);
    expect(unchecked.expiresAt).toBeNull();

    const lapses = new Date(Date.now() + 3 * HOUR_MS);
    await linkSent(fixture.users.member.id, lapses);
    const [pending] = await listSenderAddresses(fixture.users.member.id);
    expect(pending.verificationPending).toBe(true);
    expect(pending.expiresAt).toBe(lapses.toISOString());

    await markChecked(fixture.users.member.id);
    const [checked] = await listSenderAddresses(fixture.users.member.id);
    expect(checked.verified).toBe(true);
    expect(checked.expiresAt).toBeNull();
  });

  it("does not offer a lapsed link as pending", async () => {
    await seedSenderAddress(fixture.users.member.id);
    await linkSent(fixture.users.member.id, new Date(Date.now() - HOUR_MS));

    const [lapsed] = await listSenderAddresses(fixture.users.member.id);

    expect(lapsed.verified).toBe(false);
    expect(lapsed.verificationPending).toBe(false);
  });
});
