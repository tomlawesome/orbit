import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/db";
import {
  auditLog,
  imapIngestionAttachments,
  imapIngestionMessages,
  imapNotificationDeliveries,
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
  imapRecipientAlias,
  reconcileImapRecipientAliases,
  runImapIngestionCycle,
  setImapClientFactoryForTests,
} from "@/server/mail-in/imap-ingestion";
import { listImapInbox } from "@/server/mail-in/imap-inbox";
import { materializeImapNotificationsForTests } from "@/server/mail-in/imap-receipt-worker";
import { readRelayRow } from "@/server/mail-in/relays";
import { cleanupIntegrationEnvironment, createIntegrationFixture, type IntegrationFixture } from "./support/fixtures";
import { fixtureHeaders, TRUSTED_AUTHSERV_ID, verifiedSenderFor } from "./support/mail-in";
import { makeRsaKey, sampleMessage, signMessage } from "../support/dkim-signing";

/*
 * #1655: a member forwarding from the same mail server that hosts the relay
 * mailbox gets no Authentication-Results verdict from that server, so the
 * provider's word is absent. Orbit then verifies the message's own DKIM
 * signature against the sender's published key (DNS, stubbed here at
 * node:dns/promises, the only place the lookup reaches the network).
 *
 * #1681 (owner decision 86a): that signature is now the ONLY evidence. An
 * Authentication-Results header is never believed, whichever authserv-id it
 * names, for attribution or for the reply to a stranger. The configuration
 * below still carries the retired trusted authserv-id, the way a saved
 * configuration from v0.3.6 does, so every refusal here is a refusal of a
 * header the old code trusted.
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

/* A client that still sends the retired `trustedAuthservId`: the API ignores
   it (#1681), and it is what makes the old code trust the forged headers. */
const settings = {
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
} as MailboxSettingsInput;
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

  it("checks the signature even when a provider header claims a pass, and attributes on the signature", async () => {
    const { address, source } = await memberForward({ publish: true });
    const domain = address.slice(address.lastIndexOf("@") + 1);
    const headers = fixtureHeaders({ from: address, verdict: `dkim=pass header.d=${domain}; dmarc=pass header.from=${domain}` });

    await collect(3004n, headers, source);

    expect(await receiptFor("3004")).toMatchObject({ userId: fixture.users.member.id, attributedBy: "sender" });
    expect(dns.lookups).toContain(`s1._domainkey.${domain}`);
  }, 20_000);

  it("refuses a forged provider dmarc=pass and aligned dkim=pass with no verifiable signature, and sends no reply (#1681)", async () => {
    const config = await getImapIngestionConfig();
    await reconcileImapRecipientAliases(config);
    const address = await verifiedSenderFor(fixture.users.member.id);
    const domain = address.slice(address.lastIndexOf("@") + 1);
    /* What a sibling mailbox on the same server can submit: the member's From
       and the operator's own authserv-id on top, nothing signed. */
    const headers = fixtureHeaders({
      from: address,
      authservId: TRUSTED_AUTHSERV_ID,
      verdict: `dkim=pass header.d=${domain}; dmarc=pass header.from=${domain}`,
    });

    await collect(3010n, headers, Buffer.from(sampleMessage({ from: address })));

    expect(await receiptFor("3010")).toMatchObject({ userId: null, status: "unattributed", failureCode: "sender_unauthenticated" });
    expect(await getDb().select({ id: imapIngestionMessages.id }).from(imapIngestionMessages)
      .where(eq(imapIngestionMessages.userId, fixture.users.member.id))).toHaveLength(0);
    expect(sent).toEqual([]);
    expect(deleted).toEqual(["1"]);
  }, 20_000);

  it("refuses the forged header beside a valid signature for a different domain (#1681)", async () => {
    const { address, source } = await memberForward({ signingDomain: "attacker.test", publish: true });
    const domain = address.slice(address.lastIndexOf("@") + 1);
    const headers = fixtureHeaders({
      from: address,
      authservId: TRUSTED_AUTHSERV_ID,
      verdict: `dkim=pass header.d=${domain}; dmarc=pass header.from=${domain}`,
    });

    await collect(3011n, headers, source);

    expect(await receiptFor("3011")).toMatchObject({ userId: null, status: "unattributed", failureCode: "sender_unauthenticated" });
    expect(sent).toEqual([]);
  }, 20_000);

  /* Positive: the member's own provider signs the forward, and that alone
     attributes it, with the alias corroborating when it is there. */
  it.each([
    ["Gmail-style", false],
    ["Gmail-style", true],
    ["Mailcow-style", false],
    ["Mailcow-style", true],
  ] as const)("attributes a signed %s forward to the member (alias present: %s)", async (style, withAlias) => {
    const config = await getImapIngestionConfig();
    await reconcileImapRecipientAliases(config);
    const member = fixture.users.member.id;
    const address = await verifiedSenderFor(member);
    const domain = address.slice(address.lastIndexOf("@") + 1);
    dns.records.set(`s1._domainkey.${domain}`, key.record);
    const relay = await readRelayRow(member);
    const alias = withAlias ? imapRecipientAlias(member, config, relay!.currentGeneration) : undefined;
    /* Gmail stamps every delivered message with its own verdict; Mailcow,
       for a member submitting on the same host, stamps nothing and leaves
       only its spam filter's lines. Neither is read as evidence. */
    const headers = style === "Gmail-style"
      ? fixtureHeaders({
        from: `Member <${address}>`, alias,
        authservId: "mx.google.com",
        verdict: `dkim=pass header.i=@${domain} header.s=s1; spf=pass smtp.mailfrom=${address}; dmarc=pass (p=NONE) header.from=${domain}`,
      })
      : fixtureHeaders({ from: `Member <${address}>`, alias, extra: ["X-Rspamd-Server: mail", "X-Rspamd-Queue-Id: 4AB1C2D3E4"] });
    const source = await signMessage(sampleMessage({ from: address }), { domain, selector: "s1", key });
    const uidValidity = 3100n + (style === "Gmail-style" ? 0n : 10n) + (withAlias ? 1n : 0n);

    await collect(uidValidity, headers, source);

    expect(await receiptFor(String(uidValidity))).toMatchObject({
      userId: member, attributedBy: withAlias ? "sender_and_alias" : "sender",
    });
    expect(sent).toEqual([]);
    expect(deleted).toEqual([]);
  }, 20_000);

  it("looks nothing up for an unsigned message from an address no member has verified", async () => {
    const config = await getImapIngestionConfig();
    await reconcileImapRecipientAliases(config);
    const headers = fixtureHeaders({ from: "stranger@example.test" });

    await collect(3005n, headers, Buffer.from(sampleMessage({ from: "stranger@example.test" })));

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

  /* #1681, owner decision 87d: past the retry window the forward is not
     filed as unauthenticated and answered. The member the From names gets a
     content-free failure row, told through the inbox's existing notification
     and shown in the inbox's "could not be read" list; the message is deleted
     and nothing is sent to the From address. */
  it("files a content-free failure for the member once the tries run out, deletes the message and sends no reply (87d)", async () => {
    const { headers, source } = await memberForward({ publish: true });
    const member = fixture.users.member.id;
    dns.failure = "ESERVFAIL";
    await collect(3008n, headers, source);
    await getDb().update(imapIngestionMessages).set({ attachmentProcessingAttempts: 23, attachmentProcessingNextAttemptAt: null })
      .where(eq(imapIngestionMessages.mailboxUidValidity, "3008"));

    await collect(3008n, headers, source);

    const [row] = await getDb().select({
      id: imapIngestionMessages.id,
      userId: imapIngestionMessages.userId,
      status: imapIngestionMessages.status,
      failureCode: imapIngestionMessages.failureCode,
      attributedBy: imapIngestionMessages.attributedBy,
    }).from(imapIngestionMessages).where(eq(imapIngestionMessages.mailboxUidValidity, "3008"));
    expect(row).toMatchObject({ userId: member, status: "failed", failureCode: "sender_dkim_unavailable", attributedBy: null });
    expect(deleted).toEqual(["1"]);
    expect(sent).toEqual([]);
    /* Content-free: nothing of the message was collected or staged. */
    expect(await getDb().select({ id: imapIngestionAttachments.id }).from(imapIngestionAttachments)
      .where(eq(imapIngestionAttachments.messageId, row!.id))).toHaveLength(0);

    /* The member is told through the inbox's existing notification. */
    await materializeImapNotificationsForTests(new Date(), 10, member);
    const deliveries = await getDb().select({ kind: imapNotificationDeliveries.kind, userId: imapNotificationDeliveries.userId })
      .from(imapNotificationDeliveries).where(eq(imapNotificationDeliveries.messageId, row!.id));
    expect(deliveries).toEqual([{ kind: "receipt", userId: member }]);

    /* And the inbox shows it: couldn't be checked, wasn't kept, send it again. */
    const receipts = (await listImapInbox(member)).receipts as unknown as Array<{ id: string; message: string; canApprove: boolean }>;
    const shown = receipts.find((receipt) => receipt.id === row!.id);
    expect(shown, "the failure is in the member's inbox").toBeDefined();
    expect(shown!.canApprove).toBe(false);
    expect(shown!.message).toMatch(/check/iu);
    expect(shown!.message).toMatch(/kept/iu);
    expect(shown!.message).toMatch(/again/iu);
    for (const other of [fixture.users.owner.id, fixture.users.admin.id]) {
      const theirs = (await listImapInbox(other).catch(() => ({ receipts: [] }))).receipts as unknown as Array<{ id: string }>;
      expect(theirs.map((receipt) => receipt.id)).not.toContain(row!.id);
    }
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

/*
 * #1681: the reply to a sender no member owns uses the same evidence as
 * attribution. It goes out only when a signature aligned with the stranger's
 * From domain verifies; a provider header is never enough. That costs at most
 * one bounded key lookup for a stranger's message carrying an aligned
 * signature, and none for one that carries none.
 */
describe("the reply to an unattributed sender needs a verified aligned signature (#1681)", () => {
  const key = makeRsaKey();
  const STRANGER = "stranger@example.test";

  async function ready() {
    const config = await getImapIngestionConfig();
    await reconcileImapRecipientAliases(config);
  }

  it("is never sent on a provider header alone, however it is written", async () => {
    await ready();
    const headers = fixtureHeaders({
      from: STRANGER,
      authservId: TRUSTED_AUTHSERV_ID,
      verdict: "dkim=pass header.d=example.test; dmarc=pass header.from=example.test",
    });

    await collect(4001n, headers, Buffer.from(sampleMessage({ from: STRANGER })));

    expect(await receiptFor("4001")).toMatchObject({ userId: null, status: "unattributed" });
    expect(sent).toEqual([]);
    expect(deleted).toEqual(["1"]);
  }, 20_000);

  it("is sent once when the stranger's own aligned signature verifies, at the cost of at most one lookup", async () => {
    await ready();
    dns.records.set("s1._domainkey.example.test", key.record);
    const source = await signMessage(sampleMessage({ from: STRANGER }), { domain: "example.test", selector: "s1", key });

    await collect(4002n, fixtureHeaders({ from: STRANGER }), source);

    expect(await receiptFor("4002")).toMatchObject({ userId: null, status: "unattributed" });
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe(STRANGER);
    expect(deleted).toEqual(["1"]);
    expect(dns.lookups.length).toBeLessThanOrEqual(1);
  }, 20_000);

  it("is not sent when the aligned signature's key is not published", async () => {
    await ready();
    const source = await signMessage(sampleMessage({ from: STRANGER }), { domain: "example.test", selector: "s1", key });

    await collect(4003n, fixtureHeaders({ from: STRANGER }), source);

    expect(sent).toEqual([]);
    expect(deleted).toEqual(["1"]);
  }, 20_000);

  it("is not sent for a signature from another domain, and that costs no lookup", async () => {
    await ready();
    dns.records.set("s1._domainkey.attacker.test", key.record);
    const source = await signMessage(sampleMessage({ from: STRANGER }), { domain: "attacker.test", selector: "s1", key });

    await collect(4004n, fixtureHeaders({ from: STRANGER }), source);

    expect(sent).toEqual([]);
    expect(deleted).toEqual(["1"]);
    expect(dns.lookups).toEqual([]);
  }, 20_000);

  it("is never sent to automated mail, even with a verified aligned signature", async () => {
    await ready();
    dns.records.set("s1._domainkey.example.test", key.record);
    const source = await signMessage(sampleMessage({ from: STRANGER }), { domain: "example.test", selector: "s1", key });

    await collect(4005n, fixtureHeaders({ from: STRANGER, extra: ["Auto-Submitted: auto-replied"] }), source);

    expect(sent).toEqual([]);
    expect(deleted).toEqual(["1"]);
  }, 20_000);
});
