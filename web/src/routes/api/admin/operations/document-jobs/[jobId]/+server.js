import { json } from "@sveltejs/kit";
import { z } from "zod";

import { updateDocumentJob } from "orbit/server/admin-operations";

import { write } from "$lib/server/api.js";

const actionSchema = z.object({
  action: z.enum(["retry", "discard"]),
  expectedStatus: z.enum(["pending", "processing", "retry", "completed", "failed", "cancelled"]),
});

/**
 * Retries or discards one document processing job, guarded by the status the
 * caller last saw (#735 port). Same compare-and-swap as the delivery sibling
 * route: `expectedStatus` must still match or the engine answers 409.
 */
export const POST = write(async (event, session) => {
  const jobId = /** @type {string} */ (event.params.jobId);
  const input = actionSchema.parse(await event.request.json());
  await updateDocumentJob(session.user.id, jobId, input.action, input.expectedStatus);
  return json({ ok: true }, { headers: { "cache-control": "no-store" } });
});
