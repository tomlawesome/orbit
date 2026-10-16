import { json } from "@sveltejs/kit";
import { z } from "zod";

import { requireRecentAuthentication } from "orbit/lib/auth/recent-auth";
import { createPortableArchive, requirePortableArchiveAccess } from "orbit/server/portable-archive-repository";
import { ARCHIVE_PASSPHRASE_MAX, ARCHIVE_PASSPHRASE_MIN } from "orbit/server/portable-archive-limits";

import { write } from "$lib/server/api.js";

const requestSchema = z.object({
  passphrase: z.string().min(ARCHIVE_PASSPHRASE_MIN).max(ARCHIVE_PASSPHRASE_MAX),
  includeDocuments: z.boolean().default(false),
  /**
   * The caller's own current password (ADR-0023 §5), when they have one;
   * absent for someone who signs in only through a provider, who is
   * challenged with a step-up proof cookie instead.
   */
  currentPassword: z.string().optional(),
});

/**
 * Encrypts the household into a portable archive for the caller to download
 * (#735 port).
 *
 * The response embeds the download URL rather than the bytes: the archive is
 * already written to storage, and a second GET (below) is what streams it.
 *
 * The archive is the whole household, decrypted, so writing one re-challenges
 * the person in front of the screen every time (#1132, ADR-0023 §5). Who may
 * export is answered first, so someone who is not the owner is told that
 * rather than being asked to prove who they are.
 */
export const POST = write(async (event, session) => {
  const householdId = /** @type {string} */ (event.params.householdId);
  const { currentPassword, ...input } = requestSchema.parse(await event.request.json());
  await requirePortableArchiveAccess(session.user.id, householdId, "export");
  await requireRecentAuthentication(event, session, { currentPassword }, "archive_export");
  const archive = await createPortableArchive({ userId: session.user.id, householdId, ...input });
  return json(
    { archive: { ...archive, downloadUrl: `/api/portable-archives/${archive.id}/download` } },
    { headers: { "Cache-Control": "no-store" } },
  );
});
