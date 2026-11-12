import { json } from "@sveltejs/kit";

import { relaySendersOf } from "orbit/server/mail-in/relay-settings";
import { addSenderAddress } from "orbit/server/mail-in/sender-addresses";

import { write } from "$lib/server/api.js";

/**
 * Adds a further sending address to the signed-in member's own list (#1650,
 * ADR-0017 amendment). Body `{ address }`; any other field, a user id
 * included, is ignored: the session names the member. No check mail is sent
 * by the add; the member sends one per row.
 *
 * 201 with the list when a row was added; 200 with it, unchanged, for an
 * address already on the list. A body that is not JSON, or has no address,
 * is refused as an address Orbit cannot use. `no-store`: addresses are
 * personal data.
 */
export const POST = write(async (event, session) => {
  /** @type {unknown} */
  let address;
  try {
    const body = JSON.parse(await event.request.text());
    address = body && typeof body === "object" ? /** @type {{ address?: unknown }} */ (body).address : undefined;
  } catch {
    address = undefined;
  }
  const { added, senders } = await addSenderAddress(session.user.id, address);
  return json({ senders: relaySendersOf(senders) }, { status: added ? 201 : 200, headers: { "cache-control": "no-store" } });
});
