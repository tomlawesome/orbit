import { json } from "@sveltejs/kit";

import { approveReviewedIntake } from "orbit/server/reviewed-intake";

import { write } from "$lib/server/api.js";

/**
 * Accepts a reviewed inbound document into the workspace (#735 port).
 *
 * The engine takes the session's own user id and validates the body itself,
 * so nothing here decides what may be approved — this route only proves who
 * is asking. `write` supplies the guard order the Next handler ran inline:
 * maintenance, then session, then CSRF.
 */
export const POST = write(async (event, session) => {
  const result = await approveReviewedIntake(session.user.id, await event.request.json());
  return json(result, { headers: { "cache-control": "no-store" } });
});
