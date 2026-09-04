import { json } from "@sveltejs/kit";

import { requireInstanceAdministrator } from "orbit/server/authorization";
import { getDocumentHealth, toPublicDocumentHealth } from "orbit/server/document-health";

import { read } from "$lib/server/api.js";

/**
 * Document-processing health, for the admin operations screen (#735 port).
 *
 * `read()` already covers the maintenance guard and the session; the
 * administrator check runs inside the handler in the same place the Next
 * route put it — after the session, before the health data is touched.
 */
export const GET = read(async (_event, session) => {
  await requireInstanceAdministrator(session.user.id);
  return json(
    { health: toPublicDocumentHealth(await getDocumentHealth()) },
    { headers: { "cache-control": "no-store" } },
  );
});
