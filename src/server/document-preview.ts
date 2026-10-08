import { readDocumentDownload } from "@/server/document-repository";
import { renderDocumentPagePreview, type DocumentPagePreview } from "@/server/documents/preview";

/**
 * A picture of one page of a stored document (#476): page one unless the
 * caller asks for another (#1300), with the document's page count.
 *
 * Authorization is not re-implemented: the plaintext arrives through the same
 * `readDocumentDownload` path the download endpoint uses, so a preview can
 * never be reachable where a download is not. The decrypted buffer is zeroed
 * on every exit, and rendering never writes plaintext to disk, so no copy
 * outlives the request.
 *
 * This module is deliberately separate from `document-repository`: it is the
 * only server module that reaches the native canvas backend, and keeping that
 * import off the repository keeps it off every other route that reads
 * documents.
 */
export async function readDocumentPagePreview(
  userId: string,
  documentId: string,
  page = 1,
): Promise<DocumentPagePreview> {
  const download = await readDocumentDownload(userId, documentId, "document_previewed");
  try {
    return await renderDocumentPagePreview(download.bytes, download.mediaType, page);
  } finally {
    download.bytes.fill(0);
  }
}
