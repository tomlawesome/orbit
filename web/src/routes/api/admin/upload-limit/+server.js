import { json } from "@sveltejs/kit";
import { z } from "zod";

import {
  readUploadLimitSettings,
  setUploadLimit,
  uploadLimitBytesFromMegabytes,
  UPLOAD_LIMIT_MAX_MEGABYTES,
  UPLOAD_LIMIT_MIN_MEGABYTES,
} from "orbit/server/upload-limit";

import { read, write } from "$lib/server/api.js";

/**
 * The document upload size limit (#1285): a stored override, falling back to
 * the configured default (`DOCUMENT_MAX_BYTES`).
 *
 * GET answers the administrator's own view: the limit in force, the
 * configured default, the override (or `null`), the hard bounds, and the
 * version their next write must carry. Only an instance administrator gets
 * an answer; the engine refuses everyone else, whatever the screen shows.
 *
 * POST carries `expectedVersion` on every mutation, as the contact and
 * mailbox routes do, so two administrators on the same screen cannot
 * silently overwrite each other. `default` is its own action rather than
 * `set` with an empty value, so going back to the configured default is
 * never ambiguous.
 */
const mutationSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("set"),
    expectedVersion: z.number().int().positive(),
    megabytes: z.number().int().min(UPLOAD_LIMIT_MIN_MEGABYTES).max(UPLOAD_LIMIT_MAX_MEGABYTES),
  }),
  z.object({
    action: z.literal("default"),
    expectedVersion: z.number().int().positive(),
  }),
]);

const MIB = 1_048_576;

/*
 * Under fixtures this answers "the default, never changed" rather than
 * reaching the engine, the rule every other route follows: a route answers
 * from the fixture or from the engine, never half of each.
 */
const defaultLimit = () =>
  json(
    {
      uploadLimit: {
        maxBytes: 50 * MIB,
        defaultBytes: 50 * MIB,
        overrideBytes: null,
        minBytes: UPLOAD_LIMIT_MIN_MEGABYTES * MIB,
        ceilingBytes: UPLOAD_LIMIT_MAX_MEGABYTES * MIB,
        version: 1,
        updatedAt: null,
      },
    },
    { headers: { "cache-control": "no-store" } },
  );

export const GET = read(
  async (_event, session) => {
    const uploadLimit = await readUploadLimitSettings(session.user.id);
    return json({ uploadLimit }, { headers: { "cache-control": "no-store" } });
  },
  { fixture: defaultLimit },
);

export const POST = write(async (event, session) => {
  const command = mutationSchema.parse(await event.request.json());
  const uploadLimit = await setUploadLimit(
    session.user.id,
    command.expectedVersion,
    command.action === "set" ? uploadLimitBytesFromMegabytes(command.megabytes) : null,
  );
  return json({ uploadLimit }, { headers: { "cache-control": "no-store" } });
});
