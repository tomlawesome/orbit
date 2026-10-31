import { json } from "@sveltejs/kit";
import { z } from "zod";

import { requireRecentAuthentication } from "orbit/lib/auth/recent-auth";
import { importPortableArchive, requirePortableArchiveAccess } from "orbit/server/portable-archive-repository";
import { ARCHIVE_PASSPHRASE_MAX, ARCHIVE_PASSPHRASE_MIN } from "orbit/server/portable-archive-limits";

import { write } from "$lib/server/api.js";
import { jsonField, readArchiveUpload } from "$lib/server/archive-upload.js";

const fieldsSchema = z.object({
  householdId: z.uuid(),
  passphrase: z.string().min(ARCHIVE_PASSPHRASE_MIN).max(ARCHIVE_PASSPHRASE_MAX),
  conflictItemIds: z.array(z.uuid()).max(10_000),
  /** The recent-authentication password, as the export route takes it. */
  currentPassword: z.string().optional(),
});

/**
 * Decrypts a portable archive and merges it into a household, with the
 * caller's conflict resolutions already decided by the preview step (#735
 * port).
 *
 * The archive travels as a multipart upload (#1566,
 * $lib/server/archive-upload.js): `householdId`, `passphrase`,
 * `currentPassword` when given and `conflictItemIds` (one field holding a
 * JSON array) first, then the archive file as it sits on disk, last, read in
 * pieces as it arrives and never held whole.
 *
 * Bringing an archive in writes into the household, so it re-challenges the
 * person in front of the screen every time (#1132, ADR-0023 §5), after the
 * membership check so an outsider is told only that the household is not
 * available. Both checks run before a byte of the archive file is read.
 */
export const POST = write(async (event, session) => readArchiveUpload(
  event.request,
  async (fields, archiveFile) => {
    const { currentPassword, ...body } = fieldsSchema.parse({ ...fields, conflictItemIds: jsonField(fields.conflictItemIds) });
    await requirePortableArchiveAccess(session.user.id, body.householdId, "import");
    await requireRecentAuthentication(event, session, { currentPassword }, "archive_import");
    return json(await importPortableArchive({ userId: session.user.id, ...body, archive: await archiveFile() }), {
      headers: { "Cache-Control": "no-store" },
    });
  },
));
