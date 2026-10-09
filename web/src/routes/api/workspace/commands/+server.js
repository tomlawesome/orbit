import { json } from "@sveltejs/kit";

import { appErrorResponse } from "orbit/lib/app-error";
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
 * and writes nothing. It is a question, so it answers 200 either way: `{}`
 * when the save would go through, `{ refusal: { code, message } }` when the
 * engine would refuse it — the same code and words the real call puts in its
 * error envelope, in the member's words where it is one of theirs
 * (src/lib/refusals.ts). The browser sends one at every pause as the member
 * types, so it shows the engine's rules rather than a copy of them, and a
 * browser never logs an expected "not yet" as a failed request (the amendment
 * of 2026-10-09). Only a dry run that could not be heard — maintenance, no
 * session, a stale CSRF token, a fault — answers with a status.
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
  if (dryRunOf(body)) {
    return verdict(async () => {
      const command = parseWorkspaceCommand(withoutDryRun(body));
      await checkWorkspaceCommand(session.user.id, session.id, command);
    });
  }
  const command = parseWorkspaceCommand(body);
  const workspace = await applyWorkspaceCommand(session.user.id, session.id, command);
  return json({ workspace }, { headers: NO_STORE });
}, {
  fixture: async (event) => {
    const body = await event.request.json().catch(() => null);
    if (!dryRunOf(body)) return json({ workspace: WORKSPACE_FIXTURE }, { headers: NO_STORE });
    return verdict(async () => {
      parseWorkspaceCommand(withoutDryRun(body));
    });
  },
});

/**
 * The dry run's answer. The refusal's code and words are read off the very
 * response the real call would have sent, so the two cannot drift: whatever
 * `appErrorResponse` would say with a 4xx, the dry run says with a 200. A
 * fault (5xx) is not an answer and still fails the call as it would the save.
 *
 * @param {() => Promise<void>} check  the parse and checks the save would run
 * @returns {Promise<Response>}
 */
async function verdict(check) {
  try {
    await check();
    return json({}, { headers: NO_STORE });
  } catch (error) {
    const real = appErrorResponse(error);
    if (real.status >= 500) return real;
    /** @type {{ error: { code: string, message: string } }} */
    const { error: refusal } = await real.json();
    return json({ refusal: { code: refusal.code, message: refusal.message } }, { headers: NO_STORE });
  }
}

/** @param {unknown} body */
function dryRunOf(body) {
  return typeof body === "object" && body !== null && /** @type {{ dryRun?: unknown }} */ (body).dryRun === true;
}

/** @param {Record<string, unknown>} body */
function withoutDryRun({ dryRun: _dryRun, ...command }) {
  return command;
}
