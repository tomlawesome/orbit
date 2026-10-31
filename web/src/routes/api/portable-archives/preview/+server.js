import { json } from "@sveltejs/kit";
import { z } from "zod";

import { previewPortableImport, requirePortableArchiveAccess } from "orbit/server/portable-archive-repository";
import { ARCHIVE_PASSPHRASE_MAX, ARCHIVE_PASSPHRASE_MIN } from "orbit/server/portable-archive-limits";

import { write } from "$lib/server/api.js";
import { readArchiveUpload } from "$lib/server/archive-upload.js";

const fieldsSchema = z.object({
  householdId: z.uuid(),
  passphrase: z.string().min(ARCHIVE_PASSPHRASE_MIN).max(ARCHIVE_PASSPHRASE_MAX),
});

/**
 * Decrypts a portable archive just far enough to show the caller what an
 * import would do, without writing anything (#735 port).
 *
 * The archive file arrives as the last part of a multipart upload, after
 * `householdId` and `passphrase` (#1566, $lib/server/archive-upload.js), and
 * is read in pieces as it arrives.
 *
 * Deliberately not re-challenged (#1132). It answers from the uploaded file;
 * the only thing it says about the household is which of the file's entries
 * are already there, and a member can read those entries anyway. The import
 * that follows is what asks the person to prove it is them.
 *
 * Only an owner may bring an archive in (#1316), so anyone else is refused
 * here, before a byte of the archive file is read.
 */
export const POST = write(async (event, session) => readArchiveUpload(event.request, async (fields, archiveFile) => {
  const body = fieldsSchema.parse(fields);
  await requirePortableArchiveAccess(session.user.id, body.householdId, "import");
  return json(
    { preview: await previewPortableImport(session.user.id, body.householdId, await archiveFile(), body.passphrase) },
    { headers: { "Cache-Control": "no-store" } },
  );
}));
