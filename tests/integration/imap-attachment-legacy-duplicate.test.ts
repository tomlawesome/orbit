import { randomUUID } from "node:crypto";
import { eq, inArray, sql } from "drizzle-orm";
import { afterAll, describe, expect, it, vi } from "vitest";
import { getDb } from "@/db";
import { imapIngestionAttachments, imapIngestionMessages, imapIngestionStagingObjects } from "@/db/schema";
import { runDocumentMaintenanceCycle } from "@/server/document-worker";
import { resetDocumentConfigForTests } from "@/server/documents/config";
import { commitStagedAttachment, imapRecipientAlias, runImapIngestionCycle, setImapClientFactoryForTests } from "@/server/mail-in/imap-ingestion";
import { holdAttachmentBytes } from "../support/imap-holding";
import { testImapConfig } from "../support/imap-config";
import { syntheticPdf } from "../support/synthetic-documents";
import { cleanupIntegrationEnvironment, createIntegrationFixture } from "./support/fixtures";
import { attributedHeaders, fakeImapMailbox, verifiedSenderFor } from "./support/mail-in";
import { signedSource } from "./support/dkim-fixture";
import {
  attachmentColumns, attachmentsOfMessage, indexFor, openSeal, seedAttachment, seedReceipt, sha256Of, stubPdfinfo, type SealScope,
} from "./support/imap-attachment-hash";

/* A-S1 (audit v0.3.9-c, #1844): a mail held before #1778 keeps its attachment
   hash plain with `content_index` NULL until the backfill reaches it. Migration
   0017 dropped the per-mail unique on `(message_id, content_sha256)`, so a
   retried attempt that re-commits the same file must still be refused by
   `commitStagedAttachment` as a duplicate of the legacy row; otherwise a second
   copy is held and the backfill's `content_index` UPDATE later violates
   `imap_attachment_message_index_unique` and stops the maintenance cycle. */

/* #1681: attribution needs a DKIM signature this stub publishes. */
vi.mock("node:dns/promises", async () => (await import("./support/dkim-fixture")).fixtureDnsModule());

vi.mock("@/server/documents/scanner", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/server/documents/scanner")>(),
  scanFileWithClamAv: vi.fn(async () => ({ status: "clean" as const })),
}));

const unstubPdfinfo = stubPdfinfo();

afterAll(async () => {
  unstubPdfinfo();
  setImapClientFactoryForTests(undefined);
  await cleanupIntegrationEnvironment();
});

/* Loaded when a test runs, as the backfill tests do. */
const BACKFILL_MODULE = "@/server/document-maintenance/imap-attachment-hash-backfill";
async function backfill(limit?: number): Promise<number> {
  const module = await import(/* @vite-ignore */ BACKFILL_MODULE) as { backfillImapAttachmentHashes: (limit?: number) => Promise<number> };
  return module.backfillImapAttachmentHashes(limit);
}

async function plainCount(): Promise<number> {
  const rows = await getDb().execute<{ n: number }>(sql`select count(*)::int as n from imap_ingestion_attachments where content_sha256 is not null`);
  return Number(rows[0]!.n);
}
/** Runs the backfill until no plain attachment hash is left anywhere, so a bounded batch reaches only the rows a test plants. */
async function drainAll() {
  for (let guard = 0; guard < 200 && await plainCount() > 0; guard += 1) await backfill();
  expect(await plainCount(), "no imap_ingestion_attachments row keeps a plain hash").toBe(0);
}

async function expectBackfilled(scope: SealScope, receiptId: string, attachmentId: string, sha: string) {
  const row = await attachmentColumns(attachmentId);
  expect(row.plain, "the plain column is emptied").toBeNull();
  expect(row.sealed, "a sealed hash is stored").not.toBeNull();
  expect(await openSeal(scope, attachmentId, row.sealed)).toEqual({ ok: true, sha256: sha });
  expect(row.contentIndex, "the index is the instance key's over <messageId>:<sha256>").toBe(await indexFor(receiptId, sha));
  return row;
}

async function ledgerOf(storageKey: string) {
  return getDb().select({ status: imapIngestionStagingObjects.status }).from(imapIngestionStagingObjects)
    .where(eq(imapIngestionStagingObjects.storageKey, storageKey));
}

/** Receipts are removed after each test (attachments and ledger rows cascade), so a doubled pair left by one test never reaches another test's backfill. */
async function removeReceipts(ids: string[]) {
  if (ids.length) await getDb().delete(imapIngestionMessages).where(inArray(imapIngestionMessages.id, ids));
}

type Fixture = Awaited<ReturnType<typeof createIntegrationFixture>>;

/** Shared setup S of the spec: a processing receipt under a live lease, a legacy plain-hashed row of `legacySha`, and a held, ledgered copy of `bytes` for the retry. */
async function setupS(fixture: Fixture, options: { bytes: Buffer; legacySha: string; receiptId?: string; leaseToken?: string }) {
  const member = fixture.users.member.id;
  const leaseToken = options.leaseToken ?? randomUUID();
  const receiptId = options.receiptId ?? await seedReceipt({
    userId: member, householdId: fixture.household.id, status: "processing", leaseToken, lockedAt: new Date(), attempts: 1,
  });
  const legacyId = await seedAttachment(receiptId, { sha256: options.legacySha, plain: true });
  const held = await holdAttachmentBytes({ bytes: options.bytes, displayName: "receipt.pdf", mediaType: "application/pdf", recipientUserId: member, receiptId });
  await getDb().insert(imapIngestionStagingObjects).values({ messageId: receiptId, leaseToken, storageKey: held.storageKey, status: "pending" });
  return { receiptId, leaseToken, legacyId, held };
}

describe("a retried legacy mail does not hold the same file twice (A-S1)", () => {
  it("refuses the retry's second copy of a file the mail already holds under a plain hash", async () => {
    const fixture = await createIntegrationFixture("imap-legacy-duplicate-commit");
    const receipts: string[] = [];
    try {
      const bytes = syntheticPdf("legacy duplicate");
      const sha = sha256Of(bytes);
      const { receiptId, leaseToken, legacyId, held } = await setupS(fixture, { bytes, legacySha: sha });
      receipts.push(receiptId);

      await expect(commitStagedAttachment(receiptId, leaseToken, held)).resolves.toBe("duplicate");

      const rows = await attachmentsOfMessage(receiptId);
      expect(rows, "the mail keeps exactly one copy").toHaveLength(1);
      expect(rows[0]).toMatchObject({ id: legacyId, plain: sha, contentIndex: null });
      expect(await getDb().select({ id: imapIngestionAttachments.id }).from(imapIngestionAttachments)
        .where(eq(imapIngestionAttachments.storageKey, held.storageKey)), "the retry's copy is not stored").toHaveLength(0);
      expect(await ledgerOf(held.storageKey)).toEqual([{ status: "purge_pending" }]);
    } finally {
      await removeReceipts(receipts);
      await fixture.cleanup();
    }
  });

  it("then the backfill seals the legacy row and the maintenance cycle completes", async () => {
    const fixture = await createIntegrationFixture("imap-legacy-duplicate-backfill");
    const receipts: string[] = [];
    try {
      await drainAll();
      const bytes = syntheticPdf("legacy duplicate");
      const sha = sha256Of(bytes);
      const { receiptId, leaseToken, legacyId, held } = await setupS(fixture, { bytes, legacySha: sha });
      receipts.push(receiptId);
      await commitStagedAttachment(receiptId, leaseToken, held);

      await expect(backfill()).resolves.toBeGreaterThanOrEqual(1);
      await expectBackfilled({ household: fixture.household.id }, receiptId, legacyId, sha);
      await expect(runDocumentMaintenanceCycle()).resolves.toBeUndefined();
      expect(await attachmentsOfMessage(receiptId)).toHaveLength(1);
    } finally {
      await removeReceipts(receipts);
      await fixture.cleanup();
    }
  });

  it("still inserts a different file of the same mail, and the same file of another mail", async () => {
    const fixture = await createIntegrationFixture("imap-legacy-duplicate-legitimate");
    const receipts: string[] = [];
    try {
      const bytes = syntheticPdf("legacy duplicate");
      const sha = sha256Of(bytes);

      /* (a) the mail's legacy row is of another file */
      const other = await setupS(fixture, { bytes, legacySha: sha256Of("other file") });
      receipts.push(other.receiptId);
      await expect(commitStagedAttachment(other.receiptId, other.leaseToken, other.held)).resolves.toBe("inserted");
      const rows = await attachmentsOfMessage(other.receiptId);
      expect(rows).toHaveLength(2);
      const inserted = rows.find((row) => row.id === other.held.id);
      expect(inserted, "the new row is stored").toBeDefined();
      expect(inserted!.plain).toBeNull();
      expect(inserted!.contentIndex).toBe(await indexFor(other.receiptId, sha));

      /* (b) another mail holds the same file under a plain hash: the dedupe is per mail */
      const member = fixture.users.member.id;
      const receiptId = await seedReceipt({ userId: member, householdId: fixture.household.id, status: "processing", leaseToken: randomUUID(), lockedAt: new Date(), attempts: 1 });
      receipts.push(receiptId);
      await seedAttachment(receiptId, { sha256: sha, plain: true });
      const leaseToken2 = randomUUID();
      const receipt2 = await seedReceipt({ userId: member, householdId: fixture.household.id, status: "processing", leaseToken: leaseToken2, lockedAt: new Date(), attempts: 1 });
      receipts.push(receipt2);
      const held2 = await holdAttachmentBytes({ bytes, displayName: "receipt.pdf", mediaType: "application/pdf", recipientUserId: member, receiptId: receipt2 });
      await getDb().insert(imapIngestionStagingObjects).values({ messageId: receipt2, leaseToken: leaseToken2, storageKey: held2.storageKey, status: "pending" });
      await expect(commitStagedAttachment(receipt2, leaseToken2, held2)).resolves.toBe("inserted");
      expect(await attachmentsOfMessage(receipt2)).toHaveLength(1);
    } finally {
      await removeReceipts(receipts);
      await fixture.cleanup();
    }
  });

  it("gives the same answer when the backfill reaches the legacy row before the retry commits", async () => {
    const fixture = await createIntegrationFixture("imap-legacy-duplicate-other-order");
    const receipts: string[] = [];
    try {
      await drainAll();
      const bytes = syntheticPdf("legacy duplicate");
      const sha = sha256Of(bytes);
      const { receiptId, leaseToken, legacyId, held } = await setupS(fixture, { bytes, legacySha: sha });
      receipts.push(receiptId);
      await expect(backfill()).resolves.toBeGreaterThanOrEqual(1);

      await expect(commitStagedAttachment(receiptId, leaseToken, held)).resolves.toBe("duplicate");
      const rows = await attachmentsOfMessage(receiptId);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.id).toBe(legacyId);
      expect(rows[0]!.contentIndex).toBe(await indexFor(receiptId, sha));
    } finally {
      await removeReceipts(receipts);
      await fixture.cleanup();
    }
  });

  it("end to end: the ingestion cycle's retry of a legacy mail leaves its one held copy", async () => {
    const fixture = await createIntegrationFixture("imap-legacy-duplicate-cycle");
    const receipts: string[] = [];
    const previousScanMode = process.env.DOCUMENT_SCAN_MODE;
    try {
      /* The mailbox path holds an attachment only with the scanner required (the scan itself is mocked clean). */
      process.env.DOCUMENT_SCAN_MODE = "required";
      resetDocumentConfigForTests();
      const config = testImapConfig({
        host: "imap.example.invalid",
        user: "orbit-test",
        password: "test-only-password",
        recipientDomain: "ingest.example.invalid",
        currentAliasSecret: "test-only-current-alias-secret-is-long-enough",
      });
      const member = fixture.users.member.id;
      const memberSender = await verifiedSenderFor(member);
      const header = attributedHeaders(memberSender, imapRecipientAlias(member, config));
      const [receipt] = await getDb().insert(imapIngestionMessages).values({
        mailbox: config.mailbox, mailboxUidValidity: "77", mailboxUid: 800,
        recipientAliasSha256: "legacy-retry", userId: member, status: "processing",
        expiresAt: new Date(Date.now() + 86_400_000), receiptStatus: "processing",
        attachmentProcessingAttempts: 1, attachmentProcessingLeaseToken: randomUUID(),
        attachmentProcessingLockedAt: new Date(Date.now() - 11 * 60_000), attachmentProcessingNextAttemptAt: null,
      }).returning({ id: imapIngestionMessages.id });
      receipts.push(receipt.id);
      const sha = sha256Of(syntheticPdf("mailbox attachment"));
      const legacyId = await seedAttachment(receipt.id, { sha256: sha, plain: true });
      const provider = fakeImapMailbox({
        uidValidity: 77,
        messages: [{
          uid: 800, headers: header, size: 6, source: await signedSource(memberSender, "legacy retry"),
          bodyStructure: { part: "1", type: "application", subtype: "pdf", disposition: "attachment", dispositionParameters: { filename: "receipt.pdf" }, size: 64 } as never,
        }],
        download: () => syntheticPdf("mailbox attachment"),
      });
      setImapClientFactoryForTests(() => provider.client as never);

      await runImapIngestionCycle(config);

      const [after] = await getDb().select({ status: imapIngestionMessages.status, failure: imapIngestionMessages.attachmentProcessingFailureCode }).from(imapIngestionMessages).where(eq(imapIngestionMessages.id, receipt.id));
      expect(after, "the retry completed").toEqual({ status: "pending_review", failure: null });
      const rows = await attachmentsOfMessage(receipt.id);
      expect(rows, "the member sees one held copy, not two").toHaveLength(1);
      expect(rows[0]).toMatchObject({ id: legacyId, plain: sha });
      expect(await getDb().select({ id: imapIngestionStagingObjects.id }).from(imapIngestionStagingObjects)
        .where(eq(imapIngestionStagingObjects.messageId, receipt.id))).toHaveLength(0);
      expect(provider.downloads).toEqual(["800:1"]);
    } finally {
      if (previousScanMode === undefined) delete process.env.DOCUMENT_SCAN_MODE;
      else process.env.DOCUMENT_SCAN_MODE = previousScanMode;
      resetDocumentConfigForTests();
      setImapClientFactoryForTests(undefined);
      await removeReceipts(receipts);
      await fixture.cleanup();
    }
  });
});
