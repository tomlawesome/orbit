import { readRelay } from "$lib/data/workspace.js";

/** Your relay reads through the seam (#446); the live source is the #432
 *  endpoint when it exists. */
export async function load() {
  return { relay: await readRelay() };
}
