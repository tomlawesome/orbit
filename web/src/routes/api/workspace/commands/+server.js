import { json } from "@sveltejs/kit";

import { parseWorkspaceCommand } from "orbit/lib/workspace";
import { applyWorkspaceCommand, checkWorkspaceCommand } from "orbit/server/workspace-repository";

import { WORKSPACE_FIXTURE } from "$lib/data/fixtures/workspace.js";
import { fixturesRequested, write } from "$lib/server/api.js";

const NO_STORE = { "cache-control": "no-store" };

/**
 * Applies a workspace command — the arrival card's create, and every other
 * workspace write (#735 port; was the fixture-only stand-in for #410 §15).
 *
 * `dryRun: true` beside the command (ADR-0034 decision 3, #1325) runs it
 * through the same parse, access check and pre-write checks as the real call
 * and writes nothing: an empty success, or the refusal the real call would
 * give, in the member's words where it is one of theirs (src/lib/refusals.ts).
 * The browser sends one as the member types, so it shows the engine's rules
 * rather than a copy of them.
 *
 * Fixture mode still runs through `write()`'s real session and CSRF check —
 * proving the seam the arrival card depends on — and only substitutes the
 * engine call. That is different from a read fixture, which bypasses auth
 * entirely: this route validates nothing and persists nothing when fixtures
 * are requested, but the POST itself must still carry a real CSRF token.
 */
export const POST = write(async (event, session) => {
  if (fixturesRequested()) {
    const body = await event.request.json().catch(() => null);
    return json(dryRunOf(body) ? {} : { workspace: WORKSPACE_FIXTURE }, { headers: NO_STORE });
  }
  const body = await event.request.json();
  const dryRun = dryRunOf(body);
  const command = parseWorkspaceCommand(dryRun ? withoutDryRun(body) : body);
  if (dryRun) {
    await checkWorkspaceCommand(session.user.id, session.id, command);
    return json({}, { headers: NO_STORE });
  }
  const workspace = await applyWorkspaceCommand(session.user.id, session.id, command);
  return json({ workspace }, { headers: NO_STORE });
});

/** @param {unknown} body */
function dryRunOf(body) {
  return typeof body === "object" && body !== null && /** @type {{ dryRun?: unknown }} */ (body).dryRun === true;
}

/** @param {Record<string, unknown>} body */
function withoutDryRun({ dryRun: _dryRun, ...command }) {
  return command;
}
