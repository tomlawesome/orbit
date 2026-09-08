import { createHash } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/db";
import { imapIngestionMessages, imapRecipientAliases, mailInRelays, users } from "@/db/schema";
import {
  imapRecipientAlias,
  reconcileImapRecipientAliases,
  runImapIngestionCycle,
  setImapClientFactoryForTests,
  type ImapIngestionConfig,
} from "@/server/imap-ingestion";
import { digestImapRecipientAlias } from "@/server/mail-in/core/imap-recipient";
import { rotateRelay } from "@/server/mail-in/relays";
import { cleanupIntegrationEnvironment, createIntegrationFixture } from "./support/fixtures";
import { attributedHeaders, fixtureHeaders, TRUSTED_AUTHSERV_ID, verifiedSenderFor } from "./support/mail-in";
import { syntheticPdf } from "../support/synthetic-documents";

afterAll(async () => {
  setImapClientFactoryForTests(undefined);
  await cleanupIntegrationEnvironment();
});

beforeEach(async () => {
  await getDb().delete(imapRecipientAliases);
  await getDb().delete(mailInRelays);
});

/* Derived from the account address in the running application (ADR-0017
   decision 1); pinned here so the digests these cases assert stay stable. */
const aliasBase = { localPart: "orbit", domain: "ingest.example.test" };

/* One instance alias key; generations belong to each member's own
   `mail_in_relays` row since ADR-0017 slice 3 (orbit#744), so this no longer
   carries any. */
function config(mailbox = "INBOX"): ImapIngestionConfig {
  const current = { generation: 1, secret: "the-instance-alias-key-that-is-long-enough" };
  return {
    configured: true,
    enabled: true,
    host: "imap.example.test",
    port: 993,
    user: "orbit",
    password: "provider-password",
    mailbox,
    tlsServerName: "imap.example.test",
    recipientDomain: "ingest.example.test",
    aliasBase: aliasBase,
    currentAliasGeneration: current.generation,
    currentAliasSecret: current.secret,
    aliasCurrent: current,
    aliasSecret: current.secret,
    trustedRecipientHeader: "X-Original-To",
    trustedAuthservId: TRUSTED_AUTHSERV_ID,
    pollMilliseconds: 30_000,
  };
}

describe("receipt identity PostgreSQL boundaries", () => {
  it("enrols every active member at generation one, idempotently, and fails closed for a disabled account", async () => {
    const fixture = await createIntegrationFixture("recipient-reconcile");
    try {
      await fixture.disableUser("disabled");
      const initial = config("recipient-reconcile-mailbox");
      /* Run concurrently: enrolment races a poll cycle in production, and the
         only safe outcome is one row per member either way. */
      await Promise.all([reconcileImapRecipientAliases(initial, 5), reconcileImapRecipientAliases(initial, 5)]);
      await reconcileImapRecipientAliases(initial, 5);

      const fixtureUserIds = Object.values(fixture.users).map((user) => user.id);
      const activeRows = await getDb().select({ userId: imapRecipientAliases.userId, generation: imapRecipientAliases.generation })
        .from(imapRecipientAliases).where(and(
          eq(imapRecipientAliases.status, "active"),
          inArray(imapRecipientAliases.userId, fixtureUserIds),
        ));
      /* Six fixture users, one of them disabled: five active rows, all at
         generation 1, one apiece. Members sharing a generation number is
         ordinary — the counter is each member's own. */
      expect(activeRows).toHaveLength(5);
      expect(new Set(activeRows.map((row) => row.userId)).size).toBe(5);
      expect(new Set(activeRows.map((row) => row.generation))).toEqual(new Set([1]));
      expect(await getDb().select({ id: imapRecipientAliases.id }).from(imapRecipientAliases)
        .innerJoin(users, eq(users.id, imapRecipientAliases.userId))
        .where(and(eq(users.id, fixture.users.disabled.id), eq(imapRecipientAliases.status, "active")))).toHaveLength(0);
      /* A disabled member keeps their place in the counter, so re-enabling
         them can never reissue an address somebody else already holds. */
      expect(await getDb().select({ currentGeneration: mailInRelays.currentGeneration }).from(mailInRelays)
        .where(eq(mailInRelays.userId, fixture.users.disabled.id))).toEqual([{ currentGeneration: 1 }]);
    } finally {
      await fixture.cleanup();
    }
  }, 15_000);

  it("skips the new-mail fetch once the checkpoint has caught up to the mailbox's own uidNext (#383)", async () => {
    const fixture = await createIntegrationFixture("recipient-steady-state-no-refetch");
    const current = config();
    const alias = imapRecipientAlias(fixture.users.member.id, current);
    const sender = await verifiedSenderFor(fixture.users.member.id, `steady-${fixture.users.member.id}@example.test`);
    const ranges: string[] = [];
    setImapClientFactoryForTests(() => ({
      // Exactly one message exists, at UID 1, so the mailbox's own uidNext
      // correctly predicts 2. A fake this simple ignores the requested
      // range and always answers with the same message, so if the
      // range-collapse guard failed to skip a caught-up poll, the second
      // cycle would re-fetch and re-record the same UID-1 message again.
      mailbox: { uidValidity: 500n, uidNext: 2 },
      async connect() {},
      async logout() {},
      async getMailboxLock() { return { release() {} }; },
      async search(query: { uid: string }) {
        ranges.push(query.uid);
        return [1];
      },
      async fetchOne() {
        return { uid: 1, headers: attributedHeaders(sender, alias), source: Buffer.from("steady-state-message") };
      },
    } as unknown as import("imapflow").ImapFlow));
    try {
      await runImapIngestionCycle(current);
      expect(ranges).toEqual(["1:*"]);
      await runImapIngestionCycle(current);
      expect(ranges).toEqual(["1:*"]);
      expect(await getDb().select({ uid: imapIngestionMessages.mailboxUid })
        .from(imapIngestionMessages).where(eq(imapIngestionMessages.mailboxUidValidity, "500")))
        .toEqual([{ uid: 1 }]);
    } finally {
      setImapClientFactoryForTests(undefined);
      await fixture.cleanup();
    }
  });

  it("keeps the rotated-to address collecting after the member's own previous generation lapses", async () => {
    const fixture = await createIntegrationFixture("recipient-expiry-boundary");
    const current = config();
    const ranges: string[] = [];
    let alias = "";
    const sender = await verifiedSenderFor(fixture.users.member.id, `expiry-${fixture.users.member.id}@example.test`);
    setImapClientFactoryForTests(() => ({
      // Comfortably above every UID this fixture's fake mailboxes use, so
      // runImapIngestionCycle's "${nextUid}:*" range-collapse guard (#383)
      // never skips these tests' search/fetchOne calls.
      mailbox: { uidValidity: 300n, uidNext: 1_000_000 },
      async connect() {},
      async logout() {},
      async getMailboxLock() { return { release() {} }; },
      async search(query: { uid: string }) {
        ranges.push(query.uid);
        return [1];
      },
      async fetchOne() {
        return { uid: 1, headers: attributedHeaders(sender, alias), source: Buffer.from("post-expiry-current") };
      },
    } as unknown as import("imapflow").ImapFlow));
    try {
      await reconcileImapRecipientAliases(current);
      /* Rotate and cut off: the outgoing generation 1 expires at once, so the
         only address left standing is generation 2's. */
      const rotated = await rotateRelay(fixture.users.member.id, "cut_off", current);
      expect(rotated.toGeneration).toBe(2);
      alias = imapRecipientAlias(fixture.users.member.id, current, rotated.toGeneration);

      await runImapIngestionCycle(current);
      expect(ranges).toEqual(["1:*"]);
      expect(await getDb().select({ uid: imapIngestionMessages.mailboxUid, userId: imapIngestionMessages.userId, generation: imapIngestionMessages.recipientAliasGeneration })
        .from(imapIngestionMessages).where(eq(imapIngestionMessages.mailboxUidValidity, "300")))
        .toEqual([{ uid: 1, userId: fixture.users.member.id, generation: 2 }]);
    } finally {
      setImapClientFactoryForTests(undefined);
      await fixture.cleanup();
    }
  }, 15_000);

  it("keeps content identity recipient-scoped and tuple recording idempotent", async () => {
    const fixture = await createIntegrationFixture("recipient-content-scope");
    try {
      const contentSha256 = createHash("sha256").update("same private source").digest("hex");
      const insert = (uid: number, userId: string) => getDb().insert(imapIngestionMessages).values({
        mailbox: "INBOX", mailboxUidValidity: "uidvalidity-a", mailboxUid: uid,
        contentSha256, recipientAliasSha256: digestImapRecipientAlias("opaque-alias"), recipientAliasGeneration: 1,
        userId, householdId: null, status: "pending_review", expiresAt: new Date(Date.now() + 86_400_000),
        receiptStatus: "cancelled",
      }).onConflictDoNothing().returning({ id: imapIngestionMessages.id });
      const [owner, member] = await Promise.all([insert(1, fixture.users.owner.id), insert(2, fixture.users.member.id)]);
      expect(owner).toHaveLength(1);
      expect(member).toHaveLength(1);
      const [first, second] = await Promise.all([insert(3, fixture.users.owner.id), insert(3, fixture.users.owner.id)]);
      expect(first.length + second.length).toBe(1);
      expect(await getDb().select({ id: imapIngestionMessages.id }).from(imapIngestionMessages).where(eq(imapIngestionMessages.contentSha256, contentSha256))).toHaveLength(3);
    } finally {
      await fixture.cleanup();
    }
  });

  it("records verified, quarantined, and later UIDs across repeated provider polls", async () => {
    const fixture = await createIntegrationFixture("recipient-provider-replay");
    const current = config();
    const alias = imapRecipientAlias(fixture.users.member.id, current);
    const sender = await verifiedSenderFor(fixture.users.member.id, `replay-${fixture.users.member.id}@example.test`);
    const verifiedPdfBodyStructure = { part: "1", type: "application", subtype: "pdf", disposition: "attachment", dispositionParameters: { filename: "verified.pdf" }, size: 31 };
    const messages = [
      { uid: 1, headers: attributedHeaders(sender, alias), source: Buffer.from("message-one"), bodyStructure: verifiedPdfBodyStructure },
      { uid: 2, headers: fixtureHeaders({ extra: ["To: attacker@example.invalid"] }), source: Buffer.from("message-two") },
      { uid: 3, headers: fixtureHeaders({ extra: ["X-Original-To: one@example.invalid", "X-Original-To: two@example.invalid"] }), source: Buffer.from("message-three") },
    ];
    const fakeClient = {
      // Comfortably above every UID this fixture's fake mailboxes use, so
      // runImapIngestionCycle's "${nextUid}:*" range-collapse guard (#383)
      // never skips these tests' search/fetchOne calls.
      mailbox: { uidValidity: 42n, uidNext: 1_000_000 },
      async connect() {},
      async logout() {},
      async getMailboxLock() { return { release() {} }; },
      // Ignores the requested range and always answers with every message,
      // exactly like the fetch()-based fake this replaces did — the second
      // cycle's repeated poll proves recordImapReceipt's own idempotency
      // (onConflictDoNothing), not a client-side filter.
      async search() { return messages.map((message) => message.uid); },
      async fetchOne(uid: string) {
        const message = messages.find((candidate) => candidate.uid === Number(uid));
        return message ? { ...message } : undefined;
      },
      async download() { return { content: syntheticPdf("recipient identity") }; },
    };
    setImapClientFactoryForTests(() => fakeClient as unknown as import("imapflow").ImapFlow);
    try {
      await runImapIngestionCycle(current);
      await runImapIngestionCycle(current);
      const receipts = await getDb().select({ uid: imapIngestionMessages.mailboxUid, userId: imapIngestionMessages.userId, status: imapIngestionMessages.status, failureCode: imapIngestionMessages.failureCode })
        .from(imapIngestionMessages).where(and(eq(imapIngestionMessages.mailbox, "INBOX"), eq(imapIngestionMessages.mailboxUidValidity, "42"))).orderBy(imapIngestionMessages.mailboxUid);
      /* Since ADR-0017 slice 4 a message that matches no verified sender is
         `unattributed` rather than quarantined: nobody owns it, so nothing is
         kept for anybody to sort out. */
      expect(receipts).toEqual([
        { uid: 1, userId: fixture.users.member.id, status: "failed", failureCode: "scanner_disabled" },
        { uid: 2, userId: null, status: "unattributed", failureCode: "sender_unverified" },
        { uid: 3, userId: null, status: "unattributed", failureCode: "sender_unverified" },
      ]);
      expect(await getDb().select({ id: imapIngestionMessages.id }).from(imapIngestionMessages)
        .where(and(
          eq(imapIngestionMessages.mailbox, "INBOX"),
          eq(imapIngestionMessages.mailboxUidValidity, "42"),
          inArray(imapIngestionMessages.mailboxUid, [1, 2, 3]),
        ))).toHaveLength(3);
    } finally {
      setImapClientFactoryForTests(undefined);
      await fixture.cleanup();
    }
  });

  it("starts a fresh UID namespace at UID 1 without mixing checkpoints across UIDVALIDITY", async () => {
    const fixture = await createIntegrationFixture("recipient-uidvalidity-rollover");
    const current = config();
    const alias = imapRecipientAlias(fixture.users.member.id, current);
    const sender = await verifiedSenderFor(fixture.users.member.id, `rollover-${fixture.users.member.id}@example.test`);
    const ranges: string[] = [];
    let poll = 0;
    setImapClientFactoryForTests(() => {
      const uidValidity = poll++ === 0 ? "100" : "101";
      const uid = uidValidity === "100" ? 7 : 1;
      const client = {
        // Comfortably above every UID this fixture's fake mailboxes use, so
        // runImapIngestionCycle's "${nextUid}:*" range-collapse guard
        // (#383) never skips these tests' search/fetchOne calls.
        mailbox: { uidValidity: BigInt(uidValidity), uidNext: 1_000_000 },
        async connect() {},
        async logout() {},
        async getMailboxLock() { return { release() {} }; },
        async search(query: { uid: string }) {
          ranges.push(query.uid);
          return [uid];
        },
        async fetchOne() {
          return { uid, headers: attributedHeaders(sender, alias), source: Buffer.from(`rollover-${uidValidity}`) };
        },
      };
      return client as unknown as import("imapflow").ImapFlow;
    });
    try {
      await runImapIngestionCycle(current);
      await runImapIngestionCycle(current);
      expect(ranges).toEqual(["1:*", "1:*"]);
      expect(await getDb().select({ uidValidity: imapIngestionMessages.mailboxUidValidity, uid: imapIngestionMessages.mailboxUid })
        .from(imapIngestionMessages).where(eq(imapIngestionMessages.userId, fixture.users.member.id)).orderBy(imapIngestionMessages.mailboxUidValidity, imapIngestionMessages.mailboxUid))
        .toEqual([{ uidValidity: "100", uid: 7 }, { uidValidity: "101", uid: 1 }]);
    } finally {
      setImapClientFactoryForTests(undefined);
      await fixture.cleanup();
    }
  });

  it("retains a durable UID outcome when the provider disconnects and resumes after the checkpoint", async () => {
    const fixture = await createIntegrationFixture("recipient-crash-restart-cursor");
    const current = config();
    const alias = imapRecipientAlias(fixture.users.member.id, current);
    const sender = await verifiedSenderFor(fixture.users.member.id, `restart-${fixture.users.member.id}@example.test`);
    const ranges: string[] = [];
    let poll = 0;
    setImapClientFactoryForTests(() => {
      const firstPoll = poll++ === 0;
      const client = {
        // Comfortably above every UID this fixture's fake mailboxes use, so
        // runImapIngestionCycle's "${nextUid}:*" range-collapse guard
        // (#383) never skips these tests' search/fetchOne calls.
        mailbox: { uidValidity: 200n, uidNext: 1_000_000 },
        async connect() {},
        async logout() {},
        async getMailboxLock() { return { release() {} }; },
        // The first poll's SEARCH sees both UID 1 and 2 (the provider has
        // already assigned both), but the connection dies fetching the
        // second: UID 1 is durably recorded (fetchOne for it completes
        // first, one command at a time — exactly the ordering #460 fixed
        // this module to guarantee) before the disconnect surfaces.
        async search(query: { uid: string }) {
          ranges.push(query.uid);
          return firstPoll ? [1, 2] : [2];
        },
        async fetchOne(uid: string) {
          const numericUid = Number(uid);
          if (firstPoll && numericUid === 2) throw new Error("provider disconnect after durable receipt");
          return { uid: numericUid, headers: attributedHeaders(sender, alias), source: Buffer.from(`restart-${numericUid}`) };
        },
      };
      return client as unknown as import("imapflow").ImapFlow;
    });
    try {
      await expect(runImapIngestionCycle(current)).rejects.toThrow("provider disconnect");
      await runImapIngestionCycle(current);
      expect(ranges).toEqual(["1:*", "2:*"]);
      expect(await getDb().select({ uid: imapIngestionMessages.mailboxUid }).from(imapIngestionMessages)
        .where(eq(imapIngestionMessages.mailboxUidValidity, "200")).orderBy(imapIngestionMessages.mailboxUid))
        .toEqual([{ uid: 1 }, { uid: 2 }]);
    } finally {
      setImapClientFactoryForTests(undefined);
      await fixture.cleanup();
    }
  });
});
