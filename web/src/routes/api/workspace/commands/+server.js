import { error, json } from "@sveltejs/kit";
import { env } from "$env/dynamic/private";

import { WORKSPACE_FIXTURE } from "$lib/data/fixtures/workspace.js";

/**
 * Fixture stand-in for the engine's `POST /api/workspace/commands` (#410, §15).
 *
 * Exists ONLY when the harness asks for it, exactly as the workspace read's
 * stand-in does: the fidelity gate and `vite dev` set ORBIT_FIXTURES=1 so a
 * journey that WRITES can be walked end to end — the arrival's create card is
 * the first surface in this app whose whole point is a write, and a card that
 * cannot be submitted cannot be watched.
 *
 * It is a double and says so: it validates nothing, persists nothing, and
 * answers with the workspace fixture. What it proves is the SEAM — that the
 * card composes a command, posts it with the session's CSRF token, and hands
 * over to the landing on a 200. What only the real engine can prove (the
 * household row, the owner membership, the default sections, the audit trail)
 * is proved against the real engine, in tests/e2e/v19-arrival.spec.ts.
 *
 * Unreachable in production twice over, as every fixture route here is: the
 * composite entry (#450) dispatches every /api/* path to the engine before this
 * router is consulted, and without the env flag the route answers 404 anyway.
 */
export async function POST({ request }) {
  if (env.ORBIT_FIXTURES !== "1") error(404, "Not found");
  await request.json().catch(() => null);
  return json({ workspace: WORKSPACE_FIXTURE }, { headers: { "cache-control": "no-store" } });
}
