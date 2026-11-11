import { and, eq, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { documents } from "@/db/schema";
import { AppError } from "@/lib/app-error";
import { log } from "@/lib/logger";
import { documentReadError, recordDocumentAudit, resolveDocumentContent } from "@/server/document-repository";
import { getDocumentConfig, keyEncryptionKeyFor } from "@/server/documents/config";
import { createDocumentUnsealer, DocumentIntegrityError } from "@/server/documents/crypto";
import { type DocumentPagePreview, type DocumentPreviewMediaType, drawDocumentPage, drawRefusalError, previewBusyError, refusedPreviewError, type PreviewRefusal } from "@/server/documents/preview";
import { documentPreviewPageInvalid, documentPreviewPageNotFound } from "@/server/documents/preview-page";
import { discardKeptPreview, findPreview, type PreviewOwner, readPreview, storeDrawnPreview, storeRefusedPreview } from "@/server/documents/preview-store";
import { openDocumentStorage } from "@/server/documents/storage";

/**
 * A picture of one page of a stored document (#476): page one unless the
 * caller asks for another (#1300), with the document's page count.
 *
 * Every page is drawn once and kept, encrypted (#1433 D21). Authorization is
 * not re-implemented: `resolveDocumentContent` is the download's own gate, so
 * a preview can never be reachable where a download is not. Then:
 *
 * - a page past the stored page count is a 404 before anything is read;
 * - a kept page is decrypted from `previews/` and served, with no child;
 * - a remembered refusal answers what the drawing answered, with no child;
 * - a page past the first 100 of a document stored under the old 1,000-page
 *   cap is never drawn ahead, only here, when viewed (owner answer 10a);
 * - Orbit's own failure to draw (a full quarantine, no renderer) answers 503
 *   `document_preview_busy` with Retry-After and is never remembered;
 * - a kept page whose object is missing or fails its check is discarded and
 *   the page drawn now, as if never kept (read repair, #1803);
 * - a page not kept yet is drawn now in the `view` pool, from the document
 *   decrypted into one buffer (zeroed on every exit, read by the child
 *   through an unlinked file in the quarantine), kept, and served. Keeping
 *   it is best effort: a page that cannot be kept is still served, and the
 *   background worker draws it later.
 *
 * Every authorized read is audited once as `document_previewed`, with the
 * page, after its bytes have verified and before any drawing.
 *
 * This module is deliberately separate from `document-repository`: it is the
 * one that reaches the renderer, which loads the native canvas backend only
 * inside sandbox children (#1572), and keeping that import off the repository
 * keeps the renderer off every other route that reads documents.
 */
export async function readDocumentPagePreview(
  userId: string,
  documentId: string,
  page = 1,
): Promise<DocumentPagePreview> {
  if (!Number.isSafeInteger(page) || page < 1) throw documentPreviewPageInvalid();
  const { record, crypto, documentKek, envelope, context } = await resolveDocumentContent(userId, documentId);
  const storedCount = record.pageCount ?? undefined;
  if (storedCount !== undefined && page > storedCount) throw documentPreviewPageNotFound();
  const owner: PreviewOwner = { documentId, householdId: record.householdId, itemId: context.itemId };
  const audit = () => recordDocumentAudit(record.householdId, documentId, userId, "document_previewed", { itemId: record.itemId, page });
  const storage = openDocumentStorage();

  const kept = await findPreview(documentId, page);
  if (kept?.status === "refused") {
    await audit();
    throw refusedPreviewError(kept.refusal as PreviewRefusal);
  }
  if (kept?.status === "drawn" && storedCount !== undefined) {
    const kek = keyEncryptionKeyFor(getDocumentConfig(), kept.keyId!);
    if (!kek) throw new AppError("document_key_unavailable", "Document encryption keys require administrator attention", 503);
    let bytes: Buffer | undefined;
    try {
      bytes = await readPreview(storage, owner, kept, kek);
    } catch (error) {
      // Read repair (#1803): a missing or damaged kept page is discarded and
      // drawn now below; any other error says nothing about the bytes.
      const missing = (error as { code?: string } | null)?.code === "ENOENT";
      if (!missing && !(error instanceof DocumentIntegrityError)) throw documentReadError(error);
      await discardKeptPreview(storage, { documentId, page, storageKey: kept.storageKey! }, missing ? "storage_object_missing" : "storage_object_damaged");
      bytes = undefined;
    }
    if (bytes) {
      try {
        await audit();
      } catch (error) {
        bytes.fill(0);
        throw error;
      }
      return { bytes, mediaType: kept.mediaType as DocumentPreviewMediaType, width: kept.width!, height: kept.height!, pageCount: storedCount };
    }
  }

  let plaintext: Buffer;
  try {
    plaintext = await storage.unsealIntoBuffer(
      crypto.storageKey,
      { ciphertextSize: crypto.ciphertextSize, plaintextSize: record.sizeBytes },
      createDocumentUnsealer(context, envelope, documentKek),
    );
  } catch (error) {
    throw documentReadError(error);
  }
  try {
    await audit();
    // Without a stored count, pdfinfo reads it beside the draw, and it is kept (#1436).
    const draw = await drawDocumentPage(plaintext, record.mediaType, page, "view", { pageCount: storedCount === undefined });
    // Orbit's own side could not draw (a full quarantine, no renderer): a
    // 503 to retry, and nothing remembered about the page (D20).
    if (draw.outcome === "busy") throw previewBusyError();
    if (draw.outcome === "page_not_found") {
      if (storedCount === undefined) await fillPageCount(documentId, draw.pageCount);
      throw documentPreviewPageNotFound();
    }
    if (draw.outcome === "refused") {
      await bestEffort(() => storeRefusedPreview(documentId, page, draw.refusal));
      throw drawRefusalError(draw);
    }
    const pageCount = storedCount ?? draw.pageCount;
    if (pageCount === undefined) throw refusedPreviewError("parser");
    if (storedCount === undefined) await fillPageCount(documentId, pageCount);
    await bestEffort(() => storeDrawnPreview(storage, getDocumentConfig(), owner, page, draw));
    return { bytes: draw.bytes, mediaType: draw.mediaType, width: draw.width, height: draw.height, pageCount };
  } finally {
    plaintext.fill(0);
  }
}

/** Keeps a page count read beside an on-demand draw, for a document from before #1436. */
async function fillPageCount(documentId: string, pageCount: number): Promise<void> {
  await bestEffort(() => getDb().update(documents).set({ pageCount })
    .where(and(eq(documents.id, documentId), sql`${documents.pageCount} is null`)));
}

/** The view answers whether or not the store took the page; the worker redraws what is missing. */
async function bestEffort(work: () => Promise<unknown>): Promise<void> {
  try {
    await work();
  } catch {
    log.warn({ event: "document.preview", state: "degraded", reason: "unexpected_failure", action: "retry_job", impact: "none" });
  }
}
