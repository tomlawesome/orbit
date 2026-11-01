/*
 * What the four accessibility specs in this folder share (#1609): v19-axe-sweep,
 * v19-screen-reader, v19-keyboard and v19-keyboard-pocket. Not a spec.
 *
 * Every test starts from a fixture state the fidelity gate already stands up
 * (../fidelity/pocket-states.js) or from a fixture route's own address, never
 * from a sign-in and a seeded household. This file only looks those states up
 * and holds the one thing four specs did identically: answering a test's own
 * write, and the reads that follow it.
 */

import { APP, DOOR_STATES, RIG_STATES, SIGNED_IN, settle } from "../fidelity/pocket-states.js";

export { APP, settle };

/** @typedef {import("@playwright/test").Page} Page */
/** @typedef {import("@playwright/test").TestInfo} TestInfo */

/**
 * The rig's phone projects (rig-phone, rig-webkit-phone) say so in their name;
 * a test that belongs to one dialect only skips on the other by it.
 * @param {TestInfo} testInfo
 */
export const onPhone = (testInfo) => testInfo.project.name.endsWith("phone");

/**
 * The fixture state `route`/`state` of pocket-states.js, as a function that
 * reaches it. These states were written for the phone, but a route's reach
 * that only loads the address and waits for the screen to settle is the same
 * on a desk; the ones that wait for a pocket-only element say so there, and
 * RIG_STATES holds the states of the screens both dialects reach ("any-dialect").
 * @param {string} route
 * @param {string} state
 * @returns {(page: Page) => Promise<void>}
 */
export function signedIn(route, state) {
  const found = [...SIGNED_IN, ...RIG_STATES].find((one) => one.route === route && one.state === state);
  if (!found) throw new Error(`pocket-states.js has no signed-in state ${route} / ${state}`);
  return found.reach;
}

/**
 * The door-family state `slug`/`state` of pocket-states.js (the door, the
 * goodbye): the same faked health, availability and session answers the gate
 * gives.
 * @param {string} slug
 * @param {string} state
 * @returns {(page: Page) => Promise<void>}
 */
export function door(slug, state) {
  const found = DOOR_STATES.find((one) => one.slug === slug && one.state === state);
  if (!found) throw new Error(`pocket-states.js has no door state ${slug} / ${state}`);
  return found.reach;
}

/** The workspace command a write carried, minus its dry-run question. */
const COMMANDS = "**/api/workspace/commands";

/**
 * Answers this test's own workspace writes and remembers them, so a save is
 * seen to land: the fixture server persists nothing, so a screen that re-reads
 * the workspace after a save would otherwise show it as it was. Dry runs
 * (ADR-0034: the form's question "would this save go through?") are left to
 * the fixture server, which answers them with the engine's own parse.
 *
 * `item.upsert` puts the item in its household's list (a new one appended, an
 * existing one replaced), `item.snooze` sets `snoozedUntil`, `item.reschedule`
 * sets `dueDate`; any other command is recorded and answered with the workspace
 * as it stands. `sent` is every real write, in order.
 *
 * @param {Page} page
 * @returns {Promise<{ sent: { type: string, [key: string]: any }[] }>}
 */
export async function rememberWrites(page) {
  /** @type {{ type: string, [key: string]: any }[]} */
  const sent = [];
  /** @type {Map<string, Record<string, any>>} item id -> what the writes made of it */
  const changes = new Map();
  /** @type {any[]} */
  const added = [];

  /** @param {any} workspace */
  const applied = (workspace) => {
    for (const household of workspace.households ?? []) {
      household.items = (household.items ?? []).map((/** @type {any} */ item) => ({ ...item, ...changes.get(item.id) }));
      for (const one of added) {
        if (one.householdId === household.id && !household.items.some((/** @type {any} */ item) => item.id === one.item.id)) {
          household.items.push(one.item);
        }
      }
    }
    return workspace;
  };

  await page.route(`**/api/workspace`, async (route) => {
    /* A read still in flight when the test ends finds its page gone. */
    try {
      const response = await route.fetch();
      const body = await response.json();
      applied(body.workspace);
      await route.fulfill({ response, json: body });
    } catch (error) {
      if (!page.isClosed() && !/disposed|closed|Target page/i.test(String(error))) throw error;
    }
  });
  await page.route(COMMANDS, async (route) => {
    const command = route.request().postDataJSON();
    if (command?.dryRun === true) return route.fallback();
    sent.push(command);
    /* The fixture server sees the write too: a browser that asked for the
       `keep-saves` scene (pocket-states.js, useFixtureScenes) has the item held
       there, so a load that runs on the server (home's, after a create) finds
       it. The answer below is still this test's own. */
    if (command.type === "item.upsert") await route.fetch();
    if (command.type === "item.upsert") {
      changes.delete(command.item.id);
      const present = added.findIndex((one) => one.item.id === command.item.id);
      if (present >= 0) added.splice(present, 1);
      added.push({ householdId: command.householdId, item: { status: "active", version: 1, kind: command.kind ?? null, ...command.item } });
      changes.set(command.item.id, { ...command.item, kind: command.kind ?? null });
    } else if (command.type === "item.snooze") {
      changes.set(command.itemId, { ...changes.get(command.itemId), snoozedUntil: command.snoozedUntil });
    } else if (command.type === "item.reschedule") {
      changes.set(command.itemId, { ...changes.get(command.itemId), dueDate: command.dueDate });
    }
    const response = await page.request.get(`${APP}/api/workspace`);
    const body = await response.json();
    await route.fulfill({ json: { ...body, workspace: applied(body.workspace) } });
  });
  return { sent };
}
