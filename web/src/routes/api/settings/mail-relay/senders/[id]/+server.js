import { json } from "@sveltejs/kit";

import { relaySendersOf } from "orbit/server/mail-in/relay-settings";
import { removeSenderAddress } from "orbit/server/mail-in/sender-addresses";

import { write } from "$lib/server/api.js";

/**
 * Removes one of the signed-in member's extra sending addresses (#1650). An
 * id that is not one of their rows is 404 `sender_address_unknown`, whoever's
 * it is; the seeded sign-in row is 409 `sender_address_seeded`. Answers the
 * list as it now stands.
 */
export const DELETE = write(async (event, session) => {
  const id = /** @type {string} */ (event.params.id);
  const senders = await removeSenderAddress(session.user.id, id);
  return json({ senders: relaySendersOf(senders) }, { headers: { "cache-control": "no-store" } });
});
