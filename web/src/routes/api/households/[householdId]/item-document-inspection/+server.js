import { json } from "@sveltejs/kit";

import { AppError } from "orbit/lib/app-error";
import { inspectItemDocument } from "orbit/server/item-document-inspection";

import { write } from "$lib/server/api.js";

/**
 * Sniffs an in-progress upload's media type before it is attached to an item
 * (#735 port).
 *
 * The body streams straight through to `inspectItemDocument` — filename and
 * declared size travel as headers, not JSON, because the body itself is the
 * raw file bytes.
 */
export const POST = write(async (event, session) => {
  const householdId = /** @type {string} */ (event.params.householdId);
  const encodedFilename = event.request.headers.get("x-orbit-filename");
  if (!encodedFilename) throw new AppError("document_filename_required", "The document filename is required", 422);
  let filename;
  try {
    filename = decodeURIComponent(encodedFilename);
  } catch {
    throw new AppError("document_filename_invalid", "The document filename is invalid", 422);
  }
  const declaredHeader = event.request.headers.get("x-orbit-declared-bytes");
  const declaredBytes = declaredHeader ? Number(declaredHeader) : undefined;
  if (declaredBytes !== undefined && (!Number.isSafeInteger(declaredBytes) || declaredBytes < 0)) {
    throw new AppError("document_size_invalid", "The document size is invalid", 422);
  }
  return json(
    await inspectItemDocument({ userId: session.user.id, householdId, filename, body: event.request.body, declaredBytes }),
    { headers: { "Cache-Control": "no-store" } },
  );
});
