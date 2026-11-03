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
import { ownWorkspace, rescheduleLikeTheEngine, snoozeLikeTheEngine, upsertLikeTheEngine } from "./workspace-writes.js";

export { APP, settle };

/**
 * The rig's waits for the three long-walking specs (axe sweep, keyboard,
 * keyboard-pocket). The stack suite gave 7, 17 and 16 of their waits 10 to 60
 * seconds, for sign-in and seeding; the fixture app needs none of that, but the
 * rig shares a busy host, so an assertion gets 15 s (Playwright's default is 5)
 * and a test 60 s (the default is 30). Applied per file with
 * `expect.configure` and `test.describe.configure`; no assertion is changed.
 */
export const RIG_EXPECT_MS = 15_000;
export const RIG_TEST_MS = 60_000;

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

/**
 * Answers this test's own workspace writes and remembers them, so a save is
 * seen to land: the fixture server persists nothing, so a screen that re-reads
 * the workspace after a save would otherwise show it as it was. Dry runs
 * (ADR-0034: the form's question "would this save go through?") are left to
 * the fixture server, which answers them with the engine's own parse.
 *
 * The one write helper of the rig (workspace-writes.js) with the accessibility
 * specs' three writes: `item.upsert` puts the item in its household's list (a
 * new one appended, an existing one replaced) and is forwarded to the fixture
 * server too, `item.snooze` sets `snoozedUntil`, `item.reschedule` sets
 * `dueDate`; any other command is recorded and answered with the workspace as the writes so far left it.
 * `sent` is every real write, in order.
 *
 * @param {Page} page
 * @returns {Promise<{ sent: { type: string, [key: string]: any }[] }>}
 */
export async function rememberWrites(page) {
  const writes = await ownWorkspace(page, {
    "item.upsert": upsertLikeTheEngine,
    "item.snooze": snoozeLikeTheEngine,
    "item.reschedule": rescheduleLikeTheEngine,
  });
  return { sent: writes.commands };
}
