import { error, json } from "@sveltejs/kit";
import { env } from "$env/dynamic/private";
import { MEMBERS_FIXTURE } from "$lib/data/fixtures/household.js";

/**
 * Fixture stand-in for `GET /api/households/{householdId}/members` (#410) —
 * see api/workspace/+server.js for the env-gating rationale.
 *
 * Read only. The route's POST/DELETE/PATCH — add, remove, hand over — belong
 * to the engine: there are no memberships here to write, and a stand-in that
 * pretended to save would let the gate agree with a state nothing is holding
 * (the reminders stand-in's rule).
 *
 * A household with no entry answers an empty roster rather than 404: the real
 * route 404s on a household the caller cannot see, and a fixture inventing
 * that distinction would be claiming an authorisation decision it has not
 * made.
 */
export function GET({ params }) {
  if (env.ORBIT_FIXTURES !== "1") error(404, "Not found");
  const roster = MEMBERS_FIXTURE[params.householdId] ?? { members: [], candidates: [] };
  return json(roster, { headers: { "cache-control": "no-store" } });
}
