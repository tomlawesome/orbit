import { json } from "@sveltejs/kit";
import { z } from "zod";

import { requireRecentAuthentication } from "orbit/lib/auth/recent-auth";
import { notifyExportWorker } from "orbit/server/document-maintenance/export-jobs";
import {
  enqueuePortableArchiveExport,
  readPortableArchiveExportState,
  requirePortableArchiveAccess,
} from "orbit/server/portable-archive-repository";
import { ARCHIVE_PASSPHRASE_MAX, ARCHIVE_PASSPHRASE_MIN } from "orbit/server/portable-archive-limits";

import { read, write } from "$lib/server/api.js";

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
 * Starts writing the household out as a portable archive (#735 port; a
 * background job since #1774, ADR-0047). Answers 202 at once with the job;
 * the document worker writes the file, and the card follows it with the GET
 * below. A household already being exported is 409 archive_export_in_progress.
 *
 * The archive is the whole household, decrypted, so starting one re-challenges
 * the person in front of the screen every time (#1132, ADR-0023 §5). Who may
 * export is answered first, so someone who is not the owner is told that
 * rather than being asked to prove who they are. The passphrase is turned
 * into the export key here and goes no further; the archive slot is the
 * job's to take, not this request's.
 */
export const POST = write(async (event, session) => {
  const householdId = /** @type {string} */ (event.params.householdId);
  const { currentPassword, ...input } = requestSchema.parse(await event.request.json());
  await requirePortableArchiveAccess(session.user.id, householdId, "export");
  await requireRecentAuthentication(event, session, { currentPassword }, "archive_export");
  const started = await enqueuePortableArchiveExport({ userId: session.user.id, householdId, ...input });
  notifyExportWorker();
  return json({ export: started }, { status: 202, headers: { "Cache-Control": "no-store" } });
});

/**
 * The archive card's read (#1774): the household's export job of the last
 * day, if any, and its newest live archive with the address to download it.
 * The owner's, as the export is.
 */
export const GET = read(async (event, session) => {
  const householdId = /** @type {string} */ (event.params.householdId);
  const state = await readPortableArchiveExportState(session.user.id, householdId);
  return json(state, { headers: { "Cache-Control": "no-store" } });
});
