import { error } from "@sveltejs/kit";
import { readItem } from "$lib/data/workspace.js";

/**
 * One item, at its own URL (#424), read through the seam (#446) so the
 * fixture-to-live switch happens in one module. The 404 stays here: the seam
 * answers null for an unknown id and the route decides what that means.
 */
export async function load({ params }) {
  const item = await readItem(params.id);
  if (!item) error(404, "No such item");
  return { item };
}
