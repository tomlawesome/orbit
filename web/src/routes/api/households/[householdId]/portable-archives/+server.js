import { json } from "@sveltejs/kit";
import { z } from "zod";

import { createPortableArchive } from "orbit/server/portable-archive-repository";

import { write } from "$lib/server/api.js";

const requestSchema = z.object({
  passphrase: z.string().min(12).max(256),
  includeDocuments: z.boolean().default(false),
});

/**
 * Encrypts the household into a portable archive for the caller to download
 * (#735 port).
 *
 * The response embeds the download URL rather than the bytes: the archive is
 * already written to storage, and a second GET (below) is what streams it.
 */
export const POST = write(async (event, session) => {
  const householdId = /** @type {string} */ (event.params.householdId);
  const input = requestSchema.parse(await event.request.json());
  const archive = await createPortableArchive({ userId: session.user.id, householdId, ...input });
  return json(
    { archive: { ...archive, downloadUrl: `/api/portable-archives/${archive.id}/download` } },
    { headers: { "Cache-Control": "no-store" } },
  );
});
