import { json } from "@sveltejs/kit";
import { z } from "zod";

import { previewPortableImport } from "orbit/server/portable-archive-repository";

import { write } from "$lib/server/api.js";

const bodySchema = z.object({
  householdId: z.uuid(),
  archive: z.unknown(),
  passphrase: z.string().min(12).max(256),
});

/**
 * Decrypts a portable archive just far enough to show the caller what an
 * import would do, without writing anything (#735 port).
 */
export const POST = write(async (event, session) => {
  const body = bodySchema.parse(await event.request.json());
  return json(
    { preview: await previewPortableImport(session.user.id, body.householdId, body.archive, body.passphrase) },
    { headers: { "Cache-Control": "no-store" } },
  );
});
