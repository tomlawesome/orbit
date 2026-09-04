import { json } from "@sveltejs/kit";
import { z } from "zod";

import { decideJoinRequest } from "orbit/server/join-requests";

import { write } from "$lib/server/api.js";

const decisionSchema = z.object({ action: z.enum(["approve", "decline"]) });
const requestIdSchema = z.uuid();

/** The decision (§11, #453): owners of that household and instance admins
 * only, enforced in the transaction that reads the request (#735 port). */
export const POST = write(async (event, session) => {
  const requestId = requestIdSchema.parse(event.params.requestId);
  const { action } = decisionSchema.parse(await event.request.json());
  const decided = await decideJoinRequest(session.user.id, requestId, action);
  return json({ request: decided }, { headers: { "cache-control": "no-store" } });
});
