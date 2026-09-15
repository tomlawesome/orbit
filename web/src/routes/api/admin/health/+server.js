import { json } from "@sveltejs/kit";

import { requireInstanceAdministrator } from "orbit/server/authorization";
import { getAdministratorHealth } from "orbit/server/admin-health";

import { read } from "$lib/server/api.js";

/**
 * The real service rows and build stamp for the administration screen's
 * Operations panel (#1000), replacing the five invented "healthy" rows
 * `adminFixture.services` used to stand in for on every deployment. Bounded
 * like the sibling `documents/health` and `documents/rotation` routes:
 * `read()` covers the maintenance guard and the session, the administrator
 * check runs first inside the handler, and `getAdministratorHealth()` never
 * throws — a down sidecar is a row, not a failed request.
 */
export const GET = read(async (_event, session) => {
  await requireInstanceAdministrator(session.user.id);
  return json(
    { health: await getAdministratorHealth() },
    { headers: { "cache-control": "no-store" } },
  );
});
