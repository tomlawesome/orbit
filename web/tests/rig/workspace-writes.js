/*
 * What a rig test needs when the screen under test WRITES (ADR-0039, #1609).
 * The one write helper of the rig: the screens specs use it directly, the
 * accessibility specs through `rememberWrites` (a11y-support.js).
 *
 * The fixture app answers every workspace command with the same fixture
 * workspace and keeps nothing (api/workspace/commands/+server.js), which is
 * right for a screen that only reads and wrong for one whose point is what it
 * shows after a save. A test of that kind brings its own writes: this stands
 * in for the engine for that one test, in that one page. Not a fixture: it
 * adds no state to the app, it answers the commands a test itself sends.
 *
 * Not a spec: nothing here runs on its own.
 */

import { APP } from "../fidelity/pocket-states.js";

/** @typedef {import("@playwright/test").Page} Page */

/**
 * @typedef {{ type: string, dryRun?: boolean } & Record<string, any>} Command
 * @typedef {(command: Command, workspace: any) => ({ status: number, json: unknown } | void | Promise<{ status: number, json: unknown } | void>)} CommandHandler
 */

/** A calendar date `months` months on, as the engine counts a period. @param {string} date @param {number} months */
export function monthsAfter(date, months) {
  const [year, month, day] = date.split("-").map(Number);
  const at = new Date(Date.UTC(year, month - 1 + months, day));
  return at.toISOString().slice(0, 10);
}

/**
 * The workspace for this page: the fixture's, plus what the test's own writes
 * changed. A command with no handler gets the fixture app's own answer.
 * `commands` is every real command the page sent, in order (dry runs, the
 * live checks the forms ask while a member types, are not counted).
 * @param {Page} page
 * @param {Record<string, CommandHandler>} [handlers]  by command type; each changes `workspace` in place
 */
export async function ownWorkspace(page, handlers = {}) {
  /** @type {any} */
  let body = null;
  /** @type {Command[]} */
  const commands = [];
  const read = async () => {
    body ??= await (await page.request.get(`${APP}/api/workspace`)).json();
    return body;
  };
  /* A route handler still running when the test ends finds its page gone:
     that is the end of the test, not a failure of it. */
  /** @param {unknown} error */
  const pageGone = (error) => page.isClosed() || /disposed|closed|Target page/i.test(String(error));
  await page.route("**/api/workspace", async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    try {
      return await route.fulfill({ json: await read(), headers: { "cache-control": "no-store" } });
    } catch (error) {
      if (!pageGone(error)) throw error;
    }
  });
  await page.route("**/api/workspace/commands", async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    const command = /** @type {Command} */ (route.request().postDataJSON());
    if (command.dryRun) return route.fallback();
    commands.push(command);
    const handler = handlers[command.type];
    if (!handler) return route.fallback();
    try {
      const current = await read();
      const refusal = await handler(command, current.workspace);
      if (refusal) return await route.fulfill({ status: refusal.status, json: refusal.json });
      /* The fixture server sees a real save too: a browser that asked for the
         `keep-saves` scene (pocket-states.js, useFixtureScenes) has the item
         held there, so a load that runs on the server (home's, after a create)
         finds it. The answer below is still this test's own. */
      if (command.type === "item.upsert") await route.fetch();
      return await route.fulfill({ json: current, headers: { "cache-control": "no-store" } });
    } catch (error) {
      if (!pageGone(error)) throw error;
    }
  });
  return {
    commands,
    /** The workspace as this page would read it now. */
    workspace: async () => (await read()).workspace,
    /** The command of one type, last sent first. @param {string} type */
    sent: (type) => commands.filter((one) => one.type === type),
    /** The household and item as the workspace holds them now. @param {string} itemId */
    async itemOf(itemId) {
      const { workspace } = await read();
      for (const household of workspace.households) {
        const item = household.items.find((/** @type {{ id: string }} */ one) => one.id === itemId);
        if (item) return { household, item };
      }
      return null;
    },
  };
}

/* ── the engine's own arithmetic, for the four writes the specs send ─── */

/** @param {any} workspace @param {string} householdId @param {string} itemId */
function find(workspace, householdId, itemId) {
  const household = workspace.households.find((/** @type {{ id: string }} */ one) => one.id === householdId);
  return { household, item: household?.items.find((/** @type {{ id: string }} */ one) => one.id === itemId) };
}

/** item.upsert: the item as sent, one version on. @type {CommandHandler} */
export function upsertLikeTheEngine(command, workspace) {
  const { household, item: held } = find(workspace, command.householdId, command.item.id);
  if (!household) return { status: 404, json: { error: { code: "household_not_found", message: "Household not found" } } };
  const version = (held?.version ?? 0) + 1;
  /* The engine's version check: an upsert of a held item names the version it becomes. */
  if (held && command.item.version !== undefined && command.item.version !== version) {
    return { status: 409, json: { error: { code: "version_required", message: "This item changed on another device; refresh and try again" } } };
  }
  const next = { ...held, ...command.item, status: "active", kind: command.kind ?? held?.kind ?? "service", version, updatedAt: new Date().toISOString() };
  if (held) household.items[household.items.indexOf(held)] = next;
  else household.items.push(next);
}

/** item.complete: the next due date a period on. @type {CommandHandler} */
export function completeLikeTheEngine(command, workspace) {
  const { item } = find(workspace, command.householdId, command.itemId);
  if (!item) return { status: 404, json: { error: { code: "item_not_found", message: "Item not found" } } };
  item.dueDate = monthsAfter(item.dueDate ?? command.completedDate, item.recurrenceMonths ?? 12);
  item.snoozedUntil = undefined;
  item.version = (item.version ?? 0) + 1;
}

/** item.snooze: the day sent. @type {CommandHandler} */
export function snoozeLikeTheEngine(command, workspace) {
  const { item } = find(workspace, command.householdId, command.itemId);
  if (!item) return { status: 404, json: { error: { code: "item_not_found", message: "Item not found" } } };
  item.snoozedUntil = command.snoozedUntil;
  item.version = (item.version ?? 0) + 1;
}

/** item.reschedule: the date sent. @type {CommandHandler} */
export function rescheduleLikeTheEngine(command, workspace) {
  const { item } = find(workspace, command.householdId, command.itemId);
  if (!item) return { status: 404, json: { error: { code: "item_not_found", message: "Item not found" } } };
  item.dueDate = command.dueDate;
  item.version = (item.version ?? 0) + 1;
}
