import { json } from "@sveltejs/kit";

import { AppError } from "orbit/lib/app-error";
import {
  listSenderAddresses,
  seedSenderAddress,
  sendSenderVerification,
} from "orbit/server/mail-in/sender-addresses";

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
 * Seeding first puts the row in place when it is missing and makes it follow
 * the registered address when that has changed, which starts verification
 * over. Once the address is checked there is nothing to send: 409.
 *
 * Answers 202, since the mail is on its way and not yet read, with where it
 * went and when the link lapses. `no-store`: an address is personal data.
 */
export const POST = write(async (_event, session) => {
  const actor = session.user.id;
  await seedSenderAddress(actor);
  const [row] = await listSenderAddresses(actor);
  if (!row) {
    throw new AppError("sender_address_unavailable", "Orbit has no address to check for this account", 409);
  }
  if (row.verified) {
    throw new AppError("sender_already_verified", "That address is already checked", 409);
  }
  const { address, expiresAt } = await sendSenderVerification(actor, row.id);
  return json({ address, expiresAt: expiresAt.toISOString() }, { status: 202, headers: { "cache-control": "no-store" } });
});
