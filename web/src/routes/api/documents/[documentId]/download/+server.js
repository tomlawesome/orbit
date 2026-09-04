import { readDocumentDownload } from "orbit/server/document-repository";

import { read } from "$lib/server/api.js";

/** @param {string} filename */
function contentDisposition(filename) {
  const fallback = filename.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_") || "document";
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

/**
 * Streams a document's decrypted bytes to an authorized reader (#735 port).
 *
 * Returns a bare `Response`, not `json()` — the body is the file — carrying
 * every header the Next route set, especially the sandboxed CSP and
 * `no-store`: this is the one route serving a caller-controlled filename and
 * fixed content type as a direct download.
 */
export const GET = read(async (event, session) => {
  const documentId = /** @type {string} */ (event.params.documentId);
  const document = await readDocumentDownload(session.user.id, documentId);
  const responseBody = Uint8Array.from(document.bytes);
  document.bytes.fill(0);
  return new Response(responseBody, {
    status: 200,
    headers: {
      "Cache-Control": "private, no-store",
      "Content-Disposition": contentDisposition(document.displayName),
      "Content-Length": String(document.bytes.length),
      "Content-Security-Policy": "default-src 'none'; sandbox",
      "Content-Type": "application/octet-stream",
      "X-Content-Type-Options": "nosniff",
    },
  });
});
