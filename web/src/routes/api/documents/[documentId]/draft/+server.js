import { json } from "@sveltejs/kit";

import { createDocumentDraft } from "orbit/server/document-drafts";

import { write } from "$lib/server/api.js";

/** Starts a review draft for a stored document (#735 port). */
export const POST = write(async (event, session) => {
  const documentId = /** @type {string} */ (event.params.documentId);
  const draft = await createDocumentDraft(session.user.id, documentId);
  return json({ draft }, { headers: { "Cache-Control": "no-store" } });
});
