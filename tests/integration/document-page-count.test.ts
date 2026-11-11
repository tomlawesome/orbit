import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/db";
import { documentCrypto, documentJobs, documents, imapIngestionAttachments, imapIngestionMessages } from "@/db/schema";
import { scanAndHoldImapAttachment } from "@/server/mail-in/imap-attachment-holding";
import { approveReviewedIntake } from "@/server/reviewed-intake";
import { PDF_STORED_MAX_PAGES } from "@/server/documents/validation";
import { scanFileWithClamAv } from "@/server/documents/scanner";
import { runDocumentMaintenanceCycle } from "@/server/document-worker";
import { cleanupIntegrationEnvironment, createIntegrationFixture, withRequiredScanMode } from "./support/fixtures";
import { callRouteForSession, loadRoute } from "./support/request-event";
import { syntheticJpeg } from "../support/synthetic-documents";
import { textPagesPdf } from "../support/pdf-measure/fixtures";
import { NEEDS_POPPLER, popplerIt } from "../support/poppler-sandbox";

/**
 * #1436 D8, design note §1.5 line 19: `documents.page_count` is written from
 * the structure check's answer at upload, `DocumentSummary.pageCount` carries
 * it, and the preview route's X-Orbit-Page-Count comes from the column, so
 * the reader has the count before anything is drawn. The PDF cases need the
 * real pdfinfo/pdftoppm (`popplerIt`: skip outside CI, fail in CI without
 * poppler). The column is read with SQL: it does not exist in the schema yet.
 */

const { POST: uploadDocument } = await loadRoute("households/[householdId]/items/[itemId]/documents");
const { GET: previewDocument } = await loadRoute("documents/[documentId]/preview");
const { POST: inspectRoute } = await loadRoute("households/[householdId]/item-document-inspection");

vi.mock("@/server/document-repository", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/document-repository")>();
  return { ...actual, uploadItemDocument: vi.fn(actual.uploadItemDocument) };
});

const { uploadItemDocument } = await import("@/server/document-repository");

/* #1803 F1: a hold made before the 100-page cap existed is simulated by judging the hold under the old 1,000-page bound (the hold is the only caller while the flag is set). */
const holdBound = vi.hoisted(() => ({ maxPages: undefined as number | undefined }));
vi.mock("@/server/documents/validation", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/documents/validation")>();
  return {
    ...actual,
    classifyDocumentStructure: ((bytes, mediaType, file, options) =>
      actual.classifyDocumentStructure(bytes, mediaType, file, holdBound.maxPages === undefined ? options : { ...options, maxPages: holdBound.maxPages })) as typeof actual.classifyDocumentStructure,
  };
});

vi.mock("@/server/documents/scanner", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/server/documents/scanner")>(),
  scanFileWithClamAv: vi.fn(),
}));

afterAll(async () => {
  await cleanupIntegrationEnvironment();
});

afterEach(() => {
  vi.mocked(scanFileWithClamAv).mockReset();
  vi.mocked(scanFileWithClamAv).mockResolvedValue({ status: "clean" });
});

type Fixture = Awaited<ReturnType<typeof createIntegrationFixture>>;

async function uploadResponse(fixture: Fixture, bytes: Buffer, mediaType: "application/pdf" | "image/jpeg", filename: string) {
  vi.mocked(scanFileWithClamAv).mockResolvedValue({ status: "clean" });
  const session = await fixture.session("member");
  const response = await callRouteForSession(uploadDocument, session, {
    url: `http://127.0.0.1:3000/api/households/${fixture.household.id}/items/${fixture.item.id}/documents`,
    method: "POST",
    headers: {
      "content-length": String(bytes.length),
      "content-type": mediaType,
      "x-orbit-filename": encodeURIComponent(filename),
    },
    body: new Uint8Array(bytes),
    params: { householdId: fixture.household.id, itemId: fixture.item.id },
  });
  return { session, response };
}

async function upload(fixture: Fixture, bytes: Buffer, mediaType: "application/pdf" | "image/jpeg", filename: string) {
  const { session, response } = await uploadResponse(fixture, bytes, mediaType, filename);
  expect(response.status).toBe(201);
  const payload = await response.json() as { document: { id: string; pageCount?: number | null } };
  return { session, document: payload.document };
}

async function storedPageCount(documentId: string): Promise<number | null> {
  const rows = await getDb().execute(sql`select page_count from documents where id = ${documentId}`);
  return (rows[0] as { page_count: number | null }).page_count;
}

describe("documents.page_count (§1.5 line 19)", () => {
  popplerIt(`a 3-page PDF upload sets page_count 3 and DocumentSummary.pageCount 3 ${NEEDS_POPPLER}`, async () => {
    const fixture = await createIntegrationFixture("page-count-pdf");
    const { document } = await upload(fixture, textPagesPdf(3), "application/pdf", "three-pages.pdf");
    expect(await storedPageCount(document.id)).toBe(3);
    expect(document.pageCount).toBe(3);
  }, 30_000);

  it("an image upload sets page_count 1 and DocumentSummary.pageCount 1", async () => {
    const fixture = await createIntegrationFixture("page-count-image");
    const { document } = await upload(fixture, syntheticJpeg(), "image/jpeg", "photo.jpg");
    expect(await storedPageCount(document.id)).toBe(1);
    expect(document.pageCount).toBe(1);
  }, 30_000);

  popplerIt(`the first preview of a 3-page PDF, before any page was drawn, carries X-Orbit-Page-Count 3 from the column ${NEEDS_POPPLER}`, async () => {
    const fixture = await createIntegrationFixture("page-count-header");
    const { session, document } = await upload(fixture, textPagesPdf(3), "application/pdf", "three-pages.pdf");
    const response = await callRouteForSession(previewDocument, session, {
      url: `http://127.0.0.1:3000/api/documents/${document.id}/preview?page=2`,
      params: { documentId: document.id },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("x-orbit-page-count")).toBe("3");
    // D6: PDF pages preview as JPEG.
    expect(response.headers.get("content-type")).toBe("image/jpeg");
  }, 30_000);
});

/**
 * §1.5 line 20: "Mail-in holding and the create-form inspection record the
 * count the same way." The note names no place of its own, so the place is
 * the one its data model (D8) gives: `documents.page_count` of the document
 * each path ends in. A held mail-in attachment becomes a document through the
 * reviewed-intake transfer (`uploadItemDocument`); the create-form inspection
 * retains nothing by design, and the form then uploads the confirmed file.
 */
describe("documents.page_count from mail-in and the create form (§1.5 line 20)", () => {
  popplerIt(`a held 3-page mail-in attachment, approved onto an item, gives its document page_count 3 ${NEEDS_POPPLER}`, async () => {
    const fixture = await createIntegrationFixture("page-count-mail-in");
    const receiptId = randomUUID();
    const held = await scanAndHoldImapAttachment({
      bytes: textPagesPdf(3),
      filename: "held-three-pages.pdf",
      declaredMediaType: "application/pdf",
      recipientUserId: fixture.users.member.id,
      receiptId,
    });
    await getDb().insert(imapIngestionMessages).values({
      id: receiptId, mailbox: "private", mailboxUidValidity: `count-${receiptId.slice(0, 8)}`, mailboxUid: 1, contentSha256: randomUUID().replaceAll("-", ""),
      recipientAliasSha256: `count-${receiptId.slice(0, 8)}`, userId: fixture.users.member.id, householdId: fixture.household.id,
      status: "pending_review", expiresAt: new Date(Date.now() + 86_400_000), receiptStatus: "pending",
    });
    await getDb().insert(imapIngestionAttachments).values({
      id: held.id, messageId: receiptId, displayName: held.displayName, mediaType: held.mediaType, sizeBytes: held.sizeBytes,
      contentSha256: held.contentSha256, storageKey: held.storageKey, ciphertextSize: held.ciphertextSize, ...held.envelope, status: "stored",
    });

    const result = await approveReviewedIntake(fixture.users.member.id, {
      operationId: randomUUID(),
      source: { kind: "mailbox_draft" as const, receiptId, draftVersion: 1 },
      householdId: fixture.household.id,
      sectionId: fixture.section.id,
      action: "create_separate" as const,
      item: { title: "Held three pages", currency: "GBP", status: "active" },
      attachmentIds: [held.id],
    });

    expect(result.outcome).toBe("approved");
    const [row] = await getDb().select({ documentId: imapIngestionAttachments.assignedDocumentId })
      .from(imapIngestionAttachments).where(eq(imapIngestionAttachments.id, held.id));
    expect(row?.documentId).toBeTruthy();
    expect(await storedPageCount(row!.documentId!)).toBe(3);
  }, 60_000);

  popplerIt(`#1801 A-F14 T4: the mail-in transfer files a held attachment under the stored page bound, maxPages 1000 ${NEEDS_POPPLER}`, async () => {
    const fixture = await createIntegrationFixture("page-count-mail-in-bound");
    const receiptId = randomUUID();
    const held = await scanAndHoldImapAttachment({
      bytes: textPagesPdf(3),
      filename: "held-bound.pdf",
      declaredMediaType: "application/pdf",
      recipientUserId: fixture.users.member.id,
      receiptId,
    });
    await getDb().insert(imapIngestionMessages).values({
      id: receiptId, mailbox: "private", mailboxUidValidity: `bound-${receiptId.slice(0, 8)}`, mailboxUid: 1, contentSha256: randomUUID().replaceAll("-", ""),
      recipientAliasSha256: `bound-${receiptId.slice(0, 8)}`, userId: fixture.users.member.id, householdId: fixture.household.id,
      status: "pending_review", expiresAt: new Date(Date.now() + 86_400_000), receiptStatus: "pending",
    });
    await getDb().insert(imapIngestionAttachments).values({
      id: held.id, messageId: receiptId, displayName: held.displayName, mediaType: held.mediaType, sizeBytes: held.sizeBytes,
      contentSha256: held.contentSha256, storageKey: held.storageKey, ciphertextSize: held.ciphertextSize, ...held.envelope, status: "stored",
    });

    const callsBefore = vi.mocked(uploadItemDocument).mock.calls.length;
    const result = await approveReviewedIntake(fixture.users.member.id, {
      operationId: randomUUID(),
      source: { kind: "mailbox_draft" as const, receiptId, draftVersion: 1 },
      householdId: fixture.household.id,
      sectionId: fixture.section.id,
      action: "create_separate" as const,
      item: { title: "Held bound", currency: "GBP", status: "active" },
      attachmentIds: [held.id],
    });

    expect(result.outcome).toBe("approved");
    const calls = vi.mocked(uploadItemDocument).mock.calls.slice(callsBefore);
    expect(calls).toHaveLength(1);
    expect((calls[0][0] as { maxPages?: number }).maxPages).toBe(1000);
  }, 60_000);

  popplerIt(`#1803 F1: a held 101-page mail-in PDF, in the state left by an approval before #1398 (seeded), is opened by scan recovery under the stored bound ${NEEDS_POPPLER}`, async () => {
    const fixture = await createIntegrationFixture("page-count-mail-in-recovery");
    const receiptId = randomUUID();
    holdBound.maxPages = 1000;
    const heldBytes = textPagesPdf(101);
    const held = await scanAndHoldImapAttachment({
      bytes: heldBytes,
      filename: "held-101.pdf",
      declaredMediaType: "application/pdf",
      recipientUserId: fixture.users.member.id,
      receiptId,
    }).finally(() => { holdBound.maxPages = undefined; });
    await getDb().insert(imapIngestionMessages).values({
      id: receiptId, mailbox: "private", mailboxUidValidity: `rec-${receiptId.slice(0, 8)}`, mailboxUid: 1, contentSha256: randomUUID().replaceAll("-", ""),
      recipientAliasSha256: `rec-${receiptId.slice(0, 8)}`, userId: fixture.users.member.id, householdId: fixture.household.id,
      status: "pending_review", expiresAt: new Date(Date.now() + 86_400_000), receiptStatus: "pending",
    });
    await getDb().insert(imapIngestionAttachments).values({
      id: held.id, messageId: receiptId, displayName: held.displayName, mediaType: held.mediaType, sizeBytes: held.sizeBytes,
      contentSha256: held.contentSha256, storageKey: held.storageKey, ciphertextSize: held.ciphertextSize, ...held.envelope, status: "stored",
    });

    vi.mocked(scanFileWithClamAv).mockResolvedValue({ status: "error", reason: "unavailable" });
    /* The state the code before #1398 left; seeded directly because #1398 refuses approval during an outage. */
    await withRequiredScanMode(async () => {
      const uploaded = await uploadItemDocument({
        userId: fixture.users.member.id,
        householdId: fixture.household.id,
        itemId: randomUUID(),
        staged: true,
        filename: held.displayName,
        body: new Blob([new Uint8Array(heldBytes)]).stream() as ReadableStream<Uint8Array>,
        declaredBytes: held.sizeBytes,
        maxBytes: held.sizeBytes,
        maxPages: PDF_STORED_MAX_PAGES,
        documentId: held.id,
        detectDuplicates: false,
      });
      expect(uploaded.recoverable).toBe(true);
      await getDb().update(imapIngestionAttachments).set({
        status: "assigned", assignedDocumentId: held.id, purgePending: true, purgeFailureCode: null,
        transferClaimToken: null, transferClaimedAt: null, transferLeaseExpiresAt: null,
      }).where(eq(imapIngestionAttachments.id, held.id));
      const [row] = await getDb().select({ status: imapIngestionAttachments.status, documentId: imapIngestionAttachments.assignedDocumentId, purgePending: imapIngestionAttachments.purgePending })
        .from(imapIngestionAttachments).where(eq(imapIngestionAttachments.id, held.id));
      expect(row).toMatchObject({ status: "assigned", purgePending: true });
      const documentId = row!.documentId!;
      expect(documentId).toBe(held.id);

      await getDb().update(documentJobs).set({ nextAttemptAt: new Date(Date.now() - 1_000) })
        .where(and(eq(documentJobs.documentId, documentId), eq(documentJobs.kind, "scan")));
      vi.mocked(scanFileWithClamAv).mockResolvedValue({ status: "clean" });
      await runDocumentMaintenanceCycle();

      const [document] = await getDb().select({ lifecycle: documents.lifecycle, scanStatus: documents.scanStatus })
        .from(documents).where(eq(documents.id, documentId));
      expect(document).toEqual({ lifecycle: "available", scanStatus: "clean" });
      expect(await storedPageCount(documentId)).toBe(101);
      expect(await getDb().select({ id: documentCrypto.documentId }).from(documentCrypto).where(eq(documentCrypto.documentId, documentId))).toHaveLength(1);
    });
  }, 120_000);

  popplerIt(`#1801 A-F14 L4: a fresh upload of a 101-page PDF is still refused 422 document_structure_invalid and writes no row ${NEEDS_POPPLER}`, async () => {
    const fixture = await createIntegrationFixture("page-count-fresh-101");
    const before = await getDb().select({ id: documents.id }).from(documents).where(eq(documents.householdId, fixture.household.id));

    const { response } = await uploadResponse(fixture, textPagesPdf(101), "application/pdf", "hundred-and-one.pdf");

    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ error: { code: "document_structure_invalid" } });
    const after = await getDb().select({ id: documents.id }).from(documents).where(eq(documents.householdId, fixture.household.id));
    expect(after).toEqual(before);
  }, 60_000);

  popplerIt(`the create form's inspection writes no document, and the file it then uploads gets page_count 3 ${NEEDS_POPPLER}`, async () => {
    const fixture = await createIntegrationFixture("page-count-inspection");
    const member = await fixture.session("member");
    const bytes = textPagesPdf(3);
    const documentsBefore = await getDb().select({ id: documents.id }).from(documents).where(eq(documents.householdId, fixture.household.id));
    const inspection = await callRouteForSession(inspectRoute, member, {
      url: `http://127.0.0.1:3000/api/households/${fixture.household.id}/item-document-inspection`,
      method: "POST",
      headers: {
        "x-orbit-filename": encodeURIComponent("three-pages.pdf"),
        "x-orbit-declared-bytes": String(bytes.length),
        "content-type": "application/pdf",
      },
      body: new Uint8Array(bytes),
      params: { householdId: fixture.household.id },
    });
    expect(inspection.status).toBe(200);
    expect(await inspection.json()).toMatchObject({ attachmentDisposition: "attachable", reason: "supported_structure" });
    expect(await getDb().select({ id: documents.id }).from(documents).where(eq(documents.householdId, fixture.household.id))).toEqual(documentsBefore);

    const { document } = await upload(fixture, bytes, "application/pdf", "three-pages.pdf");
    expect(await storedPageCount(document.id)).toBe(3);
    expect(document.pageCount).toBe(3);
  }, 60_000);
});
