import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/db";
import { documents, imapIngestionAttachments, imapIngestionMessages } from "@/db/schema";
import { scanAndHoldImapAttachment } from "@/server/mail-in/imap-attachment-holding";
import { approveReviewedIntake } from "@/server/reviewed-intake";
import { scanFileWithClamAv } from "@/server/documents/scanner";
import { cleanupIntegrationEnvironment, createIntegrationFixture } from "./support/fixtures";
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

async function upload(fixture: Fixture, bytes: Buffer, mediaType: "application/pdf" | "image/jpeg", filename: string) {
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
