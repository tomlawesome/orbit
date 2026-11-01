import { openDocumentDownload } from "orbit/server/document-repository";

import { placeholderDownloadBytes, requireFixtureDocument } from "$lib/server/document-content-fixture.js";
import { read } from "$lib/server/api.js";

/** @param {string} filename */
function contentDisposition(filename) {
  const fallback = filename.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_") || "document";
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

/**
 * Streams a document's decrypted bytes to an authorized reader (#735 port):
 * verified in one pass, decrypted into the response in the next; never held
 * whole (#1571).
 *
 * Returns a bare `Response`, not `json()` — the body is the file — carrying
 * every header the Next route set, especially the sandboxed CSP and
 * `no-store`: this is the one route serving a caller-controlled filename and
 * fixed content type as a direct download.
 */
export const GET = read(
  async (event, session) => {
    const documentId = /** @type {string} */ (event.params.documentId);
    const download = await openDocumentDownload(session.user.id, documentId);
    return new Response(download.body, {
      status: 200,
      headers: {
        "Cache-Control": "private, no-store",
        "Content-Disposition": contentDisposition(download.displayName),
        "Content-Length": String(download.sizeBytes),
        "Content-Security-Policy": "default-src 'none'; sandbox",
        "Content-Type": "application/octet-stream",
        "X-Content-Type-Options": "nosniff",
      },
    });
  },
  {
    /* #1141: same fixture gap as the preview route beside it — a small
       generated sample file rather than a reach into the (absent) engine. */
    fixture: (event) => {
      const doc = requireFixtureDocument(/** @type {string} */ (event.params.documentId));
      const body = Uint8Array.from(placeholderDownloadBytes(doc));
      return new Response(body, {
        status: 200,
        headers: {
          "Cache-Control": "private, no-store",
          "Content-Disposition": contentDisposition(doc.displayName),
          "Content-Length": String(body.length),
          "Content-Security-Policy": "default-src 'none'; sandbox",
          "Content-Type": "application/octet-stream",
          "X-Content-Type-Options": "nosniff",
        },
      });
    },
  },
);
