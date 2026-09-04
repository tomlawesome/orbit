import { readDocumentPagePreview } from "orbit/server/document-preview";

import { read } from "$lib/server/api.js";

/**
 * A page-one picture of a stored document, for visual identification (#476).
 *
 * The response carries the download endpoint's headers: private and
 * non-cacheable, sniff-proof, and served under a null CSP, because the bytes
 * are derived from private document content even though they are only an
 * image. Unsupported or unrenderable documents answer with a bounded code a
 * screen can word rather than a 500.
 *
 * The item screen deliberately does not call this yet (#476, #735 port) —
 * this route existing is not the same as the UI drawing it.
 */
export const GET = read(async (event, session) => {
  const documentId = /** @type {string} */ (event.params.documentId);
  const preview = await readDocumentPagePreview(session.user.id, documentId);
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
    },
  });
});
