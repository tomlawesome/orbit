import { json } from "@sveltejs/kit";

import { getAdministratorOperations } from "orbit/server/admin-operations";

import { read } from "$lib/server/api.js";

/**
 * The operations dashboard snapshot: worker health, provider status, the
 * delivery/document-job queues and a page of the audit log (#735 port).
 *
 * `auditCursor` paginates the audit log only; the rest of the snapshot is
 * always the current state, so there is nothing else to cursor.
 */
export const GET = read(async (event, session) => {
  const operations = await getAdministratorOperations(
    session.user.id,
    event.url.searchParams.get("auditCursor") ?? undefined,
  );
  return json({ operations }, { headers: { "cache-control": "no-store" } });
});
