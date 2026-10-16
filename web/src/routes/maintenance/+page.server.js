import { env } from "$env/dynamic/private";
import { redirect } from "@sveltejs/kit";

import {
  MAINTENANCE_FIXTURE,
  MAINTENANCE_FIXTURE_ONE,
  MAINTENANCE_KEY_FIXTURE,
  MAINTENANCE_KEY_FIXTURE_CONTACT,
} from "$lib/data/fixtures/maintenance.js";
import { maintenanceView } from "$lib/server/maintenance-view.js";

/**
 * What the maintenance screen shows: one route, two kinds of closure.
 *
 * `kind: "key"` (#1405) is Orbit holding no usable encryption key, decided
 * first: no entries and no expected return (nothing says when the key will
 * be back), and the instance's public contact address when one is set,
 * because it is the one address Orbit can still read and the only one a
 * member can be pointed at while nobody can sign in. It never goes home: the
 * operator's window being closed says nothing about the key. A verdict not
 * yet taken counts as no key, as at every other gate.
 *
 * `kind: "window"` is the operator's open window's public timeline (#526).
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
 * by default, or `?entries=one` for the one-entry state; `?kind=key` draws the
 * key screen, and `?kind=key&contact=1` the same with a contact address.
 * Unreachable in production twice over (#773).
 *
 * @type {import("./$types").PageServerLoad}
 */
export async function load({ url, setHeaders }) {
  if (env.ORBIT_FIXTURES === "1") {
    if (url.searchParams.get("kind") === "key") {
      return { maintenance: url.searchParams.get("contact") === "1" ? MAINTENANCE_KEY_FIXTURE_CONTACT : MAINTENANCE_KEY_FIXTURE };
    }
    return { maintenance: url.searchParams.get("entries") === "one" ? MAINTENANCE_FIXTURE_ONE : MAINTENANCE_FIXTURE };
  }

  const { getKeyState } = await import("orbit/server/key-state");
  if (getKeyState().verdict !== "usable") {
    setHeaders({ "cache-control": "no-store" });
    return { maintenance: { kind: "key", entries: [], expectedEndAt: null, contactAddress: await contactAddressOrNull() } };
  }

  const { readMaintenanceState } = await import("orbit/server/maintenance");
  const state = await readMaintenanceState();
  if (!state.effectivelyActive) redirect(303, "/");

  setHeaders({ "cache-control": "no-store" });
  return { maintenance: { kind: "window", ...maintenanceView(state), contactAddress: null } };
}

/** The public contact address, or null when none is set or it cannot be read. */
async function contactAddressOrNull() {
  try {
    const { readPublicContactAddress } = await import("orbit/server/instance-contact");
    return await readPublicContactAddress();
  } catch {
    return null;
  }
}
