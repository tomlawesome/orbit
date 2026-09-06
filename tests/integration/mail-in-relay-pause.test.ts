import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/db";
import {
  auditLog,
  imapIngestionAttachments,
  imapIngestionMessages,
  imapIngestionStagingObjects,
  imapNotificationDeliveries,
  imapRecipientAliases,
  mailInMailbox,
  mailInRelays,
  mailInSecrets,
  mailInSenderAddresses,
} from "@/db/schema";
import { getImapIngestionConfig } from "@/server/mail-in/mailbox-config";
import { setMailboxSettings, type MailboxSettingsDependencies, type MailboxSettingsInput } from "@/server/mail-in/mailbox-settings";
import {
  imapRecipientAlias,
  reconcileImapRecipientAliases,
  runImapIngestionCycle,
  setImapClientFactoryForTests,
} from "@/server/mail-in/imap-ingestion";
import { purgeExpiredImapStaging } from "@/server/mail-in/imap-inbox";
import { readRelaySettings, setRelayIngest } from "@/server/mail-in/relay-settings";
import { readRelayRow, relayAddressFor, setRelayIngestPaused } from "@/server/mail-in/relays";
import { cleanupIntegrationEnvironment, createIntegrationFixture, type IntegrationFixture } from "./support/fixtures";
import { attributedHeaders, TRUSTED_AUTHSERV_ID, verifiedSenderFor } from "./support/mail-in";
import { syntheticPdf } from "../support/synthetic-documents";

/*
 * ADR-0017 slice 5 (orbit#746): per-user ingest pause, against a real database.
 *
 * Two claims. Paused mail is HELD rather than skipped or processed: the
 * receipt says it arrived and nothing else, and resuming stages it exactly
 * once. And the sibling invariant from slice 3 holds for pause as it does for
 * rotation — pausing A leaves B's rows, B's address and B's mail alone.
 */
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
  password: "fake-pause-password",
};
const providerReady: MailboxSettingsDependencies = { verifyImap: async () => "ready" };

const pdfBodyStructure = {
  part: "1", type: "application", subtype: "pdf", disposition: "attachment",
  dispositionParameters: { filename: "held.pdf" }, size: 64,
} as never;

let fixture: IntegrationFixture;
/** Every attachment part the provider was asked to download. */
let downloads: string[];

beforeEach(async () => {
  fixture = await createIntegrationFixture("relay-pause");
  downloads = [];
  await setMailboxSettings(fixture.users.admin.id, null, settings, providerReady);
});

afterEach(async () => {
  const db = getDb();
  setImapClientFactoryForTests(undefined);
  await db.delete(imapNotificationDeliveries);
  await db.delete(imapIngestionStagingObjects);
  await db.delete(imapIngestionAttachments);
  await db.delete(imapIngestionMessages);
  await db.delete(imapRecipientAliases);
  await db.delete(mailInRelays);
  await db.delete(mailInSenderAddresses);
  await db.update(mailInMailbox).set({ passwordSecretId: null, aliasKeySecretId: null });
  await db.delete(mailInMailbox);
  await db.delete(mailInSecrets);
  await db.delete(auditLog);
  await fixture.cleanup();
});

afterAll(async () => {
  await cleanupIntegrationEnvironment();
});

/** A mailbox holding one message per UID, from whichever sender we name. */
function mailboxHolding(uidValidity: bigint, messages: Array<{ uid: number; headers: Buffer }>) {
  setImapClientFactoryForTests(() => ({
    mailbox: { uidValidity, uidNext: 1_000_000 },
    async connect() {},
    async logout() {},
    async getMailboxLock() { return { release() {} }; },
    async search() { return messages.map((message) => message.uid); },
    async messageDelete() { return true; },
    async fetchOne(uid: string) {
      const message = messages.find((candidate) => candidate.uid === Number(uid));
      /* A fresh copy every fetch: the engine zeroes the header buffer it was
         handed as soon as it is done with it, so handing the same one out
         twice would make the second pass see a message with no headers at
         all — and a message with no headers belongs to nobody. */
      return message
        ? { uid: message.uid, headers: Buffer.from(message.headers), source: Buffer.from(`held-${message.uid}`), bodyStructure: pdfBodyStructure }
        : undefined;
    },
    async download(uid: number, part: string) {
      downloads.push(`${uid}:${part}`);
      return { content: syntheticPdf("held attachment") };
    },
  } as unknown as import("imapflow").ImapFlow));
}

async function receiptsFor(uidValidity: string) {
  return getDb().select({
    uid: imapIngestionMessages.mailboxUid,
    userId: imapIngestionMessages.userId,
    status: imapIngestionMessages.status,
    receiptStatus: imapIngestionMessages.receiptStatus,
    expiresAt: imapIngestionMessages.expiresAt,
  }).from(imapIngestionMessages)
    .where(eq(imapIngestionMessages.mailboxUidValidity, uidValidity))
    .orderBy(imapIngestionMessages.mailboxUid);
}

describe("per-user ingest pause (ADR-0017 slice 5)", () => {
  it("holds a paused member's mail with no staging object and no notification (acceptance 1)", async () => {
    const config = await getImapIngestionConfig();
    const member = fixture.users.member.id;
    await reconcileImapRecipientAliases(config);
    const sender = await verifiedSenderFor(member, "paused@example.test");
    await setRelayIngestPaused(member, true);

    mailboxHolding(3001n, [{ uid: 1, headers: attributedHeaders(sender) }]);
    await runImapIngestionCycle(config);

    const [receipt] = await receiptsFor("3001");
    /* It is recorded as this member's, and left entirely alone: the receipt
       exists so the message is not lost, and nothing else happened at all. */
    expect(receipt).toMatchObject({ userId: member, status: "held", receiptStatus: "cancelled" });
    expect(downloads).toEqual([]);
    expect(await getDb().select({ id: imapIngestionStagingObjects.id }).from(imapIngestionStagingObjects)).toHaveLength(0);
    expect(await getDb().select({ id: imapIngestionAttachments.id }).from(imapIngestionAttachments)).toHaveLength(0);
    expect(await getDb().select({ id: imapNotificationDeliveries.id }).from(imapNotificationDeliveries)
      .where(eq(imapNotificationDeliveries.userId, member))).toHaveLength(0);

    const paused = await getDb().select({ action: auditLog.action, entityId: auditLog.entityId })
      .from(auditLog).where(eq(auditLog.action, "mail_in_relay_paused"));
    expect(paused).toEqual([{ action: "mail_in_relay_paused", entityId: member }]);
  }, 30_000);

  it("stages held mail exactly once on resume, however often the retry pass runs (acceptance 2)", async () => {
    const config = await getImapIngestionConfig();
    const member = fixture.users.member.id;
    await reconcileImapRecipientAliases(config);
    const sender = await verifiedSenderFor(member, "resume@example.test");
    await setRelayIngestPaused(member, true);

    mailboxHolding(3002n, [{ uid: 1, headers: attributedHeaders(sender) }]);
    await runImapIngestionCycle(config);
    expect((await receiptsFor("3002"))[0].status).toBe("held");

    await setRelayIngestPaused(member, false);
    expect((await receiptsFor("3002"))[0].status).toBe("processing");

    /* Three passes over the same UID. The exact-UID retry pass fetches it, and
       the "exactly once" is the predicate's doing: only rows still `held`
       move, so nothing is taken twice. */
    await runImapIngestionCycle(config);
    await runImapIngestionCycle(config);
    await runImapIngestionCycle(config);

    /* Fetched once and only once, however many passes ran over it — which is
       what "stages it exactly once" means at the boundary this suite can see.
       (Whether the staged bytes then survive the malware scan depends on
       whether a scanner is configured, which is not this slice's business.) */
    expect(downloads).toEqual(["1:1"]);
    const [receipt] = await receiptsFor("3002");
    /* One receipt, one outcome: the message never became two, and it is no
       longer waiting on the pause. */
    expect(await receiptsFor("3002")).toHaveLength(1);
    expect(receipt.status).not.toBe("held");
    expect(receipt.status).not.toBe("processing");

    const resumed = await getDb().select({ action: auditLog.action, entityId: auditLog.entityId })
      .from(auditLog).where(eq(auditLog.action, "mail_in_relay_resumed"));
    expect(resumed).toEqual([{ action: "mail_in_relay_resumed", entityId: member }]);
  }, 40_000);

  it("expires a held receipt on the ordinary schedule (acceptance 3)", async () => {
    const config = await getImapIngestionConfig();
    const member = fixture.users.member.id;
    await reconcileImapRecipientAliases(config);
    const sender = await verifiedSenderFor(member, "expiring@example.test");
    await setRelayIngestPaused(member, true);

    mailboxHolding(3003n, [{ uid: 1, headers: attributedHeaders(sender) }]);
    await runImapIngestionCycle(config);
    const [held] = await receiptsFor("3003");
    expect(held.status).toBe("held");
    /* The ordinary receipt expiry, not one of its own: a held message is still
       a message that arrived and is still on the same clock. */
    expect(held.expiresAt.getTime()).toBeGreaterThan(Date.now());

    await getDb().update(imapIngestionMessages)
      .set({ expiresAt: new Date(Date.now() - 1_000) })
      .where(eq(imapIngestionMessages.mailboxUidValidity, "3003"));
    await purgeExpiredImapStaging(new Date(), 25);

    /* Nothing is left holding bytes, and nothing was ever staged to leave. */
    expect((await receiptsFor("3003"))[0].status).toBe("expired");
    expect(await getDb().select({ id: imapIngestionStagingObjects.id }).from(imapIngestionStagingObjects)).toHaveLength(0);
  }, 30_000);

  it("leaves a sibling's rows, address and mail untouched when one member pauses (acceptance 4)", async () => {
    const config = await getImapIngestionConfig();
    const a = fixture.users.owner.id;
    const b = fixture.users.member.id;
    await reconcileImapRecipientAliases(config);
    const senderA = await verifiedSenderFor(a, "pause-a@example.test");
    const senderB = await verifiedSenderFor(b, "pause-b@example.test");
    const relayB = await readRelayRow(b);
    const addressB = relayAddressFor(b, relayB!.currentGeneration, config);
    const aliasA = imapRecipientAlias(a, config, (await readRelayRow(a))!.currentGeneration);
    const rowsBefore = await getDb().select().from(imapRecipientAliases).where(eq(imapRecipientAliases.userId, b));

    await setRelayIngest({ id: a, isInstanceAdmin: false }, true);

    /* Byte-identical, and B's relay row untouched: pausing has no wider
       predicate than rotating does. */
    expect(relayAddressFor(b, (await readRelayRow(b))!.currentGeneration, config)).toBe(addressB);
    expect(await getDb().select().from(imapRecipientAliases).where(eq(imapRecipientAliases.userId, b))).toEqual(rowsBefore);
    expect((await readRelayRow(b))!.ingestPausedAt).toBeNull();
    expect((await readRelayRow(a))!.ingestPausedAt).not.toBeNull();

    mailboxHolding(3004n, [
      { uid: 1, headers: attributedHeaders(senderA, aliasA) },
      { uid: 2, headers: attributedHeaders(senderB, addressB) },
    ]);
    await runImapIngestionCycle(config);

    const receipts = await receiptsFor("3004");
    /* A's is held and untouched; B's went straight on to attachment
       processing, which is what "B's mail is still processed" means. */
    expect(receipts.map((row) => [row.uid, row.userId, row.status === "held"])).toEqual([
      [1, a, true],
      [2, b, false],
    ]);
    /* Only B's attachment was ever fetched. */
    expect(downloads).toEqual(["2:1"]);

    /* And what each of them sees says so, in their own words. */
    expect((await readRelaySettings({ id: a, isInstanceAdmin: false })).ingest).toBe("paused");
    expect((await readRelaySettings({ id: b, isInstanceAdmin: false })).ingest).toBe("enabled");
  }, 40_000);

  it("does nothing, and audits nothing, when a member pauses twice", async () => {
    const member = fixture.users.member.id;
    await setRelayIngestPaused(member, true);
    const first = await readRelayRow(member);
    await setRelayIngestPaused(member, true);
    const second = await readRelayRow(member);

    expect(second).toEqual(first);
    expect(await getDb().select({ id: auditLog.id }).from(auditLog)
      .where(and(eq(auditLog.action, "mail_in_relay_paused"), eq(auditLog.entityId, member)))).toHaveLength(1);
  }, 20_000);
});
