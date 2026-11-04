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
  mailInUnattributedReplies,
} from "@/db/schema";
import { getImapIngestionConfig } from "@/server/mail-in/mailbox-config";
import { setMailboxSettings, type MailboxSettingsDependencies, type MailboxSettingsInput } from "@/server/mail-in/mailbox-settings";
import {
  reconcileImapRecipientAliases,
  runImapIngestionCycle,
  setImapClientFactoryForTests,
} from "@/server/mail-in/imap-ingestion";
import { cleanupIntegrationEnvironment, createIntegrationFixture, type IntegrationFixture } from "./support/fixtures";
import { fixtureHeaders, TRUSTED_AUTHSERV_ID, verifiedSenderFor } from "./support/mail-in";
import { makeRsaKey, sampleMessage, signMessage } from "../support/dkim-signing";

/*
 * #1655: a member forwarding from the same mail server that hosts the relay
 * mailbox gets no Authentication-Results verdict from that server, so the
 * provider's word is absent. Orbit then verifies the message's own DKIM
 * signature against the sender's published key (DNS, stubbed here at
 * node:dns/promises, the only place the lookup reaches the network).
 */
const dns = vi.hoisted(() => ({ records: new Map<string, string>(), lookups: [] as string[], failure: undefined as string | undefined }));
vi.mock("node:dns/promises", () => {
  const resolveTxt = async (name: string) => {
    dns.lookups.push(name);
    if (dns.failure) throw Object.assign(new Error("dns failure"), { code: dns.failure });
    const record = dns.records.get(name);
    if (record === undefined) throw Object.assign(new Error("not found"), { code: "ENOTFOUND" });
    return [[record]];
  };
  class Resolver { resolveTxt = resolveTxt; setServers() {} cancel() {} }
  return { resolveTxt, Resolver, default: { resolveTxt, Resolver } };
});

const settings: MailboxSettingsInput = {
  host: "imap.example.test",
  port: 993,
  accountUser: "intake@example.test",
  mailbox: "INBOX",
  tlsServerName: "imap.example.test",
  providerProfile: "mailcow",
  trustedRecipientHeader: "X-Original-To",
  trustedAuthservId: TRUSTED_AUTHSERV_ID,
  pollSeconds: 300,
  password: "fake-attribution-password",
};
const providerReady: MailboxSettingsDependencies = { verifyImap: async () => "ready" };
const smtp = { smtpUrl: "smtps://smtp.example.test", smtpFrom: "orbit@example.test" } as never;

let fixture: IntegrationFixture;
/** Every message the fake provider was asked to delete and expunge. */
let deleted: string[];
/** Every reply the engine handed to SMTP. */
let sent: Array<{ to: string; subject: string; text: string }>;

beforeEach(async () => {
  fixture = await createIntegrationFixture("mail-in-dkim-self-verification");
  deleted = [];
  sent = [];
  await setMailboxSettings(fixture.users.admin.id, null, settings, providerReady);
});

afterEach(async () => {
  const db = getDb();
  setImapClientFactoryForTests(undefined);
  await db.delete(imapIngestionMessages);
  await db.delete(imapRecipientAliases);
  await db.delete(mailInRelays);
  await db.delete(mailInSenderAddresses);
  await db.delete(mailInUnattributedReplies);
  await db.update(mailInMailbox).set({ passwordSecretId: null, aliasKeySecretId: null });
  await db.delete(mailInMailbox);
  await db.delete(mailInSecrets);
  await db.delete(auditLog);
  dns.records.clear();
  dns.lookups.length = 0;
  dns.failure = undefined;
  await fixture.cleanup();
});

afterAll(async () => {
  await cleanupIntegrationEnvironment();
});

/** One message in the mailbox: provider headers `headers`, full text `source`. */
function mailboxHolding(uidValidity: bigint, headers: Buffer, source: Buffer) {
  setImapClientFactoryForTests(() => ({
    mailbox: { uidValidity, uidNext: 1_000_000 },
    async connect() {},
    async logout() {},
    async getMailboxLock() { return { release() {} }; },
    async search() { return [1]; },
    async messageDelete(range: string) { deleted.push(range); return true; },
    // Copies: the engine zeroes what it was handed once it is done with it.
    async fetchOne() { return { uid: 1, headers: Buffer.from(headers), source: Buffer.from(source) }; },
  } as unknown as import("imapflow").ImapFlow));
}

const replyDependencies = {
  smtpConfig: () => smtp,
  sendMail: async (message: { to: string; subject: string; text: string }) => { sent.push(message); },
};

async function collect(uidValidity: bigint, headers: Buffer, source: Buffer) {
  const config = await getImapIngestionConfig();
  mailboxHolding(uidValidity, headers, source);
  await runImapIngestionCycle(config, replyDependencies);
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

describe("attribution by the message's own DKIM signature (#1655)", () => {
  const key = makeRsaKey();

  async function memberForward(options: { signingDomain?: string; publish: boolean }) {
    const config = await getImapIngestionConfig();
    await reconcileImapRecipientAliases(config);
    const address = await verifiedSenderFor(fixture.users.member.id);
    const domain = address.slice(address.lastIndexOf("@") + 1);
    const signingDomain = options.signingDomain ?? domain;
    if (options.publish) dns.records.set(`s1._domainkey.${signingDomain}`, key.record);
    /* The server wrote no Authentication-Results at all: no verdict, no alias. */
    const headers = fixtureHeaders({ from: address });
    const source = await signMessage(sampleMessage({ from: address }), { domain: signingDomain, selector: "s1", key });
    return { address, headers, source };
  }

  it("attributes a verified member's forward when their own signature verifies and the server wrote no verdict", async () => {
    const { headers, source } = await memberForward({ publish: true });

    await collect(3001n, headers, source);

    expect(await receiptFor("3001")).toMatchObject({
      userId: fixture.users.member.id, attributedBy: "sender",
    });
    expect(sent).toEqual([]);
    expect(deleted).toEqual([]);
  }, 20_000);

  it("still refuses when the signature is for somebody else's domain", async () => {
    const { headers, source } = await memberForward({ signingDomain: "attacker.test", publish: true });

    await collect(3002n, headers, source);

    expect(await receiptFor("3002")).toMatchObject({ userId: null, status: "unattributed", failureCode: "sender_unauthenticated" });
    expect(sent).toEqual([]);
  }, 20_000);

  it("still refuses when the signing domain publishes no key", async () => {
    const { headers, source } = await memberForward({ publish: false });

    await collect(3003n, headers, source);

    expect(await receiptFor("3003")).toMatchObject({ userId: null, status: "unattributed", failureCode: "sender_unauthenticated" });
  }, 20_000);

  it("looks nothing up when the trusted provider already vouches for the sender", async () => {
    const { address, source } = await memberForward({ publish: true });
    const domain = address.slice(address.lastIndexOf("@") + 1);
    const headers = fixtureHeaders({ from: address, verdict: `dmarc=pass header.from=${domain}` });

    await collect(3004n, headers, source);

    expect(await receiptFor("3004")).toMatchObject({ userId: fixture.users.member.id, attributedBy: "sender" });
    expect(dns.lookups).toEqual([]);
  }, 20_000);

  it("looks nothing up for a sender address no member has verified", async () => {
    const config = await getImapIngestionConfig();
    await reconcileImapRecipientAliases(config);
    dns.records.set("s1._domainkey.example.test", key.record);
    const headers = fixtureHeaders({ from: "stranger@example.test" });
    const source = await signMessage(sampleMessage({ from: "stranger@example.test" }), {
      domain: "example.test", selector: "s1", key,
    });

    await collect(3005n, headers, source);

    expect(await receiptFor("3005")).toMatchObject({ userId: null, status: "unattributed" });
    expect(dns.lookups).toEqual([]);
  }, 20_000);

  /* #1670 A-R1: a key lookup that cannot be answered right now (TEMPFAIL,
     RFC 6376 §6.1.2) holds the message for a later poll instead of filing it
     as unauthenticated; the poll itself carries on. */
  it("holds the message, unanswered and undeleted, when the key lookup fails temporarily, and attributes it once DNS answers", async () => {
    const { headers, source } = await memberForward({ publish: true });
    dns.failure = "ESERVFAIL";

    await expect(collect(3006n, headers, source)).resolves.toBeUndefined();

    expect(await receiptFor("3006")).toMatchObject({ userId: null, status: "held", failureCode: "sender_dkim_unavailable" });
    expect(sent).toEqual([]);
    expect(deleted).toEqual([]);

    dns.failure = undefined;
    await collect(3006n, headers, source);

    expect(await receiptFor("3006")).toMatchObject({ userId: fixture.users.member.id, attributedBy: "sender" });
    expect(sent).toEqual([]);
    expect(deleted).toEqual([]);
  }, 20_000);

  it("backs off between tries while the lookup keeps failing", async () => {
    const { headers, source } = await memberForward({ publish: true });
    dns.failure = "ETIMEOUT";

    await collect(3007n, headers, source);
    await collect(3007n, headers, source);

    const [row] = await getDb().select({
      status: imapIngestionMessages.status,
      attempts: imapIngestionMessages.attachmentProcessingAttempts,
      nextAttemptAt: imapIngestionMessages.attachmentProcessingNextAttemptAt,
    }).from(imapIngestionMessages).where(eq(imapIngestionMessages.mailboxUidValidity, "3007"));
    expect(row).toMatchObject({ status: "held", attempts: 1 });
    expect(row?.nextAttemptAt?.getTime()).toBeGreaterThan(Date.now());
    expect(sent).toEqual([]);
    expect(deleted).toEqual([]);
  }, 20_000);

  it("decides the message as having no key once the tries run out, so it is not held forever", async () => {
    const { headers, source } = await memberForward({ publish: true });
    dns.failure = "ESERVFAIL";
    await collect(3008n, headers, source);
    await getDb().update(imapIngestionMessages).set({ attachmentProcessingAttempts: 23, attachmentProcessingNextAttemptAt: null })
      .where(eq(imapIngestionMessages.mailboxUidValidity, "3008"));

    await collect(3008n, headers, source);

    expect(await receiptFor("3008")).toMatchObject({ userId: null, status: "unattributed", failureCode: "sender_unauthenticated" });
    expect(deleted).toEqual(["1"]);
  }, 20_000);

  /* #1670 review follow-up: the attempt count restarts when the hold reason
     changes, so a receipt that was sender_unreadable gets the full 24 tries. */
  it("gives a receipt that was held as sender_unreadable the full tries once it is held as sender_dkim_unavailable", async () => {
    const { headers, source } = await memberForward({ publish: true });
    dns.failure = "ETIMEOUT";
    await collect(3009n, headers, source);
    await getDb().update(imapIngestionMessages)
      .set({ failureCode: "sender_unreadable", attachmentProcessingAttempts: 23, attachmentProcessingNextAttemptAt: null })
      .where(eq(imapIngestionMessages.mailboxUidValidity, "3009"));

    await collect(3009n, headers, source);

    const [row] = await getDb().select({
      status: imapIngestionMessages.status,
      failureCode: imapIngestionMessages.failureCode,
      attempts: imapIngestionMessages.attachmentProcessingAttempts,
    }).from(imapIngestionMessages).where(eq(imapIngestionMessages.mailboxUidValidity, "3009"));
    expect(row).toMatchObject({ status: "held", failureCode: "sender_dkim_unavailable", attempts: 1 });
    expect(sent).toEqual([]);
    expect(deleted).toEqual([]);
  }, 20_000);
});
