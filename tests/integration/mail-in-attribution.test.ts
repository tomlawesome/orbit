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
  users,
} from "@/db/schema";
import { listImapInbox } from "@/server/mail-in/imap-inbox";
import { listSenderAddresses, seedSenderAddress, userForVerifiedSender } from "@/server/mail-in/sender-addresses";
import { resetDocumentConfigForTests } from "@/server/documents/config";
import { metadataCryptoAvailable } from "@/server/metadata/keys";
import { getImapIngestionConfig } from "@/server/mail-in/mailbox-config";
import { setMailboxSettings, type MailboxSettingsDependencies, type MailboxSettingsInput } from "@/server/mail-in/mailbox-settings";
import {
  imapRecipientAlias,
  reconcileImapRecipientAliases,
  runImapIngestionCycle,
  setImapClientFactoryForTests,
} from "@/server/mail-in/imap-ingestion";
import { readRelayRow } from "@/server/mail-in/relays";
import { unattributedReplyText } from "@/server/mail-in/unattributed-reply";
import { cleanupIntegrationEnvironment, createIntegrationFixture, type IntegrationFixture } from "./support/fixtures";
import { attributedHeaders, fixtureHeaders, TRUSTED_AUTHSERV_ID, verifiedSenderFor, fakeImapMailbox } from "./support/mail-in";
import { fromOfHeaders, signedSource } from "./support/dkim-fixture";

/* #1681: the only evidence is the message's own DKIM signature, so every
   source below is signed by its From's domain with the fixture key, which this
   stub publishes; a case that must carry no signature says `unsigned`. */
vi.mock("node:dns/promises", async () => (await import("./support/dkim-fixture")).fixtureDnsModule());

/*
 * ADR-0017 slice 4 (orbit#745): attribution by verified sender, against a real
 * database. These are the issue's seven acceptance criteria, in order.
 *
 * The claim under test is that a `From` header is worth nothing on its own. It
 * attributes only when the address is one a member has verified AND the
 * message carries a DKIM signature for that address's domain that Orbit
 * verified itself (#1681: a provider's Authentication-Results header is not
 * evidence, whoever wrote it); everything else is unattributed,
 * deleted, and answered at most once — and never answered at all when
 * answering could be turned against somebody.
 */
/* Still carries the retired `trustedAuthservId`, as a v0.3.6 configuration
   does (#1681): the API ignores it, and the old code trusted it. */
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
  fixture = await createIntegrationFixture("mail-in-attribution");
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
  await fixture.cleanup();
});

afterAll(async () => {
  await cleanupIntegrationEnvironment();
});

/**
 * The message source for `headers`: signed by its From's own domain, unless
 * the case is about a message that carries no signature at all.
 */
async function sourceFor(headers: Buffer, body: string, unsigned = false): Promise<Buffer> {
  const from = fromOfHeaders(headers);
  return unsigned || !from ? Buffer.from(body) : signedSource(from, `${body}\r\n`);
}

/** One message in the mailbox, with a provider that records what it deletes. */
async function mailboxHolding(uidValidity: bigint, headers: Buffer, unsigned = false) {
  const source = await sourceFor(headers, "attribution-message", unsigned);
  setImapClientFactoryForTests(() => fakeImapMailbox({
    uidValidity,
    search: "all",
    deleted,
    messages: [{ uid: 1, headers, source: Buffer.from(source) }],
  }).client);
}

const replyDependencies = {
  smtpConfig: () => smtp,
  sendMail: async (message: { to: string; subject: string; text: string }) => { sent.push(message); },
};

async function collect(uidValidity: bigint, headers: Buffer, now?: Date, options: { unsigned?: boolean } = {}) {
  const config = await getImapIngestionConfig();
  await mailboxHolding(uidValidity, headers, options.unsigned);
  await runImapIngestionCycle(config, { ...replyDependencies, ...(now ? { now: () => now } : {}) });
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

describe("attribution by verified sender (ADR-0017 slice 4)", () => {
  it("lands A's forwarded mail in A's queue and nowhere else, with no alias at all (acceptance 1)", async () => {
    const config = await getImapIngestionConfig();
    const a = fixture.users.owner.id;
    const b = fixture.users.member.id;
    await reconcileImapRecipientAliases(config);
    const senderA = await verifiedSenderFor(a);
    await verifiedSenderFor(b);

    await collect(1001n, fixtureHeaders({ from: senderA }));

    /* Attribution is the claim: it belongs to A, on the sender alone, with no
       alias in the message at all. What the attachment worker then makes of a
       fake with no body structure is another module's business. */
    expect(await receiptFor("1001")).toMatchObject({ userId: a, attributedBy: "sender" });
    expect(await getDb().select({ id: imapIngestionMessages.id }).from(imapIngestionMessages)
      .where(eq(imapIngestionMessages.userId, b))).toHaveLength(0);
    expect(deleted).toEqual([]);
  }, 20_000);

  it("holds mail from an unverified address for its member, unattributed and not addable (acceptance 2; 54816)", async () => {
    const config = await getImapIngestionConfig();
    await reconcileImapRecipientAliases(config);
    /* The row exists and names the member; it is simply unverified, which is
       the state Orbit seeds every account in. A claim is not a credential:
       since 54816 the mail is kept in that member's inbox, but cannot be added. */
    await seedSenderAddress(fixture.users.member.id);
    const [unchecked] = await listSenderAddresses(fixture.users.member.id);
    expect(unchecked).toMatchObject({ verified: false });

    await collect(1002n, attributedHeaders(unchecked.address!));

    /* Matched for holding, not attributed: the receipt records no attribution. */
    expect(await receiptFor("1002")).toMatchObject({ userId: fixture.users.member.id, attributedBy: null });
    const items = (await listImapInbox(fixture.users.member.id)).receipts as unknown as Array<{ needsSenderCheck?: boolean; canApprove: boolean }>;
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ needsSenderCheck: true, canApprove: false });
    expect(await userForVerifiedSender(unchecked.address!)).toBeUndefined();
  }, 20_000);

  it("leaves a message unattributed when the alias names a different member (acceptance 3)", async () => {
    const config = await getImapIngestionConfig();
    const a = fixture.users.owner.id;
    const b = fixture.users.member.id;
    await reconcileImapRecipientAliases(config);
    const senderA = await verifiedSenderFor(a);
    const relayB = await readRelayRow(b);
    const aliasB = imapRecipientAlias(b, config, relayB!.currentGeneration);

    await collect(1003n, fixtureHeaders({ from: senderA, alias: aliasB }));

    /* Two identities disagree about whose mail this is. The honest answer is
       neither of them, so nobody's queue gets it. */
    expect(await receiptFor("1003")).toEqual({
      userId: null, status: "unattributed", failureCode: "sender_alias_mismatch", attributedBy: null,
    });
  }, 20_000);

  it("deletes a message with no signature silently, with no reply (acceptance 4)", async () => {
    const config = await getImapIngestionConfig();
    await reconcileImapRecipientAliases(config);
    const memberSender = await verifiedSenderFor(fixture.users.member.id);

    /* A verified address, written in `From` by anybody at all, with no
       signature behind it. Answering it would be the backscatter path:
       Orbit emailing whoever a forger names. */
    await collect(1004n, fixtureHeaders({ from: memberSender }), undefined, { unsigned: true });

    /* #1681, note 52496: not attributed, and filed for the member the From
       names as a content-free unsigned failure, not as a stranger's. */
    expect(await receiptFor("1004")).toMatchObject({
      userId: fixture.users.member.id, status: "failed", failureCode: "sender_unsigned", attributedBy: null,
    });
    expect(sent).toEqual([]);
    expect(deleted).toEqual(["1"]);
  }, 20_000);

  it("answers an authenticated unknown sender exactly once and removes the UID (acceptance 5)", async () => {
    const config = await getImapIngestionConfig();
    await reconcileImapRecipientAliases(config);

    /* Authenticated means the stranger's own signature verified (#1681). */
    await collect(1005n, fixtureHeaders({ from: "stranger@example.test" }));

    expect(await receiptFor("1005")).toMatchObject({ userId: null, status: "unattributed" });
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe("stranger@example.test");
    expect(deleted).toEqual(["1"]);
  }, 20_000);

  it("does not answer the same sender twice in a day, and does answer the next day (acceptance 6)", async () => {
    const config = await getImapIngestionConfig();
    await reconcileImapRecipientAliases(config);
    const day = new Date("2026-09-06T09:00:00.000Z");

    await collect(1006n, fixtureHeaders({ from: "stranger@example.test" }), day);
    await collect(1007n, fixtureHeaders({ from: "stranger@example.test" }), new Date(day.getTime() + 3_600_000));
    expect(sent).toHaveLength(1);

    /* The message is still deleted and still counted; only the reply is
       suppressed. Suppressing a reply is not the same as keeping the mail. */
    expect(await receiptFor("1007")).toMatchObject({ status: "unattributed" });
    expect(deleted).toEqual(["1", "1"]);

    await collect(1008n, fixtureHeaders({ from: "stranger@example.test" }), new Date(day.getTime() + 25 * 3_600_000));
    expect(sent).toHaveLength(2);
  }, 30_000);

  it("never quotes the original in the reply (acceptance 7)", async () => {
    const config = await getImapIngestionConfig();
    await reconcileImapRecipientAliases(config);
    const secret = "a-line-only-the-original-message-contains";

    await collect(1009n, fixtureHeaders({
      from: "stranger@example.test",
      extra: [`Subject: ${secret}`, `X-Custom: ${secret}`],
    }));

    expect(sent).toHaveLength(1);
    expect(sent[0].text).toBe(unattributedReplyText());
    expect(sent[0].text).not.toContain(secret);
    expect(sent[0].subject).not.toContain(secret);
    /* It names redirect as the likely cause, which is the one thing a reader
       of this reply can actually act on. */
    expect(sent[0].text).toContain("redirect");
  }, 20_000);

  it("never answers automated mail, and still deletes it", async () => {
    const config = await getImapIngestionConfig();
    await reconcileImapRecipientAliases(config);

    for (const [index, marker] of [
      "Auto-Submitted: auto-replied",
      "Precedence: bulk",
      "List-Id: <announce.example.test>",
      "Return-Path: <>",
    ].entries()) {
      await collect(BigInt(2000 + index), fixtureHeaders({
        from: `robot${index}@example.test`,
        extra: [marker],
      }));
    }

    expect(sent).toEqual([]);
    expect(deleted).toEqual(["1", "1", "1", "1"]);
  }, 30_000);

  it("refuses a forged From for a verified member, whatever provider verdict comes with it (security)", async () => {
    const config = await getImapIngestionConfig();
    const member = fixture.users.member.id;
    await reconcileImapRecipientAliases(config);
    const victim = await verifiedSenderFor(member);
    const relay = await readRelayRow(member);
    const alias = imapRecipientAlias(member, config, relay!.currentGeneration);

    /* Everything the attacker controls says this is the member: their exact
       verified address in `From`, their own alias, and a passing verdict —
       written by an authserv-id that is not the one this instance trusts. */
    await collect(2100n, fixtureHeaders({
      from: victim,
      alias,
      authservId: "attacker.test",
      verdict: "dmarc=pass header.from=example.test",
    }), undefined, { unsigned: true });
    expect(await receiptFor("2100")).toMatchObject({ userId: member, status: "failed", failureCode: "sender_unsigned", attributedBy: null });

    /* And a passing verdict smuggled in below the provider's own, which is
       where a sender's forged copy always lands. */
    await collect(2101n, fixtureHeaders({
      from: victim,
      alias,
      verdict: "dmarc=fail header.from=example.test",
      extra: [`Authentication-Results: ${TRUSTED_AUTHSERV_ID}; dmarc=pass header.from=example.test`],
    }), undefined, { unsigned: true });
    expect(await receiptFor("2101")).toMatchObject({ userId: member, status: "discarded", failureCode: "sender_unsigned", attributedBy: null });

    /* #1681: and a passing verdict on TOP, naming the very authserv-id the
       configuration used to trust: what a sibling mailbox on the same server
       can submit, since nothing strips it. Nothing signed, so nothing proved. */
    const domain = victim.slice(victim.lastIndexOf("@") + 1);
    await collect(2102n, fixtureHeaders({
      from: victim,
      alias,
      verdict: `dkim=pass header.d=${domain}; dmarc=pass header.from=${domain}`,
    }), undefined, { unsigned: true });
    expect(await receiptFor("2102")).toMatchObject({ userId: member, status: "discarded", failureCode: "sender_unsigned", attributedBy: null });

    /* #1681, note 52496: each is a failure row for the member, none is
       attributed (nothing reaches their queue). The first files a visible
       row; the next two, inside the same day, are kept quiet (#1727 A-R2,
       owner 110a: one sender_unsigned row per sending address per day). */
    expect(await getDb().select({ id: imapIngestionMessages.id }).from(imapIngestionMessages)
      .where(and(eq(imapIngestionMessages.userId, member), isNotNull(imapIngestionMessages.attributedBy)))).toHaveLength(0);
    /* No reply either: the sender is not authenticated, so answering would
       email whoever the forger named. */
    expect(sent).toEqual([]);
  }, 30_000);
});

/**
 * A mailbox holding several messages at once, each under its own UID, with a
 * provider that records what it deletes.
 */
async function mailboxHoldingMessages(uidValidity: bigint, messages: Map<number, Buffer>) {
  const held = await Promise.all([...messages].map(async ([uid, headers]) => ({
    uid, headers, source: await sourceFor(headers, `attribution-message-${uid}`),
  })));
  setImapClientFactoryForTests(() => fakeImapMailbox({
    uidValidity,
    search: "all",
    deleted,
    messages: held.map((message) => ({ ...message, source: Buffer.from(message.source) })),
  }).client);
}

/** Takes the metadata key away, the way the key-outage suite does. */
function lockMetadataKey() {
  const original = process.env.DOCUMENT_KEK;
  delete process.env.DOCUMENT_KEK;
  resetDocumentConfigForTests();
  return () => {
    if (original !== undefined) process.env.DOCUMENT_KEK = original;
    resetDocumentConfigForTests();
  };
}

async function receiptsFor(uidValidity: string) {
  return getDb().select({
    uid: imapIngestionMessages.mailboxUid,
    userId: imapIngestionMessages.userId,
    status: imapIngestionMessages.status,
  }).from(imapIngestionMessages).where(eq(imapIngestionMessages.mailboxUidValidity, uidValidity));
}

/*
 * #1316 (M-S11): a message nobody could be found for is deleted from the
 * provider's mailbox for good. That is right for a stranger, and wrong when
 * the reason nobody was found is Orbit's own: a key outage, or one member's
 * damaged stored address. Those say nothing about the sender, so the message
 * must stay where the next cycle can try again.
 */
describe("a message Orbit cannot attribute through its own fault is kept (#1316)", () => {
  it("keeps a verified sender's message, unanswered and unrecorded, while the metadata key is locked", async () => {
    const config = await getImapIngestionConfig();
    await reconcileImapRecipientAliases(config);
    const sender = await verifiedSenderFor(fixture.users.member.id);

    const restoreKey = lockMetadataKey();
    try {
      expect(metadataCryptoAvailable()).toBe(false);
      await mailboxHoldingMessages(3001n, new Map([[1, attributedHeaders(sender)]]));
      /* No .catch: a cycle that throws fails the test. */
      await runImapIngestionCycle(config, replyDependencies);
    } finally {
      restoreKey();
    }

    expect(deleted).toEqual([]);
    expect(sent).toEqual([]);
    expect(await receiptsFor("3001")).toEqual([]);
  }, 30_000);

  /** Flips the tail of a member's stored envelope so it no longer authenticates; returns the original to restore. */
  async function damageStoredAddress(userId: string) {
    const [stored] = await getDb().select({ emailEnc: users.emailEnc }).from(users).where(eq(users.id, userId));
    const envelope = stored!.emailEnc!;
    const tampered = `${envelope.slice(0, -4)}${envelope.endsWith("AAAA") ? "BBBB" : "AAAA"}`;
    expect(tampered).not.toBe(envelope);
    await getDb().update(users).set({ emailEnc: tampered }).where(eq(users.id, userId));
    return envelope;
  }

  async function restoreStoredAddress(userId: string, envelope: string) {
    await getDb().update(users).set({ emailEnc: envelope }).where(eq(users.id, userId));
  }

  it("keeps the message of a member whose stored address is damaged, while a stranger's in the same cycle is still handled as unattributed", async () => {
    const config = await getImapIngestionConfig();
    await reconcileImapRecipientAliases(config);
    const damaged = fixture.users.member.id;
    const sender = await verifiedSenderFor(damaged);

    /* The key is fine; this one member's row is not. */
    await damageStoredAddress(damaged);

    await mailboxHoldingMessages(3002n, new Map([
      [1, attributedHeaders(sender)],
      [2, attributedHeaders("stranger@example.test")],
    ]));
    await runImapIngestionCycle(config, replyDependencies);

    /* Message 1 (the damaged member's): not deleted, not answered, but
       recorded as held so a later cycle knows to come back to it. Message 2
       (a genuine stranger): answered once and deleted, as ever. */
    expect(deleted).toEqual(["2"]);
    expect(sent.map((message) => message.to)).toEqual(["stranger@example.test"]);
    const receipts = await receiptsFor("3002");
    expect(receipts.filter((receipt) => receipt.uid === 1)).toEqual([
      { uid: 1, userId: null, status: "held" },
    ]);
    expect(receipts.filter((receipt) => receipt.uid === 2)).toEqual([
      { uid: 2, userId: null, status: "unattributed" },
    ]);
  }, 30_000);

  it("ingests the damaged member's message on a later cycle once the address is repaired, though a later UID is already recorded", async () => {
    const config = await getImapIngestionConfig();
    await reconcileImapRecipientAliases(config);
    const member = fixture.users.member.id;
    const sender = await verifiedSenderFor(member);
    const original = await damageStoredAddress(member);

    const messages = new Map([
      [1, attributedHeaders(sender)],
      [2, attributedHeaders("stranger@example.test")],
    ]);
    await mailboxHoldingMessages(3003n, messages);
    await runImapIngestionCycle(config, replyDependencies);

    expect(deleted).toEqual(["2"]);
    expect(sent.map((message) => message.to)).toEqual(["stranger@example.test"]);
    expect((await receiptsFor("3003")).filter((receipt) => receipt.uid === 1)).toEqual([
      { uid: 1, userId: null, status: "held" },
    ]);

    /* Repair the address. The provider still holds both messages. */
    await restoreStoredAddress(member, original);
    await mailboxHoldingMessages(3003n, messages);
    await runImapIngestionCycle(config, replyDependencies);

    const [first] = (await receiptsFor("3003")).filter((receipt) => receipt.uid === 1);
    expect(first).toBeDefined();
    expect(first!.userId).toBe(member);
    expect(first!.status).not.toBe("held");
    expect(first!.status).not.toBe("unattributed");
    /* Each cycle re-sends the stranger's delete until it lands; only uid 2 is ever deleted. */
    expect(new Set(deleted)).toEqual(new Set(["2"]));
    expect(sent).toHaveLength(1);
  }, 60_000);

  it("keeps retrying a still-damaged message with a delay between tries, then ingests it once repaired", async () => {
    const config = await getImapIngestionConfig();
    await reconcileImapRecipientAliases(config);
    const member = fixture.users.member.id;
    const sender = await verifiedSenderFor(member);
    const original = await damageStoredAddress(member);

    const messages = new Map([
      [1, attributedHeaders(sender)],
      [2, attributedHeaders("stranger@example.test")],
    ]);
    await mailboxHoldingMessages(3004n, messages);
    await runImapIngestionCycle(config, replyDependencies);
    await mailboxHoldingMessages(3004n, messages);
    await runImapIngestionCycle(config, replyDependencies);

    /* Still damaged: still held, nothing deleted or answered beyond the stranger. */
    expect((await receiptsFor("3004")).filter((receipt) => receipt.uid === 1)).toEqual([
      { uid: 1, userId: null, status: "held" },
    ]);
    /* Each cycle re-sends the stranger's delete until it lands; only uid 2 is ever deleted. */
    expect(new Set(deleted)).toEqual(new Set(["2"]));
    expect(sent).toHaveLength(1);
    const [pending] = await getDb().select({ next: imapIngestionMessages.attachmentProcessingNextAttemptAt })
      .from(imapIngestionMessages)
      .where(and(eq(imapIngestionMessages.mailboxUidValidity, "3004"), eq(imapIngestionMessages.mailboxUid, 1)));
    expect(pending?.next).toBeInstanceOf(Date);
    expect(pending!.next!.getTime()).toBeGreaterThan(Date.now());

    /* Repair, and clear the delay so the next cycle may try at once. */
    await restoreStoredAddress(member, original);
    await getDb().update(imapIngestionMessages).set({ attachmentProcessingNextAttemptAt: null })
      .where(and(eq(imapIngestionMessages.mailboxUidValidity, "3004"), eq(imapIngestionMessages.mailboxUid, 1)));
    await mailboxHoldingMessages(3004n, messages);
    await runImapIngestionCycle(config, replyDependencies);

    const [first] = (await receiptsFor("3004")).filter((receipt) => receipt.uid === 1);
    expect(first).toBeDefined();
    expect(first!.userId).toBe(member);
    expect(first!.status).not.toBe("held");
    expect(first!.status).not.toBe("unattributed");
    /* Each cycle re-sends the stranger's delete until it lands; only uid 2 is ever deleted. */
    expect(new Set(deleted)).toEqual(new Set(["2"]));
    expect(sent).toHaveLength(1);
  }, 60_000);
});
