import { json } from "@sveltejs/kit";

import { workspaceCommandSchema } from "orbit/lib/workspace";
import { applyWorkspaceCommand } from "orbit/server/workspace-repository";

import { WORKSPACE_FIXTURE } from "$lib/data/fixtures/workspace.js";
import { fixturesRequested, write } from "$lib/server/api.js";

/**
 * Applies a workspace command — the arrival card's create, and every other
 * workspace write (#735 port; was the fixture-only stand-in for #410 §15).
 *
 * Fixture mode still runs through `write()`'s real session and CSRF check —
 * proving the seam the arrival card depends on — and only substitutes the
 * engine call. That is different from a read fixture, which bypasses auth
 * entirely: this route validates nothing and persists nothing when fixtures
 * are requested, but the POST itself must still carry a real CSRF token.
 */
export const POST = write(async (event, session) => {
  if (fixturesRequested()) {
    await event.request.json().catch(() => null);
    return json({ workspace: WORKSPACE_FIXTURE }, { headers: { "cache-control": "no-store" } });
  }
  const command = workspaceCommandSchema.parse(await event.request.json());
  const workspace = await applyWorkspaceCommand(session.user.id, session.id, command);
  return json({ workspace }, { headers: { "cache-control": "no-store" } });
});
