import { json } from "@sveltejs/kit";

import { requestDocumentDeletion } from "orbit/server/document-repository";

import { write } from "$lib/server/api.js";

/**
 * Soft-deletes a document; `restore` (#735 port) can undo it. `?staged=1` is
 * the Add form letting go of its own staged pick (#1437): only an upload no
 * item binds goes, at the next purge, with no restore.
 */
export const DELETE = write(async (event, session) => {
  const documentId = /** @type {string} */ (event.params.documentId);
  const stagedDiscard = new URL(event.request.url).searchParams.get("staged") === "1";
  const document = stagedDiscard
    ? await requestDocumentDeletion(session.user.id, documentId, { stagedDiscard: true })
    : await requestDocumentDeletion(session.user.id, documentId);
  return json({ document }, { headers: { "Cache-Control": "no-store" } });
});
