import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/db";
import { documentJobs, documentStagingObjects, documents, imapIngestionAttachments, imapIngestionMessages } from "@/db/schema";
import { uploadItemDocument } from "@/server/document-repository";
import { runDocumentMaintenanceCycle } from "@/server/document-worker";
import { getDocumentConfig } from "@/server/documents/config";
import { scanFileWithClamAv } from "@/server/documents/scanner";
import { LocalDocumentStorage } from "@/server/documents/storage";
import { canonicalReviewedIntakeHash } from "@/server/reviewed-intake";
import { PDF_STORED_MAX_PAGES } from "@/server/documents/validation";
import { reviewInboxState } from "@/server/mail-in/core/review-state";
import { purgeHeldImapAttachment, scanAndHoldImapAttachment, setImapHoldingPurgeImplementationForTests } from "@/server/mail-in/imap-attachment-holding";
import { cleanupIntegrationEnvironment, createIntegrationFixture, withRequiredScanMode as withRequiredScanModeKeepingConfig } from "./support/fixtures";
import { syntheticPdf as createSyntheticPdf } from "../support/synthetic-documents";
import { sealedHash } from "./support/imap-attachment-seed";

/* #1932, spec: #1811 ruling (note 67362) items 1 and 2. The maintenance cycle
   settles stuck pre-#1398 mail transfers: `assigned` + `purge_pending`
   attachments whose document is `rejected` or has no row. */

vi.mock("@/server/documents/scanner", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/server/documents/scanner")>(),
  scanFileWithClamAv: vi.fn(),
  pingClamAv: vi.fn(async () => true),
}));

afterAll(async () => {
  await cleanupIntegrationEnvironment();
});

afterEach(() => {
  vi.mocked(scanFileWithClamAv).mockReset();
  vi.mocked(scanFileWithClamAv).mockResolvedValue({ status: "clean" });
});

const withRequiredScanMode = <T>(work: () => Promise<T>) => withRequiredScanModeKeepingConfig(work, () => {
  vi.mocked(scanFileWithClamAv).mockReset();
  vi.mocked(scanFileWithClamAv).mockResolvedValue({ status: "clean" });
});


/**
 * The #383 finding 4 start state (#1802): a held mailbox attachment approved
 * while the scanner is down, so its document is staged `scanning` and the
 * attachment is `assigned`/`purgePending`. This is the state the code before
 * #1398 left; it is seeded directly because #1398 refuses approval during an
 * outage. Counts held-copy purges; call `finish()` to restore the purge
 * implementation.
 */
async function startStagedMailApproval(label: string, options: { purgeThrows?: boolean } = {}) {
  const fixture = await createIntegrationFixture(label);
  const receiptId = randomUUID();
  const heldBytes = createSyntheticPdf(`staged mail ${label}`);
  const held = await scanAndHoldImapAttachment({
    bytes: heldBytes,
    filename: "staged-mail.pdf",
    declaredMediaType: "application/pdf",
    recipientUserId: fixture.users.member.id,
    receiptId,
  });
  const receiptExpiresAt = new Date(Date.now() + 86_400_000);
  await getDb().insert(imapIngestionMessages).values({
    id: receiptId,
    mailbox: "private", mailboxUidValidity: label, mailboxUid: 7,
    recipientAliasSha256: label, userId: fixture.users.member.id, householdId: fixture.household.id,
    status: "pending_review", expiresAt: receiptExpiresAt, receiptStatus: "pending",
  });
  await getDb().insert(imapIngestionAttachments).values({
    id: held.id, messageId: receiptId, displayName: held.displayName, mediaType: held.mediaType,
    sizeBytes: held.sizeBytes, ...await sealedHash(receiptId, held.id, held.contentSha256), storageKey: held.storageKey,
    ciphertextSize: held.ciphertextSize, ...held.envelope, status: "stored",
  });
  const input = {
    operationId: randomUUID(),
    source: { kind: "mailbox_draft" as const, receiptId, draftVersion: 1 },
    householdId: fixture.household.id,
    sectionId: fixture.section.id,
    action: "create_separate" as const,
    item: { title: `Staged mail ${label}`, currency: "GBP", status: "active" },
    attachmentIds: [held.id],
  };
  const counter = { purgeCalls: 0 };
  setImapHoldingPurgeImplementationForTests(async (storageKey) => {
    counter.purgeCalls += 1;
    if (options.purgeThrows) throw new Error("synthetic held-copy purge outage");
    setImapHoldingPurgeImplementationForTests(undefined);
    await purgeHeldImapAttachment(storageKey);
  });
  vi.mocked(scanFileWithClamAv).mockResolvedValue({ status: "error", reason: "unavailable" });
  const uploaded = await withRequiredScanMode(() => uploadItemDocument({
    userId: fixture.users.member.id,
    householdId: fixture.household.id,
    itemId: input.operationId,
    staged: true,
    filename: held.displayName,
    body: new Blob([new Uint8Array(heldBytes)]).stream() as ReadableStream<Uint8Array>,
    declaredBytes: held.sizeBytes,
    maxBytes: held.sizeBytes,
    maxPages: PDF_STORED_MAX_PAGES,
    documentId: held.id,
    detectDuplicates: false,
  }));
  expect(uploaded.recoverable).toBe(true);
  const [seeded] = await getDb().select({ lifecycle: documents.lifecycle, scanStatus: documents.scanStatus, failureCode: documents.failureCode })
    .from(documents).where(eq(documents.id, held.id));
  expect(seeded).toEqual({ lifecycle: "scanning", scanStatus: "error", failureCode: "scanner_unavailable" });
  const [seededStage] = await getDb().select({ status: documentStagingObjects.status }).from(documentStagingObjects).where(eq(documentStagingObjects.documentId, held.id));
  expect(seededStage).toEqual({ status: "pending" });
  expect(await getDb().select({ id: documentJobs.id }).from(documentJobs).where(and(eq(documentJobs.documentId, held.id), eq(documentJobs.kind, "scan")))).toHaveLength(1);
  await getDb().update(imapIngestionAttachments).set({
    status: "assigned", assignedDocumentId: held.id, purgePending: true, purgeFailureCode: null,
    transferClaimToken: null, transferClaimedAt: null, transferLeaseExpiresAt: null,
  }).where(eq(imapIngestionAttachments.id, held.id));
  await getDb().update(imapIngestionMessages).set({
    status: "recoverable", failureCode: "scanner_unavailable",
    approvalOperationId: input.operationId, approvalResultId: randomUUID(),
    approvalRequestSha256: canonicalReviewedIntakeHash(input), approvalStartedAt: new Date(),
  }).where(eq(imapIngestionMessages.id, receiptId));
  const attachment = async () => (await getDb().select({
    status: imapIngestionAttachments.status, assignedDocumentId: imapIngestionAttachments.assignedDocumentId,
    purgePending: imapIngestionAttachments.purgePending, purgeFailureCode: imapIngestionAttachments.purgeFailureCode,
  }).from(imapIngestionAttachments).where(eq(imapIngestionAttachments.id, held.id)))[0]!;
  const receipt = async () => (await getDb().select({ status: imapIngestionMessages.status, failureCode: imapIngestionMessages.failureCode })
    .from(imapIngestionMessages).where(eq(imapIngestionMessages.id, receiptId)))[0]!;
  const documentRow = async (id: string) => (await getDb().select({ lifecycle: documents.lifecycle, scanStatus: documents.scanStatus, failureCode: documents.failureCode })
    .from(documents).where(eq(documents.id, id)))[0]!;
  const staged = await attachment();
  expect(staged.status).toBe("assigned");
  const documentId = staged.assignedDocumentId!;
  expect(documentId).toBeTruthy();
  const storage = new LocalDocumentStorage(getDocumentConfig().storageRoot, getDocumentConfig().quarantineRoot);
  const stateOf = (failureCode: string) => reviewInboxState("recoverable", failureCode, {
    hasApprovalOperation: true, hasApprovedItem: true, hasApprovalRequest: true, expiresAt: receiptExpiresAt,
  });
  return { fixture, receiptId, held, input, counter, documentId, attachment, receipt, documentRow, storage, stateOf, finish: () => setImapHoldingPurgeImplementationForTests(undefined) };
}

/** The #1802 T6 stuck state: document rejected, stage and job gone, attachment still assigned. */
async function leaveStuck(start: Awaited<ReturnType<typeof startStagedMailApproval>>, failureCode: string) {
  await getDb().update(documents).set({ lifecycle: "rejected", scanStatus: "error", failureCode })
    .where(eq(documents.id, start.documentId));
  await getDb().delete(documentStagingObjects).where(eq(documentStagingObjects.documentId, start.documentId));
  await getDb().delete(documentJobs).where(eq(documentJobs.documentId, start.documentId));
  expect(await start.attachment()).toMatchObject({ status: "assigned", purgePending: true });
}

describe("maintenance settles stuck mail transfers (#1932, #1811 items 1-2)", () => {
  it("item 1: a stuck transfer (document rejected) is settled by one cycle, and a second cycle changes nothing", async () => {
    const start = await startStagedMailApproval("settle-sweep-stuck");
    try {
      await withRequiredScanMode(async () => {
        await leaveStuck(start, "scan_recovery_expired");
        await runDocumentMaintenanceCycle();
        const settledState = async () => {
          expect(await start.attachment()).toMatchObject({ status: "stored", assignedDocumentId: null, purgePending: false });
          expect(await start.receipt()).toEqual({ status: "recoverable", failureCode: "scan_recovery_expired" });
          expect(start.counter.purgeCalls).toBe(0);
          expect(await start.storage.ciphertextExists(start.held.storageKey)).toBe(true);
        };
        await settledState();
        await runDocumentMaintenanceCycle();
        await settledState();
      });
    } finally {
      start.finish();
    }
  });

  it("item 1: a stuck transfer whose document row is missing is released as scan_recovery_expired", async () => {
    const start = await startStagedMailApproval("settle-sweep-missing");
    try {
      await withRequiredScanMode(async () => {
        await leaveStuck(start, "scan_recovery_expired");
        await getDb().delete(documents).where(eq(documents.id, start.documentId));
        expect(await getDb().select({ id: documents.id }).from(documents).where(eq(documents.id, start.documentId))).toHaveLength(0);
        await runDocumentMaintenanceCycle();
        expect(await start.attachment()).toMatchObject({ status: "stored", assignedDocumentId: null, purgePending: false });
        expect(await start.receipt()).toEqual({ status: "recoverable", failureCode: "scan_recovery_expired" });
        expect(start.counter.purgeCalls).toBe(0);
        expect(await start.storage.ciphertextExists(start.held.storageKey)).toBe(true);
      });
    } finally {
      start.finish();
    }
  });

  it("item 1: a row whose document is scanning, or available, is not touched", async () => {
    const scanning = await startStagedMailApproval("settle-sweep-scanning");
    const available = await startStagedMailApproval("settle-sweep-available");
    try {
      await withRequiredScanMode(async () => {
        // The scanner stays down, so the scanning document's recovery is not due and cannot end.
        await getDb().update(documents).set({ lifecycle: "available", scanStatus: "clean", failureCode: null })
          .where(eq(documents.id, available.documentId));
        await runDocumentMaintenanceCycle();
        expect(await scanning.documentRow(scanning.documentId)).toMatchObject({ lifecycle: "scanning" });
        expect(await scanning.attachment()).toMatchObject({ status: "assigned", assignedDocumentId: scanning.documentId, purgePending: true });
        expect(await scanning.receipt()).toEqual({ status: "recoverable", failureCode: "scanner_unavailable" });
        expect(await available.attachment()).toMatchObject({ status: "assigned", assignedDocumentId: available.documentId, purgePending: true });
        expect(await available.receipt()).toEqual({ status: "recoverable", failureCode: "scanner_unavailable" });
        expect(available.counter.purgeCalls).toBe(0);
        expect(await available.storage.ciphertextExists(available.held.storageKey)).toBe(true);
      });
    } finally {
      scanning.finish();
      available.finish();
    }
  });

  it("item 1: one cycle settles at most 25 stuck transfers", async () => {
    const starts: Array<Awaited<ReturnType<typeof startStagedMailApproval>>> = [];
    try {
      for (let index = 0; index < 27; index += 1) starts.push(await startStagedMailApproval(`settle-sweep-cap-${index}`));
      await withRequiredScanMode(async () => {
        for (const start of starts) await leaveStuck(start, "scan_recovery_expired");
        await runDocumentMaintenanceCycle();
        const states = await Promise.all(starts.map((start) => start.attachment()));
        expect(states.filter((state) => state.status === "stored")).toHaveLength(25);
        expect(states.filter((state) => state.status === "assigned")).toHaveLength(2);
      });
    } finally {
      for (const start of starts) start.finish();
    }
  }, 300_000);

  it("item 2: a stuck transfer whose document was found infected ends: attachment rejected, held copy purged once", async () => {
    const start = await startStagedMailApproval("settle-sweep-malware");
    try {
      await withRequiredScanMode(async () => {
        await leaveStuck(start, "malware_detected");
        await runDocumentMaintenanceCycle();
        expect(await start.attachment()).toMatchObject({ status: "rejected", purgePending: false });
        expect(start.counter.purgeCalls).toBe(1);
        expect(await start.receipt()).toEqual({ status: "recoverable", failureCode: "attachment_rejected_malware" });
      });
    } finally {
      start.finish();
    }
  });

  it("item 2: a stuck transfer whose document failed the structure check ends as rejected with the structure code", async () => {
    const start = await startStagedMailApproval("settle-sweep-structure");
    try {
      await withRequiredScanMode(async () => {
        await leaveStuck(start, "unsupported_structure");
        await runDocumentMaintenanceCycle();
        expect(await start.attachment()).toMatchObject({ status: "rejected", purgePending: false });
        expect(start.counter.purgeCalls).toBe(1);
        expect(await start.receipt()).toEqual({ status: "recoverable", failureCode: "attachment_rejected_structure" });
      });
    } finally {
      start.finish();
    }
  });
});
