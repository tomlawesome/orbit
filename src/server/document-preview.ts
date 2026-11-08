import { readDocumentDownload } from "@/server/document-repository";
import { renderDocumentPagePreview, type DocumentPagePreview } from "@/server/documents/preview";

/**
 * A picture of one page of a stored document (#476): page one unless the
 * caller asks for another (#1300), with the document's page count.
 *
 * Authorization is not re-implemented: the plaintext arrives through the same
 * `readDocumentDownload` path the download endpoint uses, so a preview can
 * never be reachable where a download is not. The plaintext is decrypted
 * straight into that one buffer, which is zeroed on every exit; the draw
 * reads it through an unlinked owner-only file in the quarantine root, so no
 * named copy outlives the request (#1436).
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
  const download = await readDocumentDownload(userId, documentId, "document_previewed");
  try {
    // The stored page count spares a pdfinfo run beside the draw (#1436).
    return await renderDocumentPagePreview(download.bytes, download.mediaType, page, {
      pool: "view",
      ...(download.pageCount == null ? {} : { pageCount: download.pageCount }),
    });
  } finally {
    download.bytes.fill(0);
  }
}
