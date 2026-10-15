import { json } from "@sveltejs/kit";

import { requestSenderCheck } from "orbit/server/mail-in/sender-addresses";

import { write } from "$lib/server/api.js";

/**
 * Sends the check email to the member's registered address (ADR-0017 decision
 * 3, amended by decision 7c).
 *
 * THERE IS NO BODY, and none is read. The address a member forwards from is
 * the one their account is registered with and no other, so there is nothing
 * for a body to say: the session names the member, the member's seeded row
 * names the address, and the link goes there and nowhere else. A body that
 * names another address is ignored, not refused.
 *
 * Seeding, reading and sending run as one step under the member's lock:
 * seeding puts the row in place when it is missing and makes it follow the
 * registered address when that has changed, which starts verification over.
 * Once the address is checked there is nothing to send: 409.
 *
 * Answers 202, since the mail is on its way and not yet read, with where it
 * went and when the link lapses. `no-store`: an address is personal data.
 */
export const POST = write(async (_event, session) => {
  const { address, expiresAt } = await requestSenderCheck(session.user.id);
  return json({ address, expiresAt: expiresAt.toISOString() }, { status: 202, headers: { "cache-control": "no-store" } });
});
