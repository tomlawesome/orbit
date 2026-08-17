import { error } from "@sveltejs/kit";
import { readBelt } from "$lib/data/workspace.js";

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
 */
export const ssr = false;

export async function load({ params }) {
  const view = await readBelt(params.id);
  if (!view) error(404, "No such item");
  return view;
}
