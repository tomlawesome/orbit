import { json } from "@sveltejs/kit";
import { z } from "zod";

import { hardDeleteHousehold, requestHouseholdDeletion, restoreHousehold } from "orbit/server/household-lifecycle";

import { write } from "$lib/server/api.js";

const bodySchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("delete"), confirmation: z.string().min(1).max(60) }),
  z.object({ action: z.literal("restore") }),
  z.object({ action: z.literal("hard_delete"), confirmation: z.string().min(1).max(60) }),
]);

/** A household's deletion, restoration and permanent removal, all one
 * action-tagged body so the three share one confirmation flow (#735 port). */
export const POST = write(async (event, session) => {
  const householdId = /** @type {string} */ (event.params.householdId);
  const body = bodySchema.parse(await event.request.json());
  if (body.action === "delete") {
    return json(await requestHouseholdDeletion(session.user.id, householdId, body.confirmation), {
      headers: { "cache-control": "no-store" },
    });
  }
  if (body.action === "hard_delete") {
    await hardDeleteHousehold(session.user.id, householdId, body.confirmation);
    return json({ deleted: true }, { headers: { "cache-control": "no-store" } });
  }
  await restoreHousehold(session.user.id, householdId, session.id);
  return json({ restored: true }, { headers: { "cache-control": "no-store" } });
});
