import { and, eq, sql } from "drizzle-orm";
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
import { log } from "@/lib/logger";
import { IMAP_ATTACHMENT_LIMITS } from "@/server/mail-in/core/imap-attachment-validation";
import { failureReasonOf, isRemovableTerminalFailure, reviewInboxState } from "@/server/mail-in/core/review-state";
import { getImapIngestionConfig } from "@/server/mail-in/mailbox-config";
import { setMailboxSettings, type MailboxSettingsDependencies, type MailboxSettingsInput } from "@/server/mail-in/mailbox-settings";
import {
  imapRecipientAlias,
  reconcileImapRecipientAliases,
  runImapIngestionCycle,
  setImapClientFactoryForTests,
} from "@/server/mail-in/imap-ingestion";
import { discardImapReviewItem, listImapInbox } from "@/server/mail-in/imap-inbox";
import { materializeImapNotificationsForTests } from "@/server/mail-in/imap-receipt-worker";
import { readRelayRow, setRelayIngestPaused } from "@/server/mail-in/relays";
import { listSenderAddresses, seedSenderAddress } from "@/server/mail-in/sender-addresses";
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

  /* #1681, note 52496: still refused, and now filed for the member the From
     names as a content-free `sender_unsigned` failure, not as a stranger's. */
  it("still refuses when the signature is for somebody else's domain, filing sender_unsigned for the member (note 52496)", async () => {
    const { headers, source } = await memberForward({ signingDomain: "attacker.test", publish: true });

    await collect(3002n, headers, source);

    expect(await receiptFor("3002")).toMatchObject({
      userId: fixture.users.member.id, status: "failed", failureCode: "sender_unsigned", attributedBy: null,
    });
    expect(sent).toEqual([]);
    expect(deleted).toEqual(["1"]);
  }, 20_000);

  it("still refuses when the signing domain publishes no key (NXDOMAIN), filing sender_unsigned for the member (note 52496)", async () => {
    const { headers, source } = await memberForward({ publish: false });

    await collect(3003n, headers, source);

    expect(await receiptFor("3003")).toMatchObject({
      userId: fixture.users.member.id, status: "failed", failureCode: "sender_unsigned", attributedBy: null,
    });
    expect(sent).toEqual([]);
    expect(deleted).toEqual(["1"]);
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

    /* Not attributed: filed for the member as unsigned (note 52496). */
    expect(await receiptFor("3010")).toMatchObject({
      userId: fixture.users.member.id, status: "failed", failureCode: "sender_unsigned", attributedBy: null,
    });
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

    expect(await receiptFor("3011")).toMatchObject({
      userId: fixture.users.member.id, status: "failed", failureCode: "sender_unsigned", attributedBy: null,
    });
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
 * #1681, design note 52496: an unsigned forward from a verified member.
 *
 * A forward whose From is a verified member's address and which carries no
 * signature Orbit can verify and align (none at all, one for another domain,
 * one whose selector has no key, one that does not verify) is filed for that
 * member as a content-free `sender_unsigned` failure, deleted, and answered
 * with nothing. The member's sending-address row records it in
 * `last_forward_unsigned_at` until a signed forward attributes. The receipt
 * notification goes at most once per member per rolling 24 hours; the rows
 * are all kept. TEMPFAIL keeps 87d's path; a From no member has verified is
 * still a stranger's.
 */
describe("an unsigned forward from a verified member (#1681, note 52496)", () => {
  const key = makeRsaKey();
  const HOUR_MS = 3_600_000;

  async function verifiedMember() {
    const config = await getImapIngestionConfig();
    await reconcileImapRecipientAliases(config);
    const member = fixture.users.member.id;
    const address = await verifiedSenderFor(member);
    const domain = address.slice(address.lastIndexOf("@") + 1);
    return { member, address, domain };
  }

  /** The member's `last_forward_unsigned_at`, read by its column name. */
  async function lastUnsignedAt(userId: string): Promise<Date | null> {
    const rows = await getDb().execute(sql`
      SELECT last_forward_unsigned_at AS at FROM mail_in_sender_addresses WHERE user_id = ${userId}
    `) as unknown as Array<{ at: Date | string | null }>;
    expect(rows, "the member has one sending-address row").toHaveLength(1);
    return rows[0].at === null ? null : new Date(rows[0].at);
  }

  async function fullReceipt(uidValidity: string) {
    const [row] = await getDb().select({
      id: imapIngestionMessages.id,
      userId: imapIngestionMessages.userId,
      status: imapIngestionMessages.status,
      failureCode: imapIngestionMessages.failureCode,
      attributedBy: imapIngestionMessages.attributedBy,
      receiptStatus: imapIngestionMessages.receiptStatus,
      proposalEnc: imapIngestionMessages.proposalEnc,
      fieldEvidenceEnc: imapIngestionMessages.fieldEvidenceEnc,
    }).from(imapIngestionMessages).where(eq(imapIngestionMessages.mailboxUidValidity, uidValidity));
    return row;
  }

  async function receiptDeliveriesFor(userId: string) {
    return getDb().select({ id: imapNotificationDeliveries.id, messageId: imapNotificationDeliveries.messageId })
      .from(imapNotificationDeliveries)
      .where(and(eq(imapNotificationDeliveries.userId, userId), eq(imapNotificationDeliveries.kind, "receipt")));
  }

  it("files a content-free sender_unsigned row for the member, deletes the message, sends no reply, sets last_forward_unsigned_at, and notifies once", async () => {
    const { member, address } = await verifiedMember();
    const before = Date.now();

    await collect(5001n, fixtureHeaders({ from: address }), Buffer.from(sampleMessage({ from: address })));

    const row = await fullReceipt("5001");
    expect(row).toMatchObject({
      userId: member, status: "failed", failureCode: "sender_unsigned", attributedBy: null,
      proposalEnc: null, fieldEvidenceEnc: null,
    });
    expect(deleted).toEqual(["1"]);
    expect(sent).toEqual([]);
    expect(await getDb().select({ id: imapIngestionAttachments.id }).from(imapIngestionAttachments)
      .where(eq(imapIngestionAttachments.messageId, row!.id))).toHaveLength(0);
    /* An unsigned message from a member costs no key lookup: there is no selector to look up. */
    expect(dns.lookups).toEqual([]);

    const at = await lastUnsignedAt(member);
    expect(at, "last_forward_unsigned_at is set").not.toBeNull();
    expect(at!.getTime()).toBeGreaterThanOrEqual(before - 1000);

    await materializeImapNotificationsForTests(new Date(), 25, member);
    await materializeImapNotificationsForTests(new Date(), 25, member);
    expect(await receiptDeliveriesFor(member)).toEqual([{ id: expect.any(String), messageId: row!.id }]);

    /* And the inbox lists it for the member, in the note's words, removable. */
    const receipts = (await listImapInbox(member)).receipts as unknown as Array<{ id: string; message: string; canApprove: boolean; canDiscard: boolean; reason: string }>;
    expect(receipts.find((receipt) => receipt.id === row!.id)).toMatchObject({
      canApprove: false,
      canDiscard: true,
      reason: "not_kept",
      message: "Orbit could not confirm this came from you, so it was not kept. Your mail service did not sign it (DKIM). Send it again from a service that signs, or ask whoever runs your mail domain to turn signing on.",
    });
  }, 20_000);

  it.each([
    ["a signature for an unrelated domain", "unrelated"],
    ["a signature whose selector has no key (NXDOMAIN)", "nxdomain"],
    ["a signature whose body hash does not verify", "tampered"],
  ] as const)("%s: the same outcome", async (_case, kind) => {
    const { member, address, domain } = await verifiedMember();
    const signingDomain = kind === "unrelated" ? "attacker.test" : domain;
    if (kind !== "nxdomain") dns.records.set(`s1._domainkey.${signingDomain}`, key.record);
    let source = await signMessage(sampleMessage({ from: address }), { domain: signingDomain, selector: "s1", key });
    if (kind === "tampered") source = Buffer.from(source.toString("utf8").replace("Last line", "Lost line"));
    const uidValidity = kind === "unrelated" ? 5011n : kind === "nxdomain" ? 5012n : 5013n;

    await collect(uidValidity, fixtureHeaders({ from: address }), source);

    expect(await fullReceipt(String(uidValidity))).toMatchObject({
      userId: member, status: "failed", failureCode: "sender_unsigned", attributedBy: null,
    });
    expect(deleted).toEqual(["1"]);
    expect(sent).toEqual([]);
    expect(await lastUnsignedAt(member)).not.toBeNull();
  }, 20_000);

  it("a key lookup that keeps failing temporarily still takes 87d's path: sender_dkim_unavailable, not sender_unsigned", async () => {
    const { member, address, domain } = await verifiedMember();
    dns.records.set(`s1._domainkey.${domain}`, key.record);
    const source = await signMessage(sampleMessage({ from: address }), { domain, selector: "s1", key });
    const headers = fixtureHeaders({ from: address });
    dns.failure = "ESERVFAIL";
    await collect(5021n, headers, source);
    expect(await fullReceipt("5021")).toMatchObject({ status: "held", failureCode: "sender_dkim_unavailable" });
    await getDb().update(imapIngestionMessages).set({ attachmentProcessingAttempts: 23, attachmentProcessingNextAttemptAt: null })
      .where(eq(imapIngestionMessages.mailboxUidValidity, "5021"));

    await collect(5021n, headers, source);

    expect(await fullReceipt("5021")).toMatchObject({ userId: member, status: "failed", failureCode: "sender_dkim_unavailable" });
    expect(await lastUnsignedAt(member), "a DNS failure says nothing about signing").toBeNull();
  }, 20_000);

  it("a later signed forward attributes and clears last_forward_unsigned_at; a later unsigned one sets it again", async () => {
    const { member, address, domain } = await verifiedMember();
    dns.records.set(`s1._domainkey.${domain}`, key.record);

    await collect(5031n, fixtureHeaders({ from: address }), Buffer.from(sampleMessage({ from: address })));
    expect(await lastUnsignedAt(member)).not.toBeNull();

    const signed = await signMessage(sampleMessage({ from: address }), { domain, selector: "s1", key });
    await collect(5032n, fixtureHeaders({ from: address }), signed);
    expect(await fullReceipt("5032")).toMatchObject({ userId: member, attributedBy: "sender" });
    expect(await lastUnsignedAt(member), "a signed forward that attributes clears it").toBeNull();

    await collect(5033n, fixtureHeaders({ from: address }), Buffer.from(sampleMessage({ from: address })));
    expect(await fullReceipt("5033")).toMatchObject({ userId: member, status: "failed", failureCode: "sender_unsigned" });
    expect(await lastUnsignedAt(member), "the next unsigned one sets it again").not.toBeNull();
  }, 30_000);

  it("three unsigned forwards within a day: three rows, one notification; another after 24 hours is notified again", async () => {
    const { member, address } = await verifiedMember();

    for (const uidValidity of [5041n, 5042n, 5043n]) {
      await collect(uidValidity, fixtureHeaders({ from: address }), Buffer.from(sampleMessage({ from: address })));
      await materializeImapNotificationsForTests(new Date(), 25, member);
    }

    const rows = await getDb().select({ id: imapIngestionMessages.id }).from(imapIngestionMessages).where(and(
      eq(imapIngestionMessages.userId, member),
      eq(imapIngestionMessages.failureCode, "sender_unsigned"),
    ));
    expect(rows, "every unsigned forward is listed").toHaveLength(3);
    expect(await receiptDeliveriesFor(member), "one notification in the day").toHaveLength(1);
    expect(sent).toEqual([]);

    /* The rolling window: the one notification is now 25 hours old. */
    await getDb().update(imapNotificationDeliveries).set({ createdAt: new Date(Date.now() - 25 * HOUR_MS) })
      .where(eq(imapNotificationDeliveries.userId, member));
    await collect(5044n, fixtureHeaders({ from: address }), Buffer.from(sampleMessage({ from: address })));
    await materializeImapNotificationsForTests(new Date(), 25, member);
    const fourth = await fullReceipt("5044");
    const deliveries = await receiptDeliveriesFor(member);
    expect(deliveries).toHaveLength(2);
    expect(deliveries.map((delivery) => delivery.messageId)).toContain(fourth!.id);
  }, 40_000);

  it("an unsigned forward from an address the member has not verified is still a stranger's: no row for them, no notification", async () => {
    const config = await getImapIngestionConfig();
    await reconcileImapRecipientAliases(config);
    const member = fixture.users.member.id;
    /* Seeded (claimed) but never checked. */
    await seedSenderAddress(member);
    const [claimed] = await listSenderAddresses(member);
    const address = claimed!.address!;

    await collect(5051n, fixtureHeaders({ from: address }), Buffer.from(sampleMessage({ from: address })));

    expect(await fullReceipt("5051")).toMatchObject({ userId: null, status: "unattributed" });
    expect((await fullReceipt("5051"))!.failureCode).not.toBe("sender_unsigned");
    expect(deleted).toEqual(["1"]);
    expect(sent).toEqual([]);
    await materializeImapNotificationsForTests(new Date(), 25, member);
    expect(await receiptDeliveriesFor(member)).toHaveLength(0);
    expect(await lastUnsignedAt(member)).toBeNull();
  }, 20_000);

  it("an unsigned message from an address no member has: still a stranger's, no sender_unsigned row anywhere", async () => {
    const config = await getImapIngestionConfig();
    await reconcileImapRecipientAliases(config);

    await collect(5052n, fixtureHeaders({ from: "stranger@example.test" }), Buffer.from(sampleMessage({ from: "stranger@example.test" })));

    expect(await fullReceipt("5052")).toMatchObject({ userId: null, status: "unattributed" });
    expect(await getDb().select({ id: imapIngestionMessages.id }).from(imapIngestionMessages)
      .where(eq(imapIngestionMessages.failureCode, "sender_unsigned"))).toHaveLength(0);
    expect(sent).toEqual([]);
  }, 20_000);
});

/*
 * #1722 (A-F3, note 53119): a forward over the 25 MiB raw limit cannot be
 * DKIM-verified, so from a verified member's address it is filed as its own
 * content-free `sender_too_large` failure, handled like `sender_unsigned`:
 * attributed to the member, never authenticated, no key lookup, no reply, the
 * message deleted, the member told in the note's words, one notification a
 * day shared with `sender_unsigned`, and nothing at all for a paused member.
 * `last_forward_unsigned_at` is not touched: the message was not unsigned, it
 * was unchecked. A From no member has verified stays a stranger's.
 */
describe("an oversized forward from a verified member (#1722, note 53119)", () => {
  const OVERSIZED_WORDS = "This message was over the 25 MiB size limit, so Orbit could not check that it came from you and did not keep it. Send it again with fewer or smaller attachments.";

  async function verifiedMember() {
    const config = await getImapIngestionConfig();
    await reconcileImapRecipientAliases(config);
    const member = fixture.users.member.id;
    const address = await verifiedSenderFor(member);
    return { member, address };
  }

  /** One message the server reports as over the raw limit; the body is never given. */
  async function collectOversized(uidValidity: bigint, headers: Buffer) {
    const config = await getImapIngestionConfig();
    setImapClientFactoryForTests(() => ({
      mailbox: { uidValidity, uidNext: 1_000_000 },
      async connect() {},
      async logout() {},
      async getMailboxLock() { return { release() {} }; },
      async search() { return [1]; },
      async messageDelete(range: string) { deleted.push(range); return true; },
      async fetchOne() { return { uid: 1, headers: Buffer.from(headers), size: IMAP_ATTACHMENT_LIMITS.rawMessageBytes + 1 }; },
    } as unknown as import("imapflow").ImapFlow));
    await runImapIngestionCycle(config, replyDependencies);
  }

  async function lastUnsignedAt(userId: string): Promise<Date | null> {
    const rows = await getDb().execute(sql`
      SELECT last_forward_unsigned_at AS at FROM mail_in_sender_addresses WHERE user_id = ${userId}
    `) as unknown as Array<{ at: Date | string | null }>;
    expect(rows).toHaveLength(1);
    return rows[0].at === null ? null : new Date(rows[0].at);
  }

  async function rows(uidValidity: string) {
    return getDb().select().from(imapIngestionMessages).where(eq(imapIngestionMessages.mailboxUidValidity, uidValidity));
  }

  async function receiptDeliveriesFor(userId: string) {
    return getDb().select({ id: imapNotificationDeliveries.id, messageId: imapNotificationDeliveries.messageId })
      .from(imapNotificationDeliveries)
      .where(and(eq(imapNotificationDeliveries.userId, userId), eq(imapNotificationDeliveries.kind, "receipt")));
  }

  it("files a content-free sender_too_large row for the member, deletes the message, looks up no key, replies to nobody, and lists it in their words", async () => {
    const { member, address } = await verifiedMember();

    await collectOversized(7001n, fixtureHeaders({ from: address }));

    const filed = await rows("7001");
    expect(filed).toHaveLength(1);
    expect(filed[0]).toMatchObject({
      userId: member, status: "failed", failureCode: "sender_too_large", attributedBy: null, receiptStatus: "processing",
      proposalEnc: null, fieldEvidenceEnc: null,
    });
    expect(dns.lookups, "no DKIM verdict is needed").toEqual([]);
    expect(sent).toEqual([]);
    expect(deleted).toEqual(["1"]);
    expect(await lastUnsignedAt(member), "it was unchecked, not unsigned").toBeNull();
    expect(await getDb().select({ id: imapIngestionAttachments.id }).from(imapIngestionAttachments)
      .where(eq(imapIngestionAttachments.messageId, filed[0].id))).toHaveLength(0);

    expect(reviewInboxState("failed", "sender_too_large").message).toContain("size limit");
    expect(isRemovableTerminalFailure("failed", "sender_too_large")).toBe(true);
    expect(failureReasonOf("sender_too_large")).toBe("too_large");
    const receipts = (await listImapInbox(member)).receipts as unknown as Array<{ id: string; message: string; canApprove: boolean; canDiscard: boolean; reason: string }>;
    expect(receipts.find((receipt) => receipt.id === filed[0].id)).toMatchObject({
      canApprove: false, canDiscard: true, reason: "too_large", message: OVERSIZED_WORDS,
    });
  }, 20_000);

  it("leaves last_forward_unsigned_at as an earlier unsigned forward set it", async () => {
    const { member, address } = await verifiedMember();
    await collect(7011n, fixtureHeaders({ from: address }), Buffer.from(sampleMessage({ from: address })));
    const before = await lastUnsignedAt(member);
    expect(before).not.toBeNull();

    await collectOversized(7012n, fixtureHeaders({ from: address }));

    expect((await rows("7012"))[0]).toMatchObject({ userId: member, failureCode: "sender_too_large" });
    expect(await lastUnsignedAt(member)).toEqual(before);
  }, 20_000);

  it("a second oversized forward within a day is listed but gives no second notification", async () => {
    const { member, address } = await verifiedMember();

    for (const uidValidity of [7021n, 7022n]) {
      await collectOversized(uidValidity, fixtureHeaders({ from: address }));
      await materializeImapNotificationsForTests(new Date(), 25, member);
    }

    expect(await getDb().select({ id: imapIngestionMessages.id }).from(imapIngestionMessages).where(and(
      eq(imapIngestionMessages.userId, member), eq(imapIngestionMessages.failureCode, "sender_too_large"),
    ))).toHaveLength(2);
    expect(await receiptDeliveriesFor(member)).toHaveLength(1);
    expect(sent).toEqual([]);
  }, 30_000);

  it("shares the once-a-day window with sender_unsigned: an unsigned forward then an oversized one gives one notification", async () => {
    const { member, address } = await verifiedMember();

    await collect(7031n, fixtureHeaders({ from: address }), Buffer.from(sampleMessage({ from: address })));
    await materializeImapNotificationsForTests(new Date(), 25, member);
    await collectOversized(7032n, fixtureHeaders({ from: address }));
    await materializeImapNotificationsForTests(new Date(), 25, member);

    expect((await rows("7032"))[0]).toMatchObject({ userId: member, failureCode: "sender_too_large" });
    expect(await receiptDeliveriesFor(member)).toHaveLength(1);
  }, 30_000);

  it("a member who has paused collection is told nothing: a discarded row, no notification, no reply, the message deleted", async () => {
    const { member, address } = await verifiedMember();
    await setRelayIngestPaused(member, true);

    await collectOversized(7041n, fixtureHeaders({ from: address }));
    await materializeImapNotificationsForTests(new Date(), 25, member);

    expect((await rows("7041"))[0]).toMatchObject({ userId: member, status: "discarded", failureCode: "sender_too_large" });
    expect((await listImapInbox(member)).receipts).toEqual([]);
    expect(await receiptDeliveriesFor(member)).toEqual([]);
    expect(sent).toEqual([]);
    expect(deleted).toEqual(["1"]);
    expect(dns.lookups).toEqual([]);
  }, 20_000);
});

/*
 * #1681 review findings on note 52496's build.
 *
 * Pause (ADR-0017 decision 2): a paused member is told nothing. Decided by the
 * lane, following the ratified ADR (the owner can overrule): while the
 * member's collection is paused, an unsigned forward or one whose key lookup
 * stayed unavailable past the retry window leaves no row in their inbox, sends
 * them no notification and no reply, and the message is deleted.
 * last_forward_unsigned_at is still set for an unsigned one: the relay page is
 * something they look at, not a notification.
 *
 * Rate limit: removing a sender_unsigned row must not reopen the 24-hour
 * notification window.
 *
 * Delete retry: removing a sender_unsigned / sender_dkim_unavailable row before
 * its mailbox delete has landed must not leave the raw message on the server.
 */
describe("note 52496 review findings (#1681)", () => {
  const key = makeRsaKey();

  async function verifiedMember() {
    const config = await getImapIngestionConfig();
    await reconcileImapRecipientAliases(config);
    const member = fixture.users.member.id;
    const address = await verifiedSenderFor(member);
    const domain = address.slice(address.lastIndexOf("@") + 1);
    return { member, address, domain };
  }

  async function lastUnsignedAt(userId: string): Promise<Date | null> {
    const rows = await getDb().execute(sql`
      SELECT last_forward_unsigned_at AS at FROM mail_in_sender_addresses WHERE user_id = ${userId}
    `) as unknown as Array<{ at: Date | string | null }>;
    expect(rows, "the member has one sending-address row").toHaveLength(1);
    return rows[0].at === null ? null : new Date(rows[0].at);
  }

  async function rowIdFor(uidValidity: string) {
    const [row] = await getDb().select({ id: imapIngestionMessages.id }).from(imapIngestionMessages)
      .where(eq(imapIngestionMessages.mailboxUidValidity, uidValidity));
    return row?.id;
  }

  async function deliveriesFor(userId: string) {
    return getDb().select({ id: imapNotificationDeliveries.id, kind: imapNotificationDeliveries.kind, messageId: imapNotificationDeliveries.messageId })
      .from(imapNotificationDeliveries).where(eq(imapNotificationDeliveries.userId, userId));
  }

  /** One message in the mailbox, whose provider refuses the first `failures` deletes. */
  function mailboxRefusingDeletes(uidValidity: bigint, headers: Buffer, source: Buffer, failures: number) {
    let refused = 0;
    setImapClientFactoryForTests(() => ({
      mailbox: { uidValidity, uidNext: 1_000_000 },
      async connect() {},
      async logout() {},
      async getMailboxLock() { return { release() {} }; },
      async search() { return [1]; },
      async messageDelete(range: string) {
        if (refused < failures) { refused += 1; throw new Error("provider refused the delete"); }
        deleted.push(range);
        return true;
      },
      async fetchOne() { return { uid: 1, headers: Buffer.from(headers), source: Buffer.from(source) }; },
    } as unknown as import("imapflow").ImapFlow));
  }

  describe("a member who has paused collection is told nothing (ADR-0017 decision 2)", () => {
    it("an unsigned forward: no inbox row, no notification, no reply, the message deleted, last_forward_unsigned_at set", async () => {
      const { member, address } = await verifiedMember();
      await setRelayIngestPaused(member, true);

      await collect(6001n, fixtureHeaders({ from: address }), Buffer.from(sampleMessage({ from: address })));
      await materializeImapNotificationsForTests(new Date(), 25, member);

      expect((await listImapInbox(member)).receipts, "nothing in the paused member's inbox").toEqual([]);
      expect(await deliveriesFor(member), "no notification of any kind").toEqual([]);
      expect(sent).toEqual([]);
      expect(deleted).toEqual(["1"]);
      expect(await lastUnsignedAt(member), "the relay page still shows the last forward was unsigned").not.toBeNull();
    }, 20_000);

    it("a key lookup that stayed unavailable past the retry window: no inbox row, no notification, no reply, the message deleted", async () => {
      const { member, address, domain } = await verifiedMember();
      dns.records.set(`s1._domainkey.${domain}`, key.record);
      const source = await signMessage(sampleMessage({ from: address }), { domain, selector: "s1", key });
      const headers = fixtureHeaders({ from: address });
      await setRelayIngestPaused(member, true);
      dns.failure = "ESERVFAIL";
      await collect(6002n, headers, source);
      expect(deleted, "still held for a retry").toEqual([]);
      await getDb().update(imapIngestionMessages).set({ attachmentProcessingAttempts: 23, attachmentProcessingNextAttemptAt: null })
        .where(eq(imapIngestionMessages.mailboxUidValidity, "6002"));

      await collect(6002n, headers, source);
      await materializeImapNotificationsForTests(new Date(), 25, member);

      expect((await listImapInbox(member)).receipts, "nothing in the paused member's inbox").toEqual([]);
      expect(await deliveriesFor(member), "no notification of any kind").toEqual([]);
      expect(sent).toEqual([]);
      expect(deleted).toContain("1");
      expect(await lastUnsignedAt(member), "a DNS failure says nothing about signing").toBeNull();
    }, 20_000);
  });

  it("removing a notified sender_unsigned row does not reopen the 24-hour window: the next forged forward is not notified", async () => {
    const { member, address } = await verifiedMember();

    await collect(6011n, fixtureHeaders({ from: address }), Buffer.from(sampleMessage({ from: address })));
    await materializeImapNotificationsForTests(new Date(), 25, member);
    const first = await rowIdFor("6011");
    expect((await deliveriesFor(member)).filter((delivery) => delivery.kind === "receipt"), "the first is notified")
      .toEqual([{ id: expect.any(String), kind: "receipt", messageId: first }]);

    await discardImapReviewItem(member, first!);

    await collect(6012n, fixtureHeaders({ from: address }), Buffer.from(sampleMessage({ from: address })));
    await materializeImapNotificationsForTests(new Date(), 25, member);
    const second = await rowIdFor("6012");
    expect(second).toBeDefined();
    const receipts = (await deliveriesFor(member)).filter((delivery) => delivery.kind === "receipt");
    expect(receipts.map((delivery) => delivery.messageId), "one notification in the day, whatever was removed").toEqual([first]);
  }, 30_000);

  it.each([
    ["sender_unsigned", 6021n],
    ["sender_dkim_unavailable", 6022n],
  ] as const)("a %s row removed before its mailbox delete landed: the next cycle still deletes the message", async (code, uidValidity) => {
    const { member, address, domain } = await verifiedMember();
    const config = await getImapIngestionConfig();
    const headers = fixtureHeaders({ from: address });
    let source: Buffer = Buffer.from(sampleMessage({ from: address }));
    if (code === "sender_dkim_unavailable") {
      dns.records.set(`s1._domainkey.${domain}`, key.record);
      source = await signMessage(sampleMessage({ from: address }), { domain, selector: "s1", key });
      dns.failure = "ESERVFAIL";
      mailboxRefusingDeletes(uidValidity, headers, source, 0);
      await runImapIngestionCycle(config, replyDependencies);
      await getDb().update(imapIngestionMessages).set({ attachmentProcessingAttempts: 23, attachmentProcessingNextAttemptAt: null })
        .where(eq(imapIngestionMessages.mailboxUidValidity, String(uidValidity)));
    }

    /* The cycle that files the row: the provider refuses the delete. */
    mailboxRefusingDeletes(uidValidity, headers, source, 1);
    await runImapIngestionCycle(config, replyDependencies);
    expect(deleted, "the first delete did not land").toEqual([]);
    const [row] = await getDb().select({ id: imapIngestionMessages.id, userId: imapIngestionMessages.userId, status: imapIngestionMessages.status, failureCode: imapIngestionMessages.failureCode })
      .from(imapIngestionMessages).where(eq(imapIngestionMessages.mailboxUidValidity, String(uidValidity)));
    expect(row).toMatchObject({ userId: member, status: "failed", failureCode: code });

    await discardImapReviewItem(member, row!.id);

    /* The next cycle: the provider now deletes. */
    mailboxRefusingDeletes(uidValidity, headers, source, 0);
    await runImapIngestionCycle(config, replyDependencies);
    expect(deleted, "the raw message does not stay in the mailbox").toEqual(["1"]);
    expect(sent).toEqual([]);
  }, 30_000);
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

describe("a comment in From cannot name the sender (S-authn-1, #1722)", () => {
  const key = makeRsaKey();

  /* recordForwardSigning writes only last_forward_unsigned_at: "signed" clears
     it, "unsigned" overwrites it. A fixed earlier value shows neither ran. */
  const EARLIER = new Date("2026-11-01T09:00:00.000Z");

  async function lastUnsignedAt(userId: string): Promise<number | null> {
    const rows = await getDb().execute(sql`
      SELECT last_forward_unsigned_at AS at FROM mail_in_sender_addresses WHERE user_id = ${userId}
    `) as unknown as Array<{ at: Date | string | null }>;
    return rows[0].at === null ? null : new Date(rows[0].at).getTime();
  }

  it("leaves the message unattributed when the member's verified address is only in a trailing comment", async () => {
    const config = await getImapIngestionConfig();
    await reconcileImapRecipientAliases(config);
    const member = fixture.users.member.id;
    const victim = await verifiedSenderFor(member);
    const domain = victim.slice(victim.lastIndexOf("@") + 1);
    const attacker = `attacker@${domain}`;
    const fromValue = `Attacker <${attacker}> (re: <${victim}>)`;
    dns.records.set(`s1._domainkey.${domain}`, key.record);
    /* A genuine signature by the From domain, aligned with the real address. */
    const unsigned = sampleMessage({ from: attacker }).replace(/^From: .*$/m, `From: ${fromValue}`);
    const source = await signMessage(unsigned, { domain, selector: "s1", key });
    await getDb().update(mailInSenderAddresses).set({ lastForwardUnsignedAt: EARLIER }).where(eq(mailInSenderAddresses.userId, member));

    await collect(6001n, fixtureHeaders({ from: fromValue }), source);

    expect(await receiptFor("6001")).toMatchObject({
      userId: null, status: "unattributed", failureCode: "sender_unverified", attributedBy: null,
    });
    /* recordForwardSigning did not run for the victim: the column is as it was. */
    expect(await lastUnsignedAt(member)).toBe(EARLIER.getTime());
    /* Never to the victim; the ordinary stranger reply may go to the From's own address. */
    expect(sent.map((message) => message.to)).not.toContain(victim);
    expect(sent.length).toBeLessThanOrEqual(1);
    for (const message of sent) expect(message.to).toBe(attacker);
    expect(deleted).toEqual(["1"]);
  }, 20_000);
});

/*
 * #1681: a MAIL_IN_DKIM_DNS_SERVERS typo must not delete mail. Fail closed
 * (validate configuration, stop without side effects): a malformed setting
 * makes the cycle read nothing and change nothing, and say so in the
 * operational log as the key-locked case does (state "blocked", action
 * "check_configuration"), here with reason "configuration_invalid".
 */
describe("a malformed MAIL_IN_DKIM_DNS_SERVERS stops ingestion without side effects (#1681)", () => {
  const key = makeRsaKey();
  const rowCount = async () => (await getDb().select({ id: imapIngestionMessages.id }).from(imapIngestionMessages)).length;

  afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

  it.each(["a,,b", "192.0.2.1:99999"])("with %j: several cycles leave the mail, rows and notifications alone and log the fault; fixing it attributes the message", async (bad) => {
    const config = await getImapIngestionConfig();
    await reconcileImapRecipientAliases(config);
    const address = await verifiedSenderFor(fixture.users.member.id);
    const domain = address.slice(address.lastIndexOf("@") + 1);
    dns.records.set(`s1._domainkey.${domain}`, key.record);
    const headers = fixtureHeaders({ from: address });
    const source = await signMessage(sampleMessage({ from: address }), { domain, selector: "s1", key });
    const lines: string[] = [];
    const record = (line: unknown) => { lines.push(String(line)); };
    vi.spyOn(console, "error").mockImplementation(record);
    vi.spyOn(console, "warn").mockImplementation(record);
    vi.spyOn(console, "log").mockImplementation(record);
    vi.stubEnv("MAIL_IN_DKIM_DNS_SERVERS", bad);

    for (let cycle = 0; cycle < 3; cycle += 1) await collect(3900n, headers, source);

    expect(deleted).toEqual([]);
    expect(await rowCount()).toBe(0);
    expect(await receiptFor("3900")).toBeUndefined();
    expect(await getDb().select().from(imapNotificationDeliveries)).toEqual([]);
    expect(sent).toEqual([]);
    expect(dns.lookups).toEqual([]);
    expect(lines.join("\n")).toMatch(/configuration_invalid/u);
    expect(lines.join("\n")).toMatch(/check_configuration/u);
    expect(lines.join("\n")).not.toContain(bad);

    vi.stubEnv("MAIL_IN_DKIM_DNS_SERVERS", "");
    await collect(3900n, headers, source);

    expect(await receiptFor("3900")).toMatchObject({ userId: fixture.users.member.id, attributedBy: "sender" });
    expect(deleted).toEqual([]);
  }, 30_000);
});

/*
 * #1681: the fault is logged once per distinct bad value, and the recovery is
 * logged once, so a typo is neither silent nor a line per poll. Neither line
 * carries the setting's value. The cycle's own calls to the logger are
 * recorded: the logger itself also de-duplicates identical records for a
 * minute and renders a "ready" after a failure as "recovered", either of which
 * would hide what the cycle decided.
 */
describe("the DKIM resolver setting fault and its recovery are each logged once (#1681)", () => {
  let calls: Array<{ level: string; event: Record<string, unknown> }>;
  let rendered: string[];
  const WARNING = { event: "imap.ingestion", state: "blocked", reason: "configuration_invalid", action: "check_configuration", impact: "mail_receipt_delayed" };
  const READY = { event: "imap.ingestion", state: "ready", action: "none" };

  /** An empty mailbox: a valid cycle reads nothing, so only the log is under test. */
  async function cycle(value: string | undefined) {
    setImapClientFactoryForTests(() => ({
      mailbox: { uidValidity: 7n, uidNext: 1 },
      async connect() {},
      async logout() {},
      async getMailboxLock() { return { release() {} }; },
      async search() { return []; },
    } as unknown as import("imapflow").ImapFlow));
    if (value === undefined) vi.unstubAllEnvs(); else vi.stubEnv("MAIL_IN_DKIM_DNS_SERVERS", value);
    await runImapIngestionCycle(await getImapIngestionConfig(), replyDependencies);
  }

  const warnings = () => calls.filter((c) => c.level === "warn" && c.event.reason === "configuration_invalid");
  const readies = () => calls.filter((c) => c.level === "info" && c.event.state === "ready");

  beforeEach(async () => {
    calls = [];
    rendered = [];
    for (const level of ["error", "warn", "info"] as const) {
      vi.spyOn(log, level).mockImplementation(((event: Record<string, unknown>) => { calls.push({ level, event }); }) as never);
    }
    const record = (line: unknown) => { rendered.push(String(line)); };
    vi.spyOn(console, "error").mockImplementation(record);
    vi.spyOn(console, "warn").mockImplementation(record);
    vi.spyOn(console, "log").mockImplementation(record);
    // Known starting point: any fault left by an earlier test is cleared first.
    await cycle("");
    calls.length = 0;
  });

  afterEach(async () => {
    await cycle("");
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("logs the warning once for the same bad value over several cycles", async () => {
    for (let i = 0; i < 4; i += 1) await cycle("a,,b");

    expect(warnings()).toEqual([{ level: "warn", event: WARNING }]);
  }, 30_000);

  it("logs the warning again for a different bad value", async () => {
    await cycle("a,,b");
    await cycle("a,,b");
    await cycle("192.0.2.1:99999");
    await cycle("192.0.2.1:99999");

    expect(warnings()).toEqual([{ level: "warn", event: WARNING }, { level: "warn", event: WARNING }]);
  }, 30_000);

  it.each([["a valid value", "192.0.2.1"], ["unset", undefined]])("logs the ready line exactly once when the setting becomes %s, and not again", async (_name, fixed) => {
    await cycle("a,,b");
    expect(readies()).toEqual([]);

    await cycle(fixed);
    expect(readies()).toEqual([{ level: "info", event: READY }]);
    await cycle(fixed);
    await cycle(fixed);

    expect(readies()).toHaveLength(1);
    expect(warnings()).toHaveLength(1);
  }, 30_000);

  it("reports a fault again after a recovery", async () => {
    await cycle("a,,b");
    await cycle("");
    await cycle("a,,b");

    expect(warnings()).toHaveLength(2);
    expect(readies()).toHaveLength(1);
  }, 30_000);

  it("never logs the ready line for a valid setting with no earlier fault", async () => {
    await cycle("192.0.2.1");
    await cycle("192.0.2.1");
    await cycle(undefined);

    expect(readies()).toEqual([]);
    expect(warnings()).toEqual([]);
  }, 30_000);

  it("never puts the setting's value in the warning or the ready line", async () => {
    const bad = "zz-secret-marker,,9";
    await cycle(bad);
    await cycle(bad);
    await cycle("");

    expect(warnings()).toHaveLength(1);
    expect(readies()).toHaveLength(1);
    expect(JSON.stringify(calls)).not.toContain("zz-secret-marker");
    expect(rendered.join("\n")).not.toContain("zz-secret-marker");
  }, 30_000);
});
