import { AppError } from "orbit/lib/app-error";
import { previewItemDocument } from "orbit/server/item-document-preview";

import { placeholderPageSvg } from "$lib/server/document-content-fixture.js";
import { placeholderResponse, previewResponse } from "$lib/server/preview-response.js";
import { write } from "$lib/server/api.js";

/**
 * Page one of a file the create form has just been given, before it belongs
 * to any item (#1245; the render is #476's).
 *
 * The body streams straight through to `previewItemDocument`, exactly as
 * the sibling inspection route streams to `inspectItemDocument` — filename
 * and declared size travel as headers because the body is the raw file.
 * Nothing is kept: the form uploads the file again onto the item it saves.
 *
 * The answer carries the same private, no-store, sniff-proof, null-CSP
 * headers every page-one preview carries, plus `X-Orbit-Scan`: "clean" where
 * ClamAV passed the file, "skipped" where the instance has scanning off, so
 * the lane says "scanned clean" only when something scanned it.
 */
export const POST = write(
  async (event, session) => {
    const householdId = /** @type {string} */ (event.params.householdId);
    const encodedFilename = event.request.headers.get("x-orbit-filename");
    if (!encodedFilename) throw new AppError("document_filename_required", "The document filename is required", 422);
    try {
      decodeURIComponent(encodedFilename);
    } catch {
      throw new AppError("document_filename_invalid", "The document filename is invalid", 422);
    }
    const declaredHeader = event.request.headers.get("x-orbit-declared-bytes");
    const declaredBytes = declaredHeader ? Number(declaredHeader) : undefined;
    if (declaredBytes !== undefined && (!Number.isSafeInteger(declaredBytes) || declaredBytes < 0)) {
      throw new AppError("document_size_invalid", "The document size is invalid", 422);
    }
    const preview = await previewItemDocument({ userId: session.user.id, householdId, body: event.request.body, declaredBytes });
    const response = previewResponse(preview);
    response.headers.set("X-Orbit-Scan", preview.scanned ? "clean" : "skipped");
    return response;
  },
  {
    /* No engine behind ORBIT_FIXTURES=1 (#1141's rule for the sibling
       preview routes): a placeholder page under the same headers, so the
       fixture harness's lane lands a sheet rather than a 500. */
    fixture: (event) => {
      let name = "document";
      try {
        name = decodeURIComponent(event.request.headers.get("x-orbit-filename") ?? "document");
      } catch {
        /* an undecodable name is still a page */
      }
      const response = placeholderResponse(placeholderPageSvg(name));
      response.headers.set("X-Orbit-Scan", "skipped");
      return response;
    },
  },
);
