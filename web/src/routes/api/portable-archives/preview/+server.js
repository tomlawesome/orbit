import { json } from "@sveltejs/kit";
import { z } from "zod";

import { previewPortableImport } from "orbit/server/portable-archive-repository";
import { ARCHIVE_PASSPHRASE_MAX, ARCHIVE_PASSPHRASE_MIN } from "orbit/server/portable-archive-limits";

import { write } from "$lib/server/api.js";

const bodySchema = z.object({
  householdId: z.uuid(),
  archive: z.unknown(),
  passphrase: z.string().min(ARCHIVE_PASSPHRASE_MIN).max(ARCHIVE_PASSPHRASE_MAX),
});

/**
 * Decrypts a portable archive just far enough to show the caller what an
 * import would do, without writing anything (#735 port).
 *
 * Deliberately not re-challenged (#1132). It answers from the uploaded file;
 * the only thing it says about the household is which of the file's entries
 * are already there, and a member can read those entries anyway. The import
 * that follows is what asks the person to prove it is them.
 */
export const POST = write(async (event, session) => {
  const body = bodySchema.parse(await event.request.json());
  return json(
    { preview: await previewPortableImport(session.user.id, body.householdId, body.archive, body.passphrase) },
    { headers: { "Cache-Control": "no-store" } },
  );
});
