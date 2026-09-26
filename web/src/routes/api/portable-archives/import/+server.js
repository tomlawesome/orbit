import { json } from "@sveltejs/kit";
import { z } from "zod";

import { requireRecentAuthentication } from "orbit/lib/auth/recent-auth";
import { importPortableArchive, requirePortableArchiveAccess } from "orbit/server/portable-archive-repository";

import { write } from "$lib/server/api.js";

const bodySchema = z.object({
  householdId: z.uuid(),
  archive: z.unknown(),
  passphrase: z.string().min(12).max(256),
  conflictItemIds: z.array(z.uuid()).max(10_000),
  /** The recent-authentication password, as the export route takes it. */
  currentPassword: z.string().optional(),
});

/**
 * Decrypts a portable archive and merges it into a household, with the
 * caller's conflict resolutions already decided by the preview step (#735
 * port).
 *
 * The archive travels as a JSON body, not a multipart upload — the caller
 * already decrypted it client-side into the shape `archive: unknown` expects.
 *
 * Bringing an archive in writes into the household, so it re-challenges the
 * person in front of the screen every time (#1132, ADR-0023 §5), after the
 * membership check so an outsider is told only that the household is not
 * available.
 */
export const POST = write(async (event, session) => {
  const { currentPassword, ...body } = bodySchema.parse(await event.request.json());
  await requirePortableArchiveAccess(session.user.id, body.householdId, "import");
  await requireRecentAuthentication(event, session, { currentPassword }, "archive_import");
  return json(await importPortableArchive({ userId: session.user.id, ...body }), {
    headers: { "Cache-Control": "no-store" },
  });
});
