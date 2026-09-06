import { json } from "@sveltejs/kit";
import { z } from "zod";

import { readInstanceContactSettings, setPublicContactAddress } from "orbit/server/instance-contact";

import { read, write } from "$lib/server/api.js";

/**
 * The instance administrator's public contact address (#860).
 *
 * GET answers the administrator's own view: the address (or `null` when
 * unset), the version their next write must carry, and when it last changed.
 * There is no read path for any account's own email here — this route
 * reaches nothing but `instance_contact`.
 *
 * POST carries `expectedVersion` on every mutation, the same reason the
 * mailbox and maintenance routes do: two administrators on the same screen
 * cannot silently overwrite each other. `clear` is its own action rather than
 * `set` with an empty string, so an empty value is never ambiguous between
 * "clear it" and "a rejected address that happened to be blank".
 */
const mutationSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("set"),
    expectedVersion: z.number().int().positive(),
    address: z.string().min(1),
  }),
  z.object({
    action: z.literal("clear"),
    expectedVersion: z.number().int().positive(),
  }),
]);

export const GET = read(async (_event, session) => {
  const contact = await readInstanceContactSettings(session.user.id);
  return json({ contact }, { headers: { "cache-control": "no-store" } });
});

export const POST = write(async (event, session) => {
  const command = mutationSchema.parse(await event.request.json());
  const contact = await setPublicContactAddress(
    session.user.id,
    command.expectedVersion,
    command.action === "set" ? command.address : null,
  );
  return json({ contact }, { headers: { "cache-control": "no-store" } });
});
