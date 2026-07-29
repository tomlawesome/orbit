import { randomUUID } from "node:crypto";
import { and, eq, isNull, lte, lt, or, sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { getDb } from "@/db";
import { imapIngestionAttachments, imapIngestionMessages, imapIngestionStagingObjects } from "@/db/schema";
import { getDocumentConfig } from "@/server/documents/config";
import { LocalDocumentStorage } from "@/server/documents/storage";
import {
  cleanupImapStagingAttempt,
  getImapIngestionConfig,
  imapRecipientAlias,
  runImapIngestionCycle,
  setImapClientFactoryForTests,
} from "@/server/imap-ingestion";
import { holdImapAttachment, setImapHoldingPurgeImplementationForTests } from "@/server/imap-attachment-holding";
import { discardImapReviewItem, purgeExpiredImapStaging } from "@/server/imap-inbox";
import { cleanupIntegrationEnvironment, createIntegrationFixture } from "./support/fixtures";

afterAll(async () => {
  setImapClientFactoryForTests(undefined);
  await cleanupIntegrationEnvironment();
});

async function claimForEvidence(receiptId: string) {
  const now = new Date();
  const token = randomUUID();
  return getDb().update(imapIngestionMessages).set({
    attachmentProcessingAttempts: sql`${imapIngestionMessages.attachmentProcessingAttempts} + 1`,
    attachmentProcessingLockedAt: now,
    attachmentProcessingLeaseToken: token,
    updatedAt: now,
  }).where(and(
    eq(imapIngestionMessages.id, receiptId),
    eq(imapIngestionMessages.status, "processing"),
    lt(imapIngestionMessages.attachmentProcessingAttempts, 5),
    or(isNull(imapIngestionMessages.attachmentProcessingLockedAt), lt(imapIngestionMessages.attachmentProcessingLockedAt, new Date(now.getTime() - 10 * 60_000))),
    or(isNull(imapIngestionMessages.attachmentProcessingNextAttemptAt), lte(imapIngestionMessages.attachmentProcessingNextAttemptAt, now)),
  )).returning({ id: imapIngestionMessages.id, token: imapIngestionMessages.attachmentProcessingLeaseToken, attempts: imapIngestionMessages.attachmentProcessingAttempts });
}

function mailboxConfig() {
  return getImapIngestionConfig({
    ...process.env,
    IMAP_HOST: "imap.example.invalid",
    IMAP_USER: "orbit-test",
    IMAP_PASSWORD: "test-only-password",
    SMTP_HOST: "smtp.example.invalid",
    IMAP_RECIPIENT_DOMAIN: "ingest.example.invalid",
    IMAP_ALIAS_CURRENT_GENERATION: "1",
    IMAP_ALIAS_CURRENT_SECRET: "test-only-current-alias-secret-is-long-enough",
    IMAP_TRUSTED_RECIPIENT_HEADER: "X-Original-To",
  });
}

function pdfBodyStructure() {
  return {
    part: "1", type: "application", subtype: "pdf", disposition: "attachment",
    dispositionParameters: { filename: "receipt.pdf" }, size: 64,
  } as never;
}

function fakeClient(messages: Array<{ uid: number; headers: Buffer; bodyStructure: unknown; source?: Buffer; size?: number; downloadError?: string }>) {
  const fetches: string[] = [];
  const downloads: string[] = [];
  const client = {
    mailbox: { uidValidity: 77 },
    async connect() {},
    async logout() {},
    async getMailboxLock() { return { release() {} }; },
    async *fetch(range: string) {
      fetches.push(range);
      const exact = /^(\d+):\1$/u.exec(range)?.[1];
      const start = exact ? Number(exact) : Number(/^\d+/u.exec(range)?.[0] ?? 0);
      for (const message of messages) if (exact ? message.uid === start : message.uid >= start) yield { ...message, internalDate: new Date() };
    },
    async download(uid: number, part: string) {
      downloads.push(`${uid}:${part}`);
      const message = messages.find((candidate) => candidate.uid === uid);
      if (message?.downloadError) throw new Error(message.downloadError);
      return { content: Buffer.from("%PDF-1.7\n1 0 obj\nendobj\n%%EOF") };
    },
  };
  return { client, fetches, downloads };
}

describe("IMAP attachment processing PostgreSQL boundaries", () => {
  it("atomically fences concurrent claims, expired leases, stale completion, and the sixth attempt", async () => {
    const fixture = await createIntegrationFixture("imap-claim-boundaries");
    try {
      const [receipt] = await getDb().insert(imapIngestionMessages).values({
        mailbox: "claim", mailboxUidValidity: "77", mailboxUid: 700, contentSha256: randomUUID().replaceAll("-", ""),
        recipientAliasSha256: "claim", userId: fixture.users.member.id, status: "processing",
        expiresAt: new Date(Date.now() + 86_400_000), receiptStatus: "processing",
      }).returning({ id: imapIngestionMessages.id });
      const [first, second] = await Promise.all([claimForEvidence(receipt.id), claimForEvidence(receipt.id)]);
      expect(first.length + second.length).toBe(1);
      const winner = first[0] ?? second[0];
      expect(winner.attempts).toBe(1);

      await getDb().update(imapIngestionMessages).set({ attachmentProcessingLockedAt: new Date(Date.now() - 11 * 60_000) }).where(eq(imapIngestionMessages.id, receipt.id));
      const [expiredLeaseClaim] = await claimForEvidence(receipt.id);
      expect(expiredLeaseClaim?.attempts).toBe(2);
      const staleCompletion = await getDb().update(imapIngestionMessages).set({ status: "pending_review" })
        .where(and(eq(imapIngestionMessages.id, receipt.id), eq(imapIngestionMessages.attachmentProcessingLeaseToken, winner.token!))).returning({ id: imapIngestionMessages.id });
      expect(staleCompletion).toHaveLength(0);

      await getDb().update(imapIngestionMessages).set({ status: "processing", attachmentProcessingAttempts: 5, attachmentProcessingLockedAt: new Date(Date.now() - 11 * 60_000), attachmentProcessingNextAttemptAt: null }).where(eq(imapIngestionMessages.id, receipt.id));
      expect(await claimForEvidence(receipt.id)).toHaveLength(0);
    } finally {
      await fixture.cleanup();
    }
  });

  it("keeps poison retries bounded, continues with later UIDs, and fences a changed recipient", async () => {
    const fixture = await createIntegrationFixture("imap-provider-bounds");
    try {
      const config = mailboxConfig();
      const alias = imapRecipientAlias(fixture.users.member.id, config);
      const header = Buffer.from(`X-Original-To: ${alias}\r\n\r\n`);
      await getDb().insert(imapIngestionMessages).values({
        mailbox: config.mailbox, mailboxUidValidity: "77", mailboxUid: 800, contentSha256: randomUUID().replaceAll("-", ""),
        recipientAliasSha256: "retry", userId: fixture.users.member.id, status: "processing",
        expiresAt: new Date(Date.now() + 86_400_000), receiptStatus: "processing", attachmentProcessingNextAttemptAt: new Date(0),
      });
      const provider = fakeClient([
        { uid: 800, headers: header, bodyStructure: pdfBodyStructure(), source: Buffer.from("poison"), size: 6, downloadError: "attachment_download_failed" },
        { uid: 801, headers: header, bodyStructure: { part: "1", type: "image", subtype: "png", disposition: "inline", dispositionParameters: { filename: "logo.png" } }, source: Buffer.from("logo"), size: 4 },
      ]);
      setImapClientFactoryForTests(() => provider.client as never);
      await runImapIngestionCycle(config);
      expect(provider.fetches).toEqual(["800:800", "801:*"]);
      expect(provider.downloads).toEqual(["800:1"]);
      const [retry] = await getDb().select().from(imapIngestionMessages).where(and(eq(imapIngestionMessages.mailboxUid, 800), eq(imapIngestionMessages.mailboxUidValidity, "77")));
      const [ignored] = await getDb().select().from(imapIngestionMessages).where(and(eq(imapIngestionMessages.mailboxUid, 801), eq(imapIngestionMessages.mailboxUidValidity, "77")));
      expect(retry).toMatchObject({ status: "processing", attachmentProcessingAttempts: 1 });
      expect(ignored).toMatchObject({ status: "failed", failureCode: "no_supported_pdf" });
      expect(await getDb().select({ id: imapIngestionAttachments.id }).from(imapIngestionAttachments).where(eq(imapIngestionAttachments.messageId, ignored.id))).toHaveLength(0);

      await getDb().update(imapIngestionMessages).set({ attachmentProcessingNextAttemptAt: new Date(0) }).where(eq(imapIngestionMessages.mailboxUid, 800));
      provider.fetches.length = 0;
      await runImapIngestionCycle(config);
      expect(provider.fetches).toEqual(["800:800", "802:*"]);

      const changedRecipient = fixture.users.owner.id;
      const changedAlias = imapRecipientAlias(changedRecipient, config);
      const mismatchProvider = fakeClient([{ uid: 900, headers: Buffer.from(`X-Original-To: ${changedAlias}\r\n\r\n`), bodyStructure: pdfBodyStructure(), source: Buffer.from("changed"), size: 7 }]);
      await getDb().insert(imapIngestionMessages).values({
        mailbox: config.mailbox, mailboxUidValidity: "77", mailboxUid: 900, contentSha256: randomUUID().replaceAll("-", ""),
        recipientAliasSha256: "durable", userId: fixture.users.member.id, status: "processing",
        expiresAt: new Date(Date.now() + 86_400_000), receiptStatus: "processing",
      });
      setImapClientFactoryForTests(() => mismatchProvider.client as never);
      await runImapIngestionCycle(config);
      const [mismatch] = await getDb().select().from(imapIngestionMessages).where(eq(imapIngestionMessages.mailboxUid, 900));
      expect(mismatch).toMatchObject({ status: "quarantined", failureCode: "recipient_mismatch" });
      expect(mismatchProvider.downloads).toEqual([]);
    } finally {
      setImapClientFactoryForTests(undefined);
      await fixture.cleanup();
    }
  });

  it("reconciles only ledger-known staging objects and preserves an ordinary ciphertext", async () => {
    const fixture = await createIntegrationFixture("imap-reconcile-ledger");
    try {
      const config = getDocumentConfig();
      const storage = new LocalDocumentStorage(config.storageRoot, config.quarantineRoot);
      const ordinaryKey = storage.createStorageKey();
      await storage.writeCiphertext(ordinaryKey, Buffer.from("ordinary document ciphertext"));
      const receiptId = randomUUID();
      const leaseToken = randomUUID();
      const held = await holdImapAttachment({ bytes: Buffer.from("staging orphan"), displayName: "orphan.pdf", mediaType: "application/pdf", recipientUserId: fixture.users.member.id, receiptId });
      await getDb().insert(imapIngestionMessages).values({ id: receiptId, mailbox: "reconcile", mailboxUidValidity: "77", mailboxUid: 901, contentSha256: randomUUID().replaceAll("-", ""), recipientAliasSha256: "reconcile", userId: fixture.users.member.id, status: "processing", expiresAt: new Date(Date.now() + 86_400_000), receiptStatus: "processing", attachmentProcessingLeaseToken: leaseToken });
      await getDb().insert(imapIngestionStagingObjects).values({ messageId: receiptId, leaseToken, storageKey: held.storageKey, status: "pending" });
      const { reconcileImapStagingObjects } = await import("@/server/imap-ingestion");
      await reconcileImapStagingObjects();
      expect(await storage.ciphertextExists(ordinaryKey)).toBe(true);
      expect(await storage.ciphertextExists(held.storageKey)).toBe(false);
      expect(await getDb().select({ id: imapIngestionStagingObjects.id }).from(imapIngestionStagingObjects).where(eq(imapIngestionStagingObjects.storageKey, held.storageKey))).toHaveLength(0);
    } finally {
      await fixture.cleanup();
    }
  });

  it("preserves staging rows during a live lease but reconciles stale rows", async () => {
    const fixture = await createIntegrationFixture("imap-reconcile-live-lease");
    try {
      const storage = new LocalDocumentStorage(getDocumentConfig().storageRoot, getDocumentConfig().quarantineRoot);
      const liveReceiptId = randomUUID();
      const liveLeaseToken = randomUUID();
      const liveHeld = await holdImapAttachment({ bytes: Buffer.from("live staged"), displayName: "live.pdf", mediaType: "application/pdf", recipientUserId: fixture.users.member.id, receiptId: liveReceiptId });
      await getDb().insert(imapIngestionMessages).values({ id: liveReceiptId, mailbox: "reconcile-live", mailboxUidValidity: "77", mailboxUid: 906, contentSha256: randomUUID().replaceAll("-", ""), recipientAliasSha256: "live", userId: fixture.users.member.id, status: "processing", expiresAt: new Date(Date.now() + 86_400_000), receiptStatus: "processing", attachmentProcessingLockedAt: new Date(), attachmentProcessingLeaseToken: liveLeaseToken });
      await getDb().insert(imapIngestionStagingObjects).values({ messageId: liveReceiptId, leaseToken: liveLeaseToken, storageKey: liveHeld.storageKey, status: "pending" });
      const liveCommittedHeld = await holdImapAttachment({ bytes: Buffer.from("live committed"), displayName: "committed.pdf", mediaType: "application/pdf", recipientUserId: fixture.users.member.id, receiptId: liveReceiptId });
      await getDb().insert(imapIngestionAttachments).values({ id: liveCommittedHeld.id, messageId: liveReceiptId, displayName: liveCommittedHeld.displayName, mediaType: liveCommittedHeld.mediaType, sizeBytes: liveCommittedHeld.sizeBytes, contentSha256: liveCommittedHeld.contentSha256, storageKey: liveCommittedHeld.storageKey, ciphertextSize: liveCommittedHeld.ciphertextSize, ...liveCommittedHeld.envelope, status: "stored" });
      await getDb().insert(imapIngestionStagingObjects).values({ messageId: liveReceiptId, leaseToken: liveLeaseToken, storageKey: liveCommittedHeld.storageKey, status: "committed" });

      const staleReceiptId = randomUUID();
      const staleLeaseToken = randomUUID();
      const staleHeld = await holdImapAttachment({ bytes: Buffer.from("stale staged"), displayName: "stale.pdf", mediaType: "application/pdf", recipientUserId: fixture.users.member.id, receiptId: staleReceiptId });
      await getDb().insert(imapIngestionMessages).values({ id: staleReceiptId, mailbox: "reconcile-stale", mailboxUidValidity: "77", mailboxUid: 907, contentSha256: randomUUID().replaceAll("-", ""), recipientAliasSha256: "stale", userId: fixture.users.member.id, status: "processing", expiresAt: new Date(Date.now() + 86_400_000), receiptStatus: "processing", attachmentProcessingLockedAt: new Date(Date.now() - 11 * 60_000), attachmentProcessingLeaseToken: staleLeaseToken });
      await getDb().insert(imapIngestionStagingObjects).values({ messageId: staleReceiptId, leaseToken: staleLeaseToken, storageKey: staleHeld.storageKey, status: "pending" });

      const { reconcileImapStagingObjects } = await import("@/server/imap-ingestion");
      await reconcileImapStagingObjects();
      expect(await storage.ciphertextExists(liveHeld.storageKey)).toBe(true);
      expect(await getDb().select({ id: imapIngestionStagingObjects.id }).from(imapIngestionStagingObjects).where(eq(imapIngestionStagingObjects.storageKey, liveHeld.storageKey))).toHaveLength(1);
      expect(await storage.ciphertextExists(liveCommittedHeld.storageKey)).toBe(true);
      expect(await getDb().select({ id: imapIngestionStagingObjects.id }).from(imapIngestionStagingObjects).where(eq(imapIngestionStagingObjects.storageKey, liveCommittedHeld.storageKey))).toHaveLength(1);
      expect(await storage.ciphertextExists(staleHeld.storageKey)).toBe(false);
      expect(await getDb().select({ id: imapIngestionStagingObjects.id }).from(imapIngestionStagingObjects).where(eq(imapIngestionStagingObjects.storageKey, staleHeld.storageKey))).toHaveLength(0);
    } finally {
      await fixture.cleanup();
    }
  });

  it("fences stale cleanup after a successor owns the attachment lease", async () => {
    const fixture = await createIntegrationFixture("imap-stale-cleanup-race");
    try {
      const receiptId = randomUUID();
      const successorToken = randomUUID();
      const staleToken = randomUUID();
      const held = await holdImapAttachment({ bytes: Buffer.from("successor ciphertext"), displayName: "successor.pdf", mediaType: "application/pdf", recipientUserId: fixture.users.member.id, receiptId });
      await getDb().insert(imapIngestionMessages).values({ id: receiptId, mailbox: "cleanup-race", mailboxUidValidity: "77", mailboxUid: 908, contentSha256: randomUUID().replaceAll("-", ""), recipientAliasSha256: "cleanup", userId: fixture.users.member.id, status: "processing", expiresAt: new Date(Date.now() + 86_400_000), receiptStatus: "processing", attachmentProcessingLockedAt: new Date(), attachmentProcessingLeaseToken: successorToken });
      await getDb().insert(imapIngestionAttachments).values({ id: held.id, messageId: receiptId, displayName: held.displayName, mediaType: held.mediaType, sizeBytes: held.sizeBytes, contentSha256: held.contentSha256, storageKey: held.storageKey, ciphertextSize: held.ciphertextSize, ...held.envelope, status: "stored" });
      await getDb().insert(imapIngestionStagingObjects).values({ messageId: receiptId, leaseToken: successorToken, storageKey: held.storageKey, status: "committed" });

      await cleanupImapStagingAttempt(receiptId, staleToken, [{ id: held.id, storageKey: held.storageKey }]);
      expect(await new LocalDocumentStorage(getDocumentConfig().storageRoot, getDocumentConfig().quarantineRoot).ciphertextExists(held.storageKey)).toBe(true);
      expect((await getDb().select({ status: imapIngestionAttachments.status, purgePending: imapIngestionAttachments.purgePending }).from(imapIngestionAttachments).where(eq(imapIngestionAttachments.id, held.id)))[0]).toMatchObject({ status: "stored", purgePending: false });
      expect((await getDb().select({ status: imapIngestionStagingObjects.status }).from(imapIngestionStagingObjects).where(eq(imapIngestionStagingObjects.storageKey, held.storageKey)))[0].status).toBe("committed");
    } finally {
      await fixture.cleanup();
    }
  });

  it("skips live expiry leases, cleans stale and disabled-user staging, and retries purge failures", async () => {
    const fixture = await createIntegrationFixture("imap-expiry-fencing");
    try {
      const future = new Date(Date.now() - 2_000);
      const liveReceiptId = randomUUID();
      await getDb().insert(imapIngestionMessages).values({ id: liveReceiptId, mailbox: "expiry", mailboxUidValidity: "77", mailboxUid: 902, contentSha256: randomUUID().replaceAll("-", ""), recipientAliasSha256: "live", userId: fixture.users.member.id, status: "processing", expiresAt: future, receiptStatus: "processing", attachmentProcessingLockedAt: new Date(), attachmentProcessingLeaseToken: randomUUID() });
      await purgeExpiredImapStaging(new Date());
      expect((await getDb().select({ status: imapIngestionMessages.status }).from(imapIngestionMessages).where(eq(imapIngestionMessages.id, liveReceiptId)))[0].status).toBe("processing");

      const liveRecoverableReceiptId = randomUUID();
      const liveRecoverableHeld = await holdImapAttachment({ bytes: Buffer.from("live recoverable"), displayName: "recoverable.pdf", mediaType: "application/pdf", recipientUserId: fixture.users.member.id, receiptId: liveRecoverableReceiptId });
      await getDb().insert(imapIngestionMessages).values({ id: liveRecoverableReceiptId, mailbox: "expiry", mailboxUidValidity: "77", mailboxUid: 909, contentSha256: randomUUID().replaceAll("-", ""), recipientAliasSha256: "recoverable-live", userId: fixture.users.member.id, status: "recoverable", expiresAt: new Date(Date.now() + 86_400_000), receiptStatus: "pending", attachmentProcessingLockedAt: new Date(), attachmentProcessingLeaseToken: randomUUID() });
      await getDb().insert(imapIngestionAttachments).values({ id: liveRecoverableHeld.id, messageId: liveRecoverableReceiptId, displayName: liveRecoverableHeld.displayName, mediaType: liveRecoverableHeld.mediaType, sizeBytes: liveRecoverableHeld.sizeBytes, contentSha256: liveRecoverableHeld.contentSha256, storageKey: liveRecoverableHeld.storageKey, ciphertextSize: liveRecoverableHeld.ciphertextSize, ...liveRecoverableHeld.envelope, status: "stored" });
      await purgeExpiredImapStaging(new Date());
      expect((await getDb().select({ status: imapIngestionMessages.status }).from(imapIngestionMessages).where(eq(imapIngestionMessages.id, liveRecoverableReceiptId)))[0].status).toBe("recoverable");
      expect(await new LocalDocumentStorage(getDocumentConfig().storageRoot, getDocumentConfig().quarantineRoot).ciphertextExists(liveRecoverableHeld.storageKey)).toBe(true);

      const staleReceiptId = randomUUID();
      const held = await holdImapAttachment({ bytes: Buffer.from("stale staged"), displayName: "stale.pdf", mediaType: "application/pdf", recipientUserId: fixture.users.member.id, receiptId: staleReceiptId });
      await getDb().insert(imapIngestionMessages).values({ id: staleReceiptId, mailbox: "expiry", mailboxUidValidity: "77", mailboxUid: 903, contentSha256: randomUUID().replaceAll("-", ""), recipientAliasSha256: "stale", userId: fixture.users.member.id, status: "processing", expiresAt: future, receiptStatus: "processing", attachmentProcessingLockedAt: new Date(Date.now() - 11 * 60_000), attachmentProcessingLeaseToken: randomUUID() });
      await getDb().insert(imapIngestionAttachments).values({ id: held.id, messageId: staleReceiptId, displayName: held.displayName, mediaType: held.mediaType, sizeBytes: held.sizeBytes, contentSha256: held.contentSha256, storageKey: held.storageKey, ciphertextSize: held.ciphertextSize, ...held.envelope, status: "stored" });
      await purgeExpiredImapStaging(new Date());
      expect((await getDb().select({ status: imapIngestionMessages.status }).from(imapIngestionMessages).where(eq(imapIngestionMessages.id, staleReceiptId)))[0].status).toBe("expired");
      expect(await new LocalDocumentStorage(getDocumentConfig().storageRoot, getDocumentConfig().quarantineRoot).ciphertextExists(held.storageKey)).toBe(false);

      await fixture.disableUser("disabled");
      const disabledReceiptId = randomUUID();
      const disabledHeld = await holdImapAttachment({ bytes: Buffer.from("disabled staged"), displayName: "disabled.pdf", mediaType: "application/pdf", recipientUserId: fixture.users.disabled.id, receiptId: disabledReceiptId });
      await getDb().insert(imapIngestionMessages).values({ id: disabledReceiptId, mailbox: "expiry", mailboxUidValidity: "77", mailboxUid: 904, contentSha256: randomUUID().replaceAll("-", ""), recipientAliasSha256: "disabled", userId: fixture.users.disabled.id, status: "pending_review", expiresAt: new Date(Date.now() + 86_400_000), receiptStatus: "pending" });
      await getDb().insert(imapIngestionAttachments).values({ id: disabledHeld.id, messageId: disabledReceiptId, displayName: disabledHeld.displayName, mediaType: disabledHeld.mediaType, sizeBytes: disabledHeld.sizeBytes, contentSha256: disabledHeld.contentSha256, storageKey: disabledHeld.storageKey, ciphertextSize: disabledHeld.ciphertextSize, ...disabledHeld.envelope, status: "stored" });
      await purgeExpiredImapStaging(new Date());
      expect(await new LocalDocumentStorage(getDocumentConfig().storageRoot, getDocumentConfig().quarantineRoot).ciphertextExists(disabledHeld.storageKey)).toBe(false);
      expect((await getDb().select({ failureCode: imapIngestionMessages.failureCode }).from(imapIngestionMessages).where(eq(imapIngestionMessages.id, disabledReceiptId)))[0].failureCode).toBe("account_disabled");

      const retryReceiptId = randomUUID();
      const retryHeld = await holdImapAttachment({ bytes: Buffer.from("retry staged"), displayName: "retry.pdf", mediaType: "application/pdf", recipientUserId: fixture.users.member.id, receiptId: retryReceiptId });
      await getDb().insert(imapIngestionMessages).values({ id: retryReceiptId, mailbox: "expiry", mailboxUidValidity: "77", mailboxUid: 905, contentSha256: randomUUID().replaceAll("-", ""), recipientAliasSha256: "retry", userId: fixture.users.member.id, status: "pending_review", expiresAt: future, receiptStatus: "pending" });
      await getDb().insert(imapIngestionAttachments).values({ id: retryHeld.id, messageId: retryReceiptId, displayName: retryHeld.displayName, mediaType: retryHeld.mediaType, sizeBytes: retryHeld.sizeBytes, contentSha256: retryHeld.contentSha256, storageKey: retryHeld.storageKey, ciphertextSize: retryHeld.ciphertextSize, ...retryHeld.envelope, status: "stored" });
      let purgeFailures = 1;
      setImapHoldingPurgeImplementationForTests(async (storageKey) => {
        if (purgeFailures > 0) { purgeFailures -= 1; throw new Error("synthetic storage failure"); }
        await new LocalDocumentStorage(getDocumentConfig().storageRoot, getDocumentConfig().quarantineRoot).deleteCiphertext(storageKey);
      });
      await purgeExpiredImapStaging(new Date());
      expect((await getDb().select({ status: imapIngestionMessages.status }).from(imapIngestionMessages).where(eq(imapIngestionMessages.id, retryReceiptId)))[0].status).toBe("recoverable");
      await purgeExpiredImapStaging(new Date());
      expect((await getDb().select({ status: imapIngestionMessages.status }).from(imapIngestionMessages).where(eq(imapIngestionMessages.id, retryReceiptId)))[0].status).toBe("expired");
    } finally {
      setImapHoldingPurgeImplementationForTests(undefined);
      await fixture.cleanup();
    }
  });

  it("holds terminal exhaustion in recoverable cleanup until all staged bytes are purged", async () => {
    const fixture = await createIntegrationFixture("imap-terminal-staging-cleanup");
    try {
      const config = mailboxConfig();
      const alias = imapRecipientAlias(fixture.users.member.id, config);
      const receiptId = randomUUID();
      const leaseToken = randomUUID();
      const held = await holdImapAttachment({ bytes: Buffer.from("prior attempt ciphertext"), displayName: "prior.pdf", mediaType: "application/pdf", recipientUserId: fixture.users.member.id, receiptId });
      await getDb().insert(imapIngestionMessages).values({ id: receiptId, mailbox: config.mailbox, mailboxUidValidity: "77", mailboxUid: 910, contentSha256: randomUUID().replaceAll("-", ""), recipientAliasSha256: "terminal", userId: fixture.users.member.id, status: "processing", expiresAt: new Date(Date.now() + 86_400_000), receiptStatus: "processing", attachmentProcessingAttempts: 5, attachmentProcessingLockedAt: new Date(Date.now() - 11 * 60_000), attachmentProcessingLeaseToken: leaseToken, attachmentProcessingNextAttemptAt: new Date(0) });
      await getDb().insert(imapIngestionAttachments).values({ id: held.id, messageId: receiptId, displayName: held.displayName, mediaType: held.mediaType, sizeBytes: held.sizeBytes, contentSha256: held.contentSha256, storageKey: held.storageKey, ciphertextSize: held.ciphertextSize, ...held.envelope, status: "stored" });
      await getDb().insert(imapIngestionStagingObjects).values({ messageId: receiptId, leaseToken, storageKey: held.storageKey, status: "committed" });
      const provider = fakeClient([{ uid: 910, headers: Buffer.from(`X-Original-To: ${alias}\r\n\r\n`), bodyStructure: pdfBodyStructure(), source: Buffer.from("later retry") }]);
      setImapClientFactoryForTests(() => provider.client as never);

      await runImapIngestionCycle(config);
      const [recoverable] = await getDb().select().from(imapIngestionMessages).where(eq(imapIngestionMessages.id, receiptId));
      expect(recoverable).toMatchObject({ status: "recoverable", attachmentProcessingAttempts: 5, failureCode: "attachment_processing_exhausted" });
      expect(provider.downloads).toEqual([]);
      expect(await new LocalDocumentStorage(getDocumentConfig().storageRoot, getDocumentConfig().quarantineRoot).ciphertextExists(held.storageKey)).toBe(true);

      await purgeExpiredImapStaging(new Date());
      const [failed] = await getDb().select().from(imapIngestionMessages).where(eq(imapIngestionMessages.id, receiptId));
      expect(failed).toMatchObject({ status: "failed", attachmentProcessingAttempts: 5, failureCode: "attachment_processing_exhausted" });
      expect(await new LocalDocumentStorage(getDocumentConfig().storageRoot, getDocumentConfig().quarantineRoot).ciphertextExists(held.storageKey)).toBe(false);
      expect((await getDb().select({ status: imapIngestionAttachments.status, purgePending: imapIngestionAttachments.purgePending }).from(imapIngestionAttachments).where(eq(imapIngestionAttachments.messageId, receiptId)))[0]).toMatchObject({ status: "rejected", purgePending: false });
      expect(await getDb().select({ id: imapIngestionStagingObjects.id }).from(imapIngestionStagingObjects).where(eq(imapIngestionStagingObjects.messageId, receiptId))).toHaveLength(0);
    } finally {
      setImapClientFactoryForTests(undefined);
      await fixture.cleanup();
    }
  });

  it("records discard purge intent before an injected storage failure and retries safely", async () => {
    const fixture = await createIntegrationFixture("imap-discard-purge-intent");
    try {
      const receiptId = randomUUID();
      const leaseToken = randomUUID();
      const held = await holdImapAttachment({ bytes: Buffer.from("discard ciphertext"), displayName: "discard.pdf", mediaType: "application/pdf", recipientUserId: fixture.users.member.id, receiptId });
      await getDb().insert(imapIngestionMessages).values({ id: receiptId, mailbox: "discard", mailboxUidValidity: "77", mailboxUid: 911, contentSha256: randomUUID().replaceAll("-", ""), recipientAliasSha256: "discard", userId: fixture.users.member.id, status: "pending_review", expiresAt: new Date(Date.now() + 86_400_000), receiptStatus: "pending" });
      await getDb().insert(imapIngestionAttachments).values({ id: held.id, messageId: receiptId, displayName: held.displayName, mediaType: held.mediaType, sizeBytes: held.sizeBytes, contentSha256: held.contentSha256, storageKey: held.storageKey, ciphertextSize: held.ciphertextSize, ...held.envelope, status: "stored" });
      await getDb().insert(imapIngestionStagingObjects).values({ messageId: receiptId, leaseToken, storageKey: held.storageKey, status: "committed" });
      setImapHoldingPurgeImplementationForTests(async () => { throw new Error("injected discard purge failure"); });

      await expect(discardImapReviewItem(fixture.users.member.id, receiptId)).rejects.toMatchObject({ code: "staging_purge_failed" });
      const [pendingPurge] = await getDb().select({ status: imapIngestionAttachments.status, purgePending: imapIngestionAttachments.purgePending }).from(imapIngestionAttachments).where(eq(imapIngestionAttachments.id, held.id));
      expect(pendingPurge).toMatchObject({ status: "stored", purgePending: true });
      expect(await new LocalDocumentStorage(getDocumentConfig().storageRoot, getDocumentConfig().quarantineRoot).ciphertextExists(held.storageKey)).toBe(true);

      setImapHoldingPurgeImplementationForTests(undefined);
      await discardImapReviewItem(fixture.users.member.id, receiptId);
      expect((await getDb().select({ status: imapIngestionMessages.status }).from(imapIngestionMessages).where(eq(imapIngestionMessages.id, receiptId)))[0].status).toBe("discarded");
      expect((await getDb().select({ status: imapIngestionAttachments.status, purgePending: imapIngestionAttachments.purgePending }).from(imapIngestionAttachments).where(eq(imapIngestionAttachments.messageId, receiptId)))[0]).toMatchObject({ status: "rejected", purgePending: false });
      expect(await new LocalDocumentStorage(getDocumentConfig().storageRoot, getDocumentConfig().quarantineRoot).ciphertextExists(held.storageKey)).toBe(false);
    } finally {
      setImapHoldingPurgeImplementationForTests(undefined);
      await fixture.cleanup();
    }
  });
});
