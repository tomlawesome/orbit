import { json } from "@sveltejs/kit";
import { z } from "zod";

import {
  mailLimitBytesFromMegabytes,
  readMailLimitSettings,
  setMailLimit,
  MAIL_LIMIT_MAX_MEGABYTES,
  MAIL_LIMIT_MIN_MEGABYTES,
} from "orbit/server/mail-limit";

import { read, write } from "$lib/server/api.js";

/**
 * The mail size limit (#1388, design note 54592): a stored override, falling
 * back to the 25 MB default, set apart from the upload limit. A copy of
 * `/api/admin/upload-limit`.
 *
 * GET answers the administrator's own view: the limit in force, the default,
 * the override (or `null`), the bounds, and the version their next write must
 * carry. Only an instance administrator gets an answer.
 *
 * POST carries `expectedVersion` on every mutation; `default` is its own
 * action, so going back to the default is never ambiguous.
 */
const mutationSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("set"),
    expectedVersion: z.number().int().positive(),
    megabytes: z.number().int().min(MAIL_LIMIT_MIN_MEGABYTES).max(MAIL_LIMIT_MAX_MEGABYTES),
  }),
  z.object({
    action: z.literal("default"),
    expectedVersion: z.number().int().positive(),
  }),
]);

const MIB = 1_048_576;

/* Under fixtures this answers "the default, never changed", as the upload
   limit route does. */
const defaultLimit = () =>
  json(
    {
      mailLimit: {
        maxBytes: 25 * MIB,
        defaultBytes: 25 * MIB,
        overrideBytes: null,
        minBytes: MAIL_LIMIT_MIN_MEGABYTES * MIB,
        ceilingBytes: MAIL_LIMIT_MAX_MEGABYTES * MIB,
        version: 1,
        updatedAt: null,
      },
    },
    { headers: { "cache-control": "no-store" } },
  );

export const GET = read(
  async (_event, session) => {
    const mailLimit = await readMailLimitSettings(session.user.id);
    return json({ mailLimit }, { headers: { "cache-control": "no-store" } });
  },
  { fixture: defaultLimit },
);

export const POST = write(async (event, session) => {
  const command = mutationSchema.parse(await event.request.json());
  const mailLimit = await setMailLimit(
    session.user.id,
    command.expectedVersion,
    command.action === "set" ? mailLimitBytesFromMegabytes(command.megabytes) : null,
  );
  return json({ mailLimit }, { headers: { "cache-control": "no-store" } });
});
