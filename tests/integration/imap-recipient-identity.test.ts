import { createHash } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { getDb } from "@/db";
import { imapIngestionMessages, imapRecipientAliases, users } from "@/db/schema";
import {
  imapRecipientAlias,
  reconcileImapRecipientAliases,
  runImapIngestionCycle,
  setImapClientFactoryForTests,
  type ImapIngestionConfig,
} from "@/server/imap-ingestion";
import { digestImapRecipientAlias } from "@/server/imap-recipient";
import { cleanupIntegrationEnvironment, createIntegrationFixture } from "./support/fixtures";

afterAll(async () => {
  setImapClientFactoryForTests(undefined);
  await cleanupIntegrationEnvironment();
});

function config(currentGeneration = 1, previous?: { generation: number; expiresAt: Date }): ImapIngestionConfig {
  const current = { generation: currentGeneration, secret: `current-secret-generation-${currentGeneration}-that-is-long-enough` };
  const aliasPrevious = previous ? {
    generation: previous.generation,
    secret: `previous-secret-generation-${previous.generation}-that-is-long-enough`,
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
      const rotation = config(2, { generation: 1, expiresAt: previousExpiry });
      await reconcileImapRecipientAliases(rotation);
      await reconcileImapRecipientAliases(rotation);

      const activeRows = await getDb().select({ userId: imapRecipientAliases.userId, generation: imapRecipientAliases.generation, status: imapRecipientAliases.status })
        .from(imapRecipientAliases).where(eq(imapRecipientAliases.status, "active"));
      expect(activeRows).toHaveLength(10);
      expect(new Set(activeRows.map((row) => row.userId))).toHaveLength(5);
      expect(new Set(activeRows.map((row) => row.generation))).toEqual(new Set([1, 2]));
      expect(await getDb().select({ id: imapRecipientAliases.id }).from(imapRecipientAliases)
        .innerJoin(users, eq(users.id, imapRecipientAliases.userId))
        .where(and(eq(users.id, fixture.users.disabled.id), eq(imapRecipientAliases.status, "active")))).toHaveLength(0);

      await reconcileImapRecipientAliases(config(3));
      expect(await getDb().select({ generation: imapRecipientAliases.generation, status: imapRecipientAliases.status })
        .from(imapRecipientAliases).where(eq(imapRecipientAliases.userId, fixture.users.member.id)))
        .toEqual(expect.arrayContaining([
          { generation: 1, status: "legacy_inactive" },
          { generation: 2, status: "legacy_inactive" },
          { generation: 3, status: "active" },
        ]));
    } finally {
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
});
