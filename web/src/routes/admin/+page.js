import { readOperations } from "$lib/data/workspace.js";

/** The observatory reads through the seam (#446); GET /api/admin/operations
 *  already serves this shape when the flip comes. */
export async function load() {
  return { operations: await readOperations() };
}
