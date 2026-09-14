import { error } from "@sveltejs/kit";
import { readBelt, readSession, readWorkspace } from "$lib/data/workspace.js";
import { beltManifestOf } from "$lib/data/belt.js";

/**
 * One item, at its own URL (#424) — and since #458, THE BELT (§15, owner
 * 2026-08-16: "this surface IS the item screen"). The address contract is
 * unchanged, deliberately: /item/<id> is what home's rows, the inbox's filed
 * lane and every reminder link already point at, and #424's shallow
 * `/home?item=` routing sits beside it. What changed is what the address
 * renders — the whole household's manifest as one band of rock, with this
 * item seated at the apex as its card.
 *
 * Read through the seam (#446) so the fixture-to-live switch happens in one
 * module. The 404 stays here: the seam answers null for an unknown id and the
 * route decides what that means.
 *
 * Client-rendered (#451): the data is the signed-in user's workspace, and the
 * session cookie journey — including the signed-out redirect into login —
 * belongs to the browser. In production the server side of this route could
 * not reach the engine's API anyway: the composite entry (#450) dispatches
 * /api/* to the engine only for requests arriving on the socket.
 *
 * `[[id]]` is optional (#1014): the belt is one mounted surface with a moving
 * apex, so the menu's front door is this same route, entered with nothing
 * seated yet. An unknown id still 404s below — only the ABSENCE of one is
 * handled here.
 */
export const ssr = false;

/**
 * Which item takes the apex when nobody named one: the belt's own ordering
 * (beltManifestOf sorts every active item ascending by due date — soonest,
 * or most overdue, first), read for the signed-in user's primary household so
 * arriving at /item seats the same body pressing → from a fresh belt would
 * eventually reach first. A household with nothing active on it has no such
 * body; the caller renders the empty state instead of guessing one.
 *
 * @returns {Promise<{ household: import("$lib/data/workspace.js").Household | null, nearestId: string | null }>}
 */
async function primaryArrival() {
  const workspace = await readWorkspace();
  const primaryId = workspace.activeHouseholdId ?? workspace.households[0]?.id ?? null;
  const household = workspace.households.find((one) => one.id === primaryId) ?? null;
  const rows = beltManifestOf({ household, today: new Date().toISOString().slice(0, 10) });
  return { household, nearestId: rows[0]?.id ?? null };
}

export async function load({ params }) {
  if (!params.id) {
    const { household, nearestId } = await primaryArrival();
    if (nearestId) {
      const view = await readBelt(nearestId);
      if (!view) error(404, "No such item");
      return view;
    }
    /* Nothing active in the household (or no household at all): the belt's
       own "empty household" card (+page.svelte) renders off `bodies.length`,
       which beltManifestOf already made zero above -- no id to seat means no
       readBelt() round trip either. */
    const session = await readSession();
    return {
      kind: "belt",
      selectedId: null,
      today: new Date().toISOString().slice(0, 10),
      user: session?.user ?? null,
      household: household
        ? { ...household, items: (household.items ?? []).map((item) => ({ ...item, householdId: household.id })) }
        : null,
      documentsByItem: {},
    };
  }
  const view = await readBelt(params.id);
  if (!view) error(404, "No such item");
  return view;
}
