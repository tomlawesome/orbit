import { readDocumentPagePreview } from "orbit/server/document-preview";

import { placeholderPageSvg, requireFixtureDocument } from "$lib/server/document-content-fixture.js";
import { placeholderResponse, previewResponse } from "$lib/server/preview-response.js";
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
 * The item screen's reading card (#1088, belt.js's `previewHref`) is what
 * actually calls this now.
 */
export const GET = read(
  async (event, session) => {
    const documentId = /** @type {string} */ (event.params.documentId);
    const preview = await readDocumentPagePreview(session.user.id, documentId);
    return previewResponse(preview);
  },
  {
    /* #1141: with no engine behind ORBIT_FIXTURES=1, this answered every
       request with a 500 — the item page's reading card then said Orbit
       could not draw a picture at all, whatever the document. A generated
       placeholder page keeps the same headers the real route carries. */
    fixture: (event) => {
      const doc = requireFixtureDocument(/** @type {string} */ (event.params.documentId));
      return placeholderResponse(placeholderPageSvg(doc.displayName));
    },
  },
);
