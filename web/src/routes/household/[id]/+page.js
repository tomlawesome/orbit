import { error } from "@sveltejs/kit";
import { readHouseholdScreen } from "$lib/data/workspace.js";

/**
 * One household, at its own URL (#410) — reached from the helm's memberships
 * card (§15-2k). Read through the seam so the fixture-to-live switch happens
 * in one module; the 404 stays here, because the seam answers null for a
 * household this session cannot see and the route decides what that means.
 *
 * A membership test against data the session already holds, never a request
 * built from the URL: an unknown id is a 404, not a probe.
 *
 * Client-rendered (#451), like the item view: the data is the signed-in user's
 * workspace and the session-cookie journey belongs to the browser. In
 * production the server side of this route could not reach the engine's API
 * anyway — the composite entry dispatches /api/* to the engine only for
 * requests arriving on the socket.
 */
export const ssr = false;

export async function load({ params }) {
  const household = await readHouseholdScreen(params.id);
  if (!household) error(404, "No such system");
  return { household };
}
