import { error, json } from "@sveltejs/kit";
import { env } from "$env/dynamic/private";

import { WORKSPACE_FIXTURE } from "$lib/data/fixtures/workspace.js";

/**
 * Fixture stand-in for the engine's `GET /api/workspace` (#451). Exists ONLY
 * when the harness asks for it: the fidelity gate and `vite dev` set
 * ORBIT_FIXTURES=1 so the seam's real fetch path renders known data.
 *
 * Unreachable in production twice over: the composite entry (#450) dispatches
 * every /api/* path to the engine before this router is consulted, and
 * without the env flag the route answers 404 anyway.
 */
export function GET() {
  if (env.ORBIT_FIXTURES !== "1") error(404, "Not found");
  return json({ workspace: WORKSPACE_FIXTURE }, { headers: { "cache-control": "no-store" } });
}
