import { json } from "@sveltejs/kit";
import { z } from "zod";

import { requireRecentAuthentication } from "orbit/lib/auth/recent-auth";
import { notifyExportWorker } from "orbit/server/document-maintenance/export-jobs";
import { requirePortableArchiveAccess, retryPortableArchiveExport } from "orbit/server/portable-archive-repository";

import { write } from "$lib/server/api.js";

const requestSchema = z.object({
  expectedStatus: z.enum(["pending", "processing", "retry", "completed", "failed", "cancelled"]),
  /** As the start: the caller's own current password, when they have one (ADR-0023 §5). */
  currentPassword: z.string().optional(),
});

/**
 * "Try again" for a failed export (#1774): a compare-and-swap on the status
 * the card last saw, as the admin job route does (409 when it moved), with
 * the start's own re-challenge, since the result is the whole household in
 * plain. Needs the job's key still on the row: after its hour it is 409
 * archive_export_key_gone and the card offers the form instead.
 */
export const POST = write(async (event, session) => {
  const householdId = /** @type {string} */ (event.params.householdId);
  const jobId = /** @type {string} */ (event.params.jobId);
  const { currentPassword, expectedStatus } = requestSchema.parse(await event.request.json());
  await requirePortableArchiveAccess(session.user.id, householdId, "export");
  await requireRecentAuthentication(event, session, { currentPassword }, "archive_export");
  const retried = await retryPortableArchiveExport(session.user.id, householdId, jobId, expectedStatus);
  notifyExportWorker();
  return json({ export: retried }, { status: 202, headers: { "Cache-Control": "no-store" } });
});
