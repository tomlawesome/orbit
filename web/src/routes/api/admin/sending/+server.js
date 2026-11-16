import { json } from "@sveltejs/kit";
import { z } from "zod";

import {
  readSendingSettings,
  sendingSettingsInputSchema,
  setSendingSettings,
} from "orbit/server/mail-in/sending-settings";

import { read, write } from "$lib/server/api.js";

/**
 * How Orbit sends mail: the Sending half of the Administration Mail card
 * (#1629, ADR-0017 amendment), beside `/api/admin/mailbox`.
 *
 * GET never returns the sending password: what comes back is sends as, via
 * (and the host, port and security it signs in to), whose password it is or
 * who set it and when, where the settings came from, and last sent.
 *
 * POST `set` carries the password for "another account" only, and it goes
 * straight into the engine, which signs in to the server BEFORE storing
 * anything and then encrypts it under the document key. `expectedVersion` is
 * null only for the very first setup, so two administrators on the same
 * screen cannot overwrite each other silently.
 *
 * Under fixtures this answers "not set up" rather than reaching the engine.
 */
const commandSchema = z.object({
  action: z.literal("set"),
  expectedVersion: z.number().int().positive().nullable(),
}).passthrough();

const noStore = { headers: { "cache-control": "no-store" } };

export const GET = read(
  async (_event, session) => {
    const sending = await readSendingSettings(session.user.id);
    return json({ sending }, noStore);
  },
  { fixture: () => json({ sending: null }, noStore) },
);

export const POST = write(async (event, session) => {
  const { action, expectedVersion, ...rest } = commandSchema.parse(await event.request.json());
  void action;
  const input = sendingSettingsInputSchema.parse(rest);
  const result = await setSendingSettings(session.user.id, expectedVersion, input);
  return json({ sending: result.settings, outcome: result.outcome }, noStore);
});
