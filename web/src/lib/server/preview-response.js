import { DOCUMENT_PREVIEW_PAGE_COUNT_HEADER, documentPreviewPageNotFound } from "orbit/server/documents/preview-page";

/**
 * The page preview response, shared by every route that answers one
 * (#1155): the accepted-document route
 * (`/api/documents/[documentId]/preview`) and the staged-attachment route
 * (`/api/imap-inbox/[receiptId]/attachments/[attachmentId]/preview`). Kept in
 * one place so the two routes' headers can never drift apart.
 *
 * `X-Orbit-Page-Count` (#1300) is the document's page count, pdf.js's own
 * `numPages` read after the structure check (1 for an image), so the reader
 * can say "page N of M" and turn pages without Orbit storing a count.
 *
 * Private and non-cacheable, sniff-proof, and served under a null CSP,
 * because the bytes are derived from private document content even though
 * they are only an image.
 */

/**
 * @param {{ bytes: Buffer, mediaType: string, pageCount: number }} preview
 * @returns {Response}
 */
export function previewResponse(preview) {
  const responseBody = Uint8Array.from(preview.bytes);
  preview.bytes.fill(0);
  return new Response(responseBody, {
    status: 200,
    headers: {
      "Cache-Control": "private, no-store",
      "Content-Disposition": "inline",
      "Content-Length": String(responseBody.length),
      "Content-Security-Policy": "default-src 'none'; sandbox",
      "Content-Type": preview.mediaType,
      "X-Content-Type-Options": "nosniff",
      [DOCUMENT_PREVIEW_PAGE_COUNT_HEADER]: String(preview.pageCount),
    },
  });
}

/**
 * The fixture harness's placeholder page, under the same headers as a real
 * preview (#1141: a route that answered differently under fixtures once made
 * every staged paper look broken rather than merely faked). A placeholder is
 * one page, so any page past the first is the real routes' own 404 (#1300).
 * @param {string} svgString
 * @param {number} [page]
 * @returns {Response}
 */
export function placeholderResponse(svgString, page = 1) {
  if (page !== 1) throw documentPreviewPageNotFound();
  return new Response(svgString, {
    status: 200,
    headers: {
      "Cache-Control": "private, no-store",
      "Content-Disposition": "inline",
      "Content-Length": String(Buffer.byteLength(svgString)),
      "Content-Security-Policy": "default-src 'none'; sandbox",
      "Content-Type": "image/svg+xml",
      "X-Content-Type-Options": "nosniff",
      [DOCUMENT_PREVIEW_PAGE_COUNT_HEADER]: "1",
    },
  });
}
