import { json } from "@sveltejs/kit";
import { z } from "zod";

import { createJoinRequest } from "orbit/server/join-requests";

import { write } from "$lib/server/api.js";

const householdIdSchema = z.uuid();

/** §11 (#453): "Request to join X system?" — idempotent; the label the caller
 * clicked is the entire surface, and the entire response (#735 port). */
export const POST = write(async (event, session) => {
  const householdId = householdIdSchema.parse(event.params.householdId);
  const joinRequest = await createJoinRequest(session.user.id, householdId);
  return json({ request: joinRequest }, { headers: { "cache-control": "no-store" } });
});
