import { json } from "@sveltejs/kit";

import { readWorkspace } from "orbit/server/workspace-repository";

import { WORKSPACE_FIXTURE } from "$lib/data/fixtures/workspace.js";
import { read } from "$lib/server/api.js";

/**
 * The workspace a signed-in reader sees — everything home draws (#451).
 *
 * Ported off Next (#735). The fixture that used to be all this route could do
 * is now the `fixture` branch, taken only when ORBIT_FIXTURES is set for the
 * fidelity gate or `vite dev`; unset, this answers from the engine like any
 * other route rather than 404ing.
 */
export const GET = read(
  async (_event, session) => {
    const workspace = await readWorkspace(session.user.id, session.id, session.activeHouseholdId);
    return json({ workspace }, { headers: { "cache-control": "no-store" } });
  },
  { fixture: () => json({ workspace: WORKSPACE_FIXTURE }, { headers: { "cache-control": "no-store" } }) },
);
