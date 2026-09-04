import { json } from "@sveltejs/kit";

import { restoreDocument } from "orbit/server/document-repository";

import { write } from "$lib/server/api.js";

/** Undoes a soft delete requested via `requestDocumentDeletion` (#735 port). */
export const POST = write(async (event, session) => {
  const documentId = /** @type {string} */ (event.params.documentId);
  const document = await restoreDocument(session.user.id, documentId);
  return json({ document }, { headers: { "Cache-Control": "no-store" } });
});
