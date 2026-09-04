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
/**
 * Roster (workspace.js) requires `role` on every entry, but the members
 * route's own candidates never carry one (#410) -- so this mirrors the
 * fixture's real shape rather than a type Roster does not actually match.
 * @typedef {import('$lib/data/workspace.js').Member} Member
 * @type {Record<string, { members: Member[], candidates: Omit<Member, 'role'>[] }>}
 */
const membersByHousehold = MEMBERS_FIXTURE;

/** @param {{ params: { householdId: string } }} event */
export function GET({ params }) {
  if (env.ORBIT_FIXTURES !== "1") error(404, "Not found");
  const roster = membersByHousehold[params.householdId] ?? { members: [], candidates: [] };
  return json(roster, { headers: { "cache-control": "no-store" } });
}
