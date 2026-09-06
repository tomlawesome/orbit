import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
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
  imapRecipientAlias,
  reconcileImapRecipientAliases,
  runImapIngestionCycle,
  setImapClientFactoryForTests,
} from "@/server/mail-in/imap-ingestion";
import { readRelayRow } from "@/server/mail-in/relays";
import { unattributedReplyText } from "@/server/mail-in/unattributed-reply";
import { cleanupIntegrationEnvironment, createIntegrationFixture, type IntegrationFixture } from "./support/fixtures";
import { attributedHeaders, fixtureHeaders, TRUSTED_AUTHSERV_ID, verifiedSenderFor } from "./support/mail-in";

/*
 * ADR-0017 slice 4 (orbit#745): attribution by verified sender, against a real
 * database. These are the issue's seven acceptance criteria, in order.
 *
 * The claim under test is that a `From` header is worth nothing on its own. It
 * attributes only when the address is one a member has verified AND the
 * instance's own provider vouched for it; everything else is unattributed,
 * deleted, and answered at most once — and never answered at all when
 * answering could be turned against somebody.
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

/** One message in the mailbox, with a provider that records what it deletes. */
function mailboxHolding(uidValidity: bigint, headers: Buffer) {
  setImapClientFactoryForTests(() => ({
    mailbox: { uidValidity, uidNext: 1_000_000 },
    async connect() {},
    async logout() {},
    async getMailboxLock() { return { release() {} }; },
    async search() { return [1]; },
    async messageDelete(range: string) { deleted.push(range); return true; },
    async fetchOne() {
      return { uid: 1, headers, source: Buffer.from("attribution-message") };
    },
  } as unknown as import("imapflow").ImapFlow));
}

const replyDependencies = {
  smtpConfig: () => smtp,
  sendMail: async (message: { to: string; subject: string; text: string }) => { sent.push(message); },
};

async function collect(uidValidity: bigint, headers: Buffer, now?: Date) {
  const config = await getImapIngestionConfig();
  mailboxHolding(uidValidity, headers);
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
    const senderA = await verifiedSenderFor(a, "a@example.test");
    await verifiedSenderFor(b, "b@example.test");

    await collect(1001n, attributedHeaders(senderA));

    /* Attribution is the claim: it belongs to A, on the sender alone, with no
       alias in the message at all. What the attachment worker then makes of a
       fake with no body structure is another module's business. */
    expect(await receiptFor("1001")).toMatchObject({ userId: a, attributedBy: "sender" });
    expect(await getDb().select({ id: imapIngestionMessages.id }).from(imapIngestionMessages)
      .where(eq(imapIngestionMessages.userId, b))).toHaveLength(0);
    expect(deleted).toEqual([]);
  }, 20_000);

  it("attributes nothing to an address that has not been verified (acceptance 2)", async () => {
    const config = await getImapIngestionConfig();
    await reconcileImapRecipientAliases(config);
    /* The row exists and names the member; it is simply unverified, which is
       the state Orbit seeds every account in. A claim is not a credential. */
    await getDb().insert(mailInSenderAddresses).values({
      userId: fixture.users.member.id, address: "unchecked@example.test", source: "account",
    });

    await collect(1002n, attributedHeaders("unchecked@example.test"));

    expect(await receiptFor("1002")).toEqual({
      userId: null, status: "unattributed", failureCode: "sender_unverified", attributedBy: null,
    });
  }, 20_000);

  it("leaves a message unattributed when the alias names a different member (acceptance 3)", async () => {
    const config = await getImapIngestionConfig();
    const a = fixture.users.owner.id;
    const b = fixture.users.member.id;
    await reconcileImapRecipientAliases(config);
    const senderA = await verifiedSenderFor(a, "a@example.test");
    const relayB = await readRelayRow(b);
    const aliasB = imapRecipientAlias(b, config, relayB!.currentGeneration);

    await collect(1003n, attributedHeaders(senderA, aliasB));

    /* Two identities disagree about whose mail this is. The honest answer is
       neither of them, so nobody's queue gets it. */
    expect(await receiptFor("1003")).toEqual({
      userId: null, status: "unattributed", failureCode: "sender_alias_mismatch", attributedBy: null,
    });
  }, 20_000);

  it("deletes a message with no authentication result silently, with no reply (acceptance 4)", async () => {
    const config = await getImapIngestionConfig();
    await reconcileImapRecipientAliases(config);
    await verifiedSenderFor(fixture.users.member.id, "member@example.test");

    /* A verified address, written in `From` by anybody at all, with no
       provider verdict behind it. Answering it would be the backscatter path:
       Orbit emailing whoever a forger names. */
    await collect(1004n, fixtureHeaders({ from: "member@example.test" }));

    expect(await receiptFor("1004")).toMatchObject({ userId: null, status: "unattributed", failureCode: "sender_unauthenticated" });
    expect(sent).toEqual([]);
    expect(deleted).toEqual(["1"]);
  }, 20_000);

  it("answers an authenticated unknown sender exactly once and removes the UID (acceptance 5)", async () => {
    const config = await getImapIngestionConfig();
    await reconcileImapRecipientAliases(config);

    await collect(1005n, attributedHeaders("stranger@example.test"));

    expect(await receiptFor("1005")).toMatchObject({ userId: null, status: "unattributed" });
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe("stranger@example.test");
    expect(deleted).toEqual(["1"]);
  }, 20_000);

  it("does not answer the same sender twice in a day, and does answer the next day (acceptance 6)", async () => {
    const config = await getImapIngestionConfig();
    await reconcileImapRecipientAliases(config);
    const day = new Date("2026-09-06T09:00:00.000Z");

    await collect(1006n, attributedHeaders("stranger@example.test"), day);
    await collect(1007n, attributedHeaders("stranger@example.test"), new Date(day.getTime() + 3_600_000));
    expect(sent).toHaveLength(1);

    /* The message is still deleted and still counted; only the reply is
       suppressed. Suppressing a reply is not the same as keeping the mail. */
    expect(await receiptFor("1007")).toMatchObject({ status: "unattributed" });
    expect(deleted).toEqual(["1", "1"]);

    await collect(1008n, attributedHeaders("stranger@example.test"), new Date(day.getTime() + 25 * 3_600_000));
    expect(sent).toHaveLength(2);
  }, 30_000);

  it("never quotes the original in the reply (acceptance 7)", async () => {
    const config = await getImapIngestionConfig();
    await reconcileImapRecipientAliases(config);
    const secret = "a-line-only-the-original-message-contains";

    await collect(1009n, fixtureHeaders({
      from: "stranger@example.test",
      verdict: "dmarc=pass header.from=example.test",
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
        verdict: `dmarc=pass header.from=example.test`,
        extra: [marker],
      }));
    }

    expect(sent).toEqual([]);
    expect(deleted).toEqual(["1", "1", "1", "1"]);
  }, 30_000);

  it("refuses a forged From for a verified member whose provider verdict does not back it (security)", async () => {
    const config = await getImapIngestionConfig();
    const member = fixture.users.member.id;
    await reconcileImapRecipientAliases(config);
    const victim = await verifiedSenderFor(member, "victim@example.test");
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
    }));
    expect(await receiptFor("2100")).toMatchObject({ userId: null, status: "unattributed", failureCode: "sender_unauthenticated" });

    /* And a passing verdict smuggled in below the provider's own, which is
       where a sender's forged copy always lands. */
    await collect(2101n, fixtureHeaders({
      from: victim,
      alias,
      verdict: "dmarc=fail header.from=example.test",
      extra: [`Authentication-Results: ${TRUSTED_AUTHSERV_ID}; dmarc=pass header.from=example.test`],
    }));
    expect(await receiptFor("2101")).toMatchObject({ userId: null, status: "unattributed", failureCode: "sender_unauthenticated" });

    expect(await getDb().select({ id: imapIngestionMessages.id }).from(imapIngestionMessages)
      .where(eq(imapIngestionMessages.userId, member))).toHaveLength(0);
    /* No reply either: the sender is not authenticated, so answering would
       email whoever the forger named. */
    expect(sent).toEqual([]);
  }, 30_000);
});
