import { json } from "@sveltejs/kit";

import { requireInstanceAdministrator } from "orbit/server/authorization";
import { getKekRotationStatus } from "orbit/server/documents/rotation-status";

import { read } from "$lib/server/api.js";

/**
 * Whether a document-KEK rotation is open, since when, and whether this
 * process is holding the second key (#956) — for the administration screen's
 * rotation card. Bounded like the sibling documents/health route: states and
 * a timestamp, never key ids or key material.
 */
export const GET = read(async (_event, session) => {
  await requireInstanceAdministrator(session.user.id);
  return json(
    { rotation: await getKekRotationStatus() },
    { headers: { "cache-control": "no-store" } },
  );
});
