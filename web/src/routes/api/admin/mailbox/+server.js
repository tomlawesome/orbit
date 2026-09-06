import { json } from "@sveltejs/kit";
import { z } from "zod";

import {
  mailboxSettingsInputSchema,
  readMailboxSettings,
  removeMailboxCredential,
  rotateMailboxPassword,
  runMailboxSetupProbe,
  setMailboxIngestEnabled,
  setMailboxSettings,
  verifyMailboxCredential,
} from "orbit/server/mail-in/mailbox-settings";

import { read, write } from "$lib/server/api.js";

/**
 * The instance administrator's mailbox settings (ADR-0017 slice 2, #743).
 *
 * GET never returns the mailbox password or the alias key: there is no read
 * path for either, here or anywhere else. What comes back is the non-secret
 * provider configuration, the verification state, who set the credential and
 * when, the alias PATTERN (not any member's actual address), and the bounded
 * health words the operations view already publishes.
 *
 * POST carries the password on `set` and `rotate` only, and it goes straight
 * into the engine's encrypt-and-store path. `expectedVersion` accompanies
 * every mutation so two administrators on the same screen cannot overwrite
 * each other silently; it is null only for the very first setup, when there
 * is no row yet.
 *
 * Under fixtures this answers "no mailbox" rather than reaching the engine,
 * the same rule every other route follows: a route answers from the fixture
 * or from the engine, never half of each.
 */
const mutationSchema = z.discriminatedUnion("action", [
  mailboxSettingsInputSchema.extend({
    action: z.literal("set"),
    expectedVersion: z.number().int().positive().nullable(),
  }),
  z.object({
    action: z.literal("rotate"),
    expectedVersion: z.number().int().positive(),
    password: z.string(),
  }),
  z.object({ action: z.literal("verify") }),
  z.object({ action: z.literal("probe") }),
  z.object({
    action: z.literal("remove"),
    expectedVersion: z.number().int().positive(),
  }),
  z.object({
    action: z.literal("enable"),
    expectedVersion: z.number().int().positive(),
  }),
  z.object({
    action: z.literal("disable"),
    expectedVersion: z.number().int().positive(),
  }),
]);

const noMailbox = () =>
  json({ mailbox: null }, { headers: { "cache-control": "no-store" } });

export const GET = read(
  async (_event, session) => {
    const mailbox = await readMailboxSettings(session.user.id);
    return json({ mailbox }, { headers: { "cache-control": "no-store" } });
  },
  { fixture: noMailbox },
);

export const POST = write(async (event, session) => {
  const command = mutationSchema.parse(await event.request.json());
  const actor = session.user.id;
  switch (command.action) {
    case "set": {
      const { action, expectedVersion, ...input } = command;
      const result = await setMailboxSettings(actor, expectedVersion, input);
      return json(
        { mailbox: result.settings, outcome: result.outcome },
        { headers: { "cache-control": "no-store" } },
      );
    }
    case "rotate": {
      const result = await rotateMailboxPassword(actor, command.expectedVersion, command.password);
      return json(
        { mailbox: result.settings, outcome: result.outcome },
        { headers: { "cache-control": "no-store" } },
      );
    }
    case "verify": {
      const result = await verifyMailboxCredential(actor);
      return json(
        { mailbox: result.settings, outcome: result.outcome },
        { headers: { "cache-control": "no-store" } },
      );
    }
    case "probe": {
      const result = await runMailboxSetupProbe(actor);
      return json(
        { mailbox: result.settings, outcome: result.outcome },
        { headers: { "cache-control": "no-store" } },
      );
    }
    case "remove": {
      const mailbox = await removeMailboxCredential(actor, command.expectedVersion);
      return json({ mailbox }, { headers: { "cache-control": "no-store" } });
    }
    default: {
      const mailbox = await setMailboxIngestEnabled(
        actor,
        command.expectedVersion,
        command.action === "enable",
      );
      return json({ mailbox }, { headers: { "cache-control": "no-store" } });
    }
  }
});
