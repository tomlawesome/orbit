import { json } from "@sveltejs/kit";
import { z } from "zod";

import { importPortableArchive } from "orbit/server/portable-archive-repository";

import { write } from "$lib/server/api.js";

const bodySchema = z.object({
  householdId: z.uuid(),
  archive: z.unknown(),
  passphrase: z.string().min(12).max(256),
  conflictItemIds: z.array(z.uuid()).max(10_000),
});

/**
 * Decrypts a portable archive and merges it into a household, with the
 * caller's conflict resolutions already decided by the preview step (#735
 * port).
 *
 * The archive travels as a JSON body, not a multipart upload — the caller
 * already decrypted it client-side into the shape `archive: unknown` expects.
 */
export const POST = write(async (event, session) => {
  const body = bodySchema.parse(await event.request.json());
  return json(await importPortableArchive({ userId: session.user.id, ...body }), {
    headers: { "Cache-Control": "no-store" },
  });
});
