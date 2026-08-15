import { error } from "@sveltejs/kit";
import { readItem } from "$lib/data/workspace.js";

/**
 * One item, at its own URL (#424), read through the seam (#446) so the
 * fixture-to-live switch happens in one module. The 404 stays here: the seam
 * answers null for an unknown id and the route decides what that means.
 *
 * Client-rendered (#451): the data is the signed-in user's workspace, and the
 * session cookie journey — including the signed-out redirect into login —
 * belongs to the browser. In production the server side of this route could
 * not reach the engine's API anyway: the composite entry (#450) dispatches
 * /api/* to the engine only for requests arriving on the socket.
 */
export const ssr = false;

export async function load({ params }) {
  const item = await readItem(params.id);
  if (!item) error(404, "No such item");
  return { item };
}
