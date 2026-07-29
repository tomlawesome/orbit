import { createHash } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { getDb } from "@/db";
import { imapIngestionMessages, imapRecipientAliases, imapRecipientRotationState, users } from "@/db/schema";
import {
  imapRecipientAlias,
  reconcileImapRecipientAliases,
  runImapIngestionCycle,
  setImapClientFactoryForTests,
  type ImapIngestionConfig,
} from "@/server/imap-ingestion";
import { digestImapAliasConfiguration, digestImapRecipientAlias } from "@/server/imap-recipient";
import { cleanupIntegrationEnvironment, createIntegrationFixture } from "./support/fixtures";

afterAll(async () => {
  setImapClientFactoryForTests(undefined);
  await cleanupIntegrationEnvironment();
});

function config(currentGeneration = 1, previous?: { generation: number; expiresAt: Date }): ImapIngestionConfig {
  const current = { generation: currentGeneration, secret: `current-secret-generation-${currentGeneration}-that-is-long-enough` };
  const aliasPrevious = previous ? {
    generation: previous.generation,
    secret: `current-secret-generation-${previous.generation}-that-is-long-enough`,
    expiresAt: previous.expiresAt,
  } : undefined;
  return {
    enabled: true,
    host: "imap.example.test",
    port: 993,
    user: "orbit",
    password: "provider-password",
    mailbox: "INBOX",
    tlsServerName: "imap.example.test",
    recipientDomain: "ingest.example.test",
    currentAliasGeneration: current.generation,
    currentAliasSecret: current.secret,
    previousAliasGeneration: aliasPrevious?.generation,
    previousAliasSecret: aliasPrevious?.secret,
    previousAliasExpiresAt: aliasPrevious?.expiresAt,
    aliasCurrent: current,
    aliasPrevious,
    aliasSecret: current.secret,
    trustedRecipientHeader: "X-Original-To",
    pollMilliseconds: 30_000,
  };
}

describe("receipt identity PostgreSQL boundaries", () => {
  it("reconciles current and one previous alias idempotently and disables users fail closed", async () => {
    const fixture = await createIntegrationFixture("recipient-reconcile");
    try {
      await fixture.disableUser("disabled");
      const previousExpiry = new Date(Date.now() + 86_400_000);
      const initial = config(1);
      await Promise.all([reconcileImapRecipientAliases(initial, 1), reconcileImapRecipientAliases(initial, 1)]);
      const rotation = config(2, { generation: 1, expiresAt: previousExpiry });
      await Promise.all([reconcileImapRecipientAliases(rotation, 1), reconcileImapRecipientAliases(rotation, 1)]);

      const [authority] = await getDb().select({
        currentGeneration: imapRecipientRotationState.currentGeneration,
        previousGeneration: imapRecipientRotationState.previousGeneration,
        previousExpiresAt: imapRecipientRotationState.previousExpiresAt,
        currentCommitment: imapRecipientRotationState.currentCommitment,
        previousCommitment: imapRecipientRotationState.previousCommitment,
      }).from(imapRecipientRotationState);
      expect(authority).toMatchObject({ currentGeneration: 2, previousGeneration: 1, currentCommitment: digestImapAliasConfiguration("ingest.example.test", "X-Original-To", { generation: 2, secret: "current-secret-generation-2-that-is-long-enough" }), previousCommitment: digestImapAliasConfiguration("ingest.example.test", "X-Original-To", { generation: 1, secret: "current-secret-generation-1-that-is-long-enough" }) });
      expect(authority.previousExpiresAt).toEqual(previousExpiry);

      const activeRows = await getDb().select({ userId: imapRecipientAliases.userId, generation: imapRecipientAliases.generation, status: imapRecipientAliases.status })
        .from(imapRecipientAliases).where(eq(imapRecipientAliases.status, "active"));
      expect(activeRows).toHaveLength(10);
      expect(new Set(activeRows.map((row) => row.userId))).toHaveLength(5);
      expect(new Set(activeRows.map((row) => row.generation))).toEqual(new Set([1, 2]));
      expect(await getDb().select({ id: imapRecipientAliases.id }).from(imapRecipientAliases)
        .innerJoin(users, eq(users.id, imapRecipientAliases.userId))
        .where(and(eq(users.id, fixture.users.disabled.id), eq(imapRecipientAliases.status, "active")))).toHaveLength(0);

      const rowsBeforeStale = await getDb().select({ userId: imapRecipientAliases.userId, generation: imapRecipientAliases.generation, status: imapRecipientAliases.status, activeUntil: imapRecipientAliases.activeUntil })
        .from(imapRecipientAliases).orderBy(imapRecipientAliases.userId, imapRecipientAliases.generation);
      await expect(reconcileImapRecipientAliases(initial, 1)).rejects.toThrow("stale or invalid");
      expect(await getDb().select({ userId: imapRecipientAliases.userId, generation: imapRecipientAliases.generation, status: imapRecipientAliases.status, activeUntil: imapRecipientAliases.activeUntil })
        .from(imapRecipientAliases).orderBy(imapRecipientAliases.userId, imapRecipientAliases.generation)).toEqual(rowsBeforeStale);
      await expect(runImapIngestionCycle(initial)).rejects.toThrow("stale or invalid");
      expect(await getDb().select({ id: imapIngestionMessages.id }).from(imapIngestionMessages)).toHaveLength(0);
      await expect(reconcileImapRecipientAliases({ ...rotation, recipientDomain: "other.example.test" }, 1)).rejects.toThrow("stale or invalid");
      await expect(reconcileImapRecipientAliases({ ...rotation, trustedRecipientHeader: "X-Envelope-To" }, 1)).rejects.toThrow("stale or invalid");

      await reconcileImapRecipientAliases(config(3));
      expect(await getDb().select({ currentGeneration: imapRecipientRotationState.currentGeneration, previousGeneration: imapRecipientRotationState.previousGeneration, previousExpiresAt: imapRecipientRotationState.previousExpiresAt })
        .from(imapRecipientRotationState)).toEqual([{ currentGeneration: 3, previousGeneration: null, previousExpiresAt: null }]);
      expect(await getDb().select({ generation: imapRecipientAliases.generation, status: imapRecipientAliases.status })
        .from(imapRecipientAliases).where(eq(imapRecipientAliases.userId, fixture.users.member.id)))
        .toEqual(expect.arrayContaining([
          { generation: 1, status: "legacy_inactive" },
          { generation: 2, status: "legacy_inactive" },
          { generation: 3, status: "active" },
        ]));
      await expect(reconcileImapRecipientAliases(rotation)).rejects.toThrow("stale or invalid");
    } finally {
      await fixture.cleanup();
    }
  });

  it("keeps current G2 receipt ingestion available when its static previous tuple expires", async () => {
    const fixture = await createIntegrationFixture("recipient-expiry-boundary");
    const expiry = new Date(Date.now() - 1_000);
    const rotation = config(2, { generation: 1, expiresAt: expiry });
    const beforeExpiry = new Date(expiry.getTime() - 1);
    const alias = imapRecipientAlias(fixture.users.member.id, rotation);
    const ranges: string[] = [];
    setImapClientFactoryForTests(() => ({
      mailbox: { uidValidity: 300n },
      async connect() {},
      async logout() {},
      async getMailboxLock() { return { release() {} }; },
      async *fetch(range: string) {
        ranges.push(range);
        yield { uid: 1, headers: Buffer.from(`X-Original-To: ${alias}\r\n`), source: Buffer.from("post-expiry-current") };
      },
    } as unknown as import("imapflow").ImapFlow));
    try {
      await reconcileImapRecipientAliases(config(1), 1);
      await reconcileImapRecipientAliases(rotation, 1, beforeExpiry);
      expect(await getDb().select({ previousGeneration: imapRecipientRotationState.previousGeneration })
        .from(imapRecipientRotationState)).toEqual([{ previousGeneration: 1 }]);
      await reconcileImapRecipientAliases(rotation, 1, expiry);
      expect(await getDb().select({ currentGeneration: imapRecipientRotationState.currentGeneration, previousGeneration: imapRecipientRotationState.previousGeneration })
        .from(imapRecipientRotationState)).toEqual([{ currentGeneration: 2, previousGeneration: null }]);
      await runImapIngestionCycle(rotation);
      expect(ranges).toEqual(["1:*"]);
      expect(await getDb().select({ uid: imapIngestionMessages.mailboxUid, userId: imapIngestionMessages.userId, generation: imapIngestionMessages.recipientAliasGeneration })
        .from(imapIngestionMessages).where(eq(imapIngestionMessages.mailboxUidValidity, "300")))
        .toEqual([{ uid: 1, userId: fixture.users.member.id, generation: 2 }]);
    } finally {
      setImapClientFactoryForTests(undefined);
      await fixture.cleanup();
    }
  });

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
    const messages = [
      { uid: 1, headers: Buffer.from(`X-Original-To: ${alias}\r\nTo: attacker@example.invalid\r\n`), source: Buffer.from("message-one") },
      { uid: 2, headers: Buffer.from("To: attacker@example.invalid\r\n"), source: Buffer.from("message-two") },
      { uid: 3, headers: Buffer.from("X-Original-To: one@example.invalid\r\nX-Original-To: two@example.invalid\r\n"), source: Buffer.from("message-three") },
    ];
    const fakeClient = {
      mailbox: { uidValidity: 42n },
      async connect() {},
      async logout() {},
      async getMailboxLock() { return { release() {} }; },
      async *fetch() { yield* messages; },
    };
    setImapClientFactoryForTests(() => fakeClient as unknown as import("imapflow").ImapFlow);
    try {
      await runImapIngestionCycle(current);
      await runImapIngestionCycle(current);
      const receipts = await getDb().select({ uid: imapIngestionMessages.mailboxUid, userId: imapIngestionMessages.userId, status: imapIngestionMessages.status, failureCode: imapIngestionMessages.failureCode })
        .from(imapIngestionMessages).where(and(eq(imapIngestionMessages.mailbox, "INBOX"), eq(imapIngestionMessages.mailboxUidValidity, "42"))).orderBy(imapIngestionMessages.mailboxUid);
      expect(receipts).toEqual([
        { uid: 1, userId: fixture.users.member.id, status: "pending_review", failureCode: null },
        { uid: 2, userId: null, status: "quarantined", failureCode: "recipient_missing" },
        { uid: 3, userId: null, status: "quarantined", failureCode: "recipient_header_ambiguous" },
      ]);
      expect(await getDb().select({ id: imapIngestionMessages.id }).from(imapIngestionMessages)
        .where(inArray(imapIngestionMessages.mailboxUid, [1, 2, 3]))).toHaveLength(3);
    } finally {
      setImapClientFactoryForTests(undefined);
      await fixture.cleanup();
    }
  });

  it("starts a fresh UID namespace at UID 1 without mixing checkpoints across UIDVALIDITY", async () => {
    const fixture = await createIntegrationFixture("recipient-uidvalidity-rollover");
    const current = config();
    const alias = imapRecipientAlias(fixture.users.member.id, current);
    const ranges: string[] = [];
    let poll = 0;
    setImapClientFactoryForTests(() => {
      const uidValidity = poll++ === 0 ? "100" : "101";
      const uid = uidValidity === "100" ? 7 : 1;
      const client = {
        mailbox: { uidValidity: BigInt(uidValidity) },
        async connect() {},
        async logout() {},
        async getMailboxLock() { return { release() {} }; },
        async *fetch(range: string) {
          ranges.push(range);
          yield { uid, headers: Buffer.from(`X-Original-To: ${alias}\r\n`), source: Buffer.from(`rollover-${uidValidity}`) };
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
    const ranges: string[] = [];
    let poll = 0;
    setImapClientFactoryForTests(() => {
      const firstPoll = poll++ === 0;
      const client = {
        mailbox: { uidValidity: 200n },
        async connect() {},
        async logout() {},
        async getMailboxLock() { return { release() {} }; },
        async *fetch(range: string) {
          ranges.push(range);
          const uid = firstPoll ? 1 : 2;
          yield { uid, headers: Buffer.from(`X-Original-To: ${alias}\r\n`), source: Buffer.from(`restart-${uid}`) };
          if (firstPoll) throw new Error("provider disconnect after durable receipt");
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
