import { json } from "@sveltejs/kit";
import { z } from "zod";

import { approveDocumentDraft } from "orbit/server/document-drafts";

import { write } from "$lib/server/api.js";

const reviewedValue = (/** @type {number} */ maximum) =>
  z.union([z.string().trim().min(1).max(maximum), z.null()]);

const bodySchema = z
  .object({
    sectionId: z.uuid(),
    title: z.string().trim().min(1).max(100),
    provider: reviewedValue(100),
    reference: reviewedValue(80),
    mode: z.enum(["create", "merge", "attach"]).default("create"),
    targetItemId: z.uuid().optional(),
  })
  .strict();

/** Turns a reviewed document draft into (or onto) an item (#735 port). */
export const POST = write(async (event, session) => {
  const draftId = /** @type {string} */ (event.params.draftId);
  const body = bodySchema.parse(await event.request.json());
  const result = await approveDocumentDraft(
    session.user.id,
    draftId,
    body.sectionId,
    { title: body.title, provider: body.provider, reference: body.reference },
    body.mode,
    body.targetItemId,
  );
  return json(result, { headers: { "Cache-Control": "no-store" } });
});
