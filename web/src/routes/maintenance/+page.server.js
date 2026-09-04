import { env } from "$env/dynamic/private";
import { redirect } from "@sveltejs/kit";

import { MAINTENANCE_FIXTURE, MAINTENANCE_FIXTURE_ONE } from "$lib/data/fixtures/maintenance.js";
import { maintenanceView } from "$lib/server/maintenance-view.js";

/**
 * The open window's public timeline for the maintenance screen (#526).
 *
 * This page used to be prerendered so it could be served with nothing behind
 * it. It now carries what the operator has published, which lives in the
 * database — and so does the fact of maintenance itself: the guard that puts
 * a reader here read the same database a moment ago. Nothing is lost by
 * reading it again.
 *
 * Off maintenance there is nothing to show, so the reader goes home: the
 * common way to arrive here is to reload the screen once the window has
 * closed, and being back in is the right answer to that. The 503 and
 * `no-store` on the answer while maintenance is on are the hook's (ADR-0013
 * decision 2); `no-store` is set here too so a direct visit is never cached
 * either.
 *
 * Under the fixture harness the screen renders a known window: three entries
 * by default, or `?entries=one` for the one-entry state. Unreachable in
 * production twice over (#773).
 *
 * @type {import("./$types").PageServerLoad}
 */
export async function load({ url, setHeaders }) {
  if (env.ORBIT_FIXTURES === "1") {
    return { maintenance: url.searchParams.get("entries") === "one" ? MAINTENANCE_FIXTURE_ONE : MAINTENANCE_FIXTURE };
  }

  const { readMaintenanceState } = await import("orbit/server/maintenance");
  const state = await readMaintenanceState();
  if (!state.effectivelyActive) redirect(303, "/");

  setHeaders({ "cache-control": "no-store" });
  return { maintenance: maintenanceView(state) };
}
