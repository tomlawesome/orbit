import { json } from "@sveltejs/kit";
import { z } from "zod";

import {
  addSenderAddress,
  listSenderAddresses,
  removeSenderAddress,
  seedSenderAddress,
  sendSenderVerification,
} from "orbit/server/mail-in/sender-addresses";

import { read, write } from "$lib/server/api.js";

/**
 * The addresses the signed-in member says they send from (ADR-0017 decision 3,
 * slice 4, #745).
 *
 * Like the relay endpoint beside it, THERE IS NO USER FIELD anywhere in here.
 * The session names the member; the body names an address or one of that
 * member's own rows by id, and every engine call is predicated on both. A
 * member therefore cannot list, add, remove or re-send verification for
 * anybody else's address.
 *
 * `no-store` on both: an address is personal data and a pending verification
 * state is a live fact, and neither belongs in a cache.
 */
const mutationSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("add"), address: z.string().max(640) }),
  z.object({ action: z.literal("verify"), id: z.uuid() }),
  z.object({ action: z.literal("remove"), id: z.uuid() }),
]);

export const GET = read(
  async (_event, session) => {
    /* Seeding on read is what puts the account's own address in front of the
       member without anybody having to type it. It is unverified, and stays
       unverified until a link sent to that address is opened. */
    await seedSenderAddress(session.user.id);
    const addresses = await listSenderAddresses(session.user.id);
    return json({ addresses }, { headers: { "cache-control": "no-store" } });
  },
  { fixture: () => json({ addresses: [] }, { headers: { "cache-control": "no-store" } }) },
);

export const PUT = write(async (event, session) => {
  const command = mutationSchema.parse(await event.request.json());
  const actor = session.user.id;
  if (command.action === "add") await addSenderAddress(actor, command.address);
  if (command.action === "verify") await sendSenderVerification(actor, command.id);
  if (command.action === "remove") await removeSenderAddress(actor, command.id);
  const addresses = await listSenderAddresses(actor);
  return json({ addresses }, { headers: { "cache-control": "no-store" } });
});
