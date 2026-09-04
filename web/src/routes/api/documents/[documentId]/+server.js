import { json } from "@sveltejs/kit";

import { requestDocumentDeletion } from "orbit/server/document-repository";

import { write } from "$lib/server/api.js";

/** Soft-deletes a document; `restore` (#735 port) can undo it. */
export const DELETE = write(async (event, session) => {
  const documentId = /** @type {string} */ (event.params.documentId);
  const document = await requestDocumentDeletion(session.user.id, documentId);
  return json({ document }, { headers: { "Cache-Control": "no-store" } });
});
