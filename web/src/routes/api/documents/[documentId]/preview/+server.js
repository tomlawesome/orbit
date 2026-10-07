import { readDocumentPagePreview } from "orbit/server/document-preview";
import { parseDocumentPreviewPage } from "orbit/server/documents/preview-page";

import { placeholderPageSvg, requireFixtureDocument } from "$lib/server/document-content-fixture.js";
import { placeholderResponse, previewResponse } from "$lib/server/preview-response.js";
import { read } from "$lib/server/api.js";

/**
 * A picture of one page of a stored document, for visual identification
 * (#476). `?page=N` asks for page N (#1300; page one when absent); the
 * answer's `X-Orbit-Page-Count` header says how many there are. A malformed
 * or out-of-cap page is a 400 before the document is read; a page past the
 * end is a 404 once every existing check has passed.
 *
 * The response carries the download endpoint's headers: private and
 * non-cacheable, sniff-proof, and served under a null CSP, because the bytes
 * are derived from private document content even though they are only an
 * image. Unsupported or unrenderable documents answer with a bounded code a
 * screen can word rather than a 500.
 *
 * The item screen's reading card (#1088, belt.js's `previewHref`) is what
 * actually calls this now.
 */
export const GET = read(
  async (event, session) => {
    const documentId = /** @type {string} */ (event.params.documentId);
    const page = parseDocumentPreviewPage(event.url.searchParams);
    const preview = await readDocumentPagePreview(session.user.id, documentId, page);
    return previewResponse(preview);
  },
  {
    /* #1141: with no engine behind ORBIT_FIXTURES=1, this answered every
       request with a 500 — the item page's reading card then said Orbit
       could not draw a picture at all, whatever the document. A generated
       placeholder page keeps the same headers the real route carries. */
    fixture: (event) => {
      const page = parseDocumentPreviewPage(event.url.searchParams);
      const doc = requireFixtureDocument(/** @type {string} */ (event.params.documentId));
      return placeholderResponse(placeholderPageSvg(doc.displayName), page);
    },
  },
);
