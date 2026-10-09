import { json } from "@sveltejs/kit";

import { parseWorkspaceCommand } from "orbit/lib/workspace";
import { applyWorkspaceCommand, checkWorkspaceCommand } from "orbit/server/workspace-repository";

import { WORKSPACE_FIXTURE } from "$lib/data/fixtures/workspace.js";
import { write } from "$lib/server/api.js";

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
 * Fixture mode answers before the maintenance, session and CSRF checks, which
 * all need a database the fidelity gate does not have (as the pre-attachment
 * document routes do, #1245). A real command persists nothing and returns the
 * fixture workspace. A dry run still parses the command, so the gate sees the
 * engine's own refusals; what only a stored household can say (a snooze
 * against its today, a version) is left to the live engine.
 */
export const POST = write(async (event, session) => {
  const body = await event.request.json();
  const dryRun = dryRunOf(body);
  const command = parseWorkspaceCommand(dryRun ? withoutDryRun(body) : body);
  if (dryRun) {
    await checkWorkspaceCommand(session.user.id, session.id, command);
    return json({}, { headers: NO_STORE });
  }
  const workspace = await applyWorkspaceCommand(session.user.id, session.id, command);
  return json({ workspace }, { headers: NO_STORE });
}, {
  fixture: async (event) => {
    const body = await event.request.json().catch(() => null);
    if (!dryRunOf(body)) return json({ workspace: WORKSPACE_FIXTURE }, { headers: NO_STORE });
    parseWorkspaceCommand(withoutDryRun(body));
    return json({}, { headers: NO_STORE });
  },
});

/** @param {unknown} body */
function dryRunOf(body) {
  return typeof body === "object" && body !== null && /** @type {{ dryRun?: unknown }} */ (body).dryRun === true;
}

/** @param {Record<string, unknown>} body */
function withoutDryRun({ dryRun: _dryRun, ...command }) {
  return command;
}
