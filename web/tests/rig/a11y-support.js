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

/**
 * #1682: runs `check` with the page's decorative layers hidden, then shows
 * them again. axe cannot measure text contrast over an image or a gradient,
 * and files that text as "incomplete" rather than failing it, so over Orbit's
 * sky and star chart it judged almost nothing (10 of about 100 texts on
 * /household/[id]). Hidden here: everything marked `aria-hidden="true"` that
 * draws a picture (an svg, img or canvas, in it or under it: the sky, the
 * star chart, icons) or no text at all (vignettes), which is already outside
 * what a screen reader or axe's other rules look at. Visible text a screen
 * reader skips (a row's drawn mark) stays, and is still measured. The
 * text is then measured against the surface it sits on. What this gives up:
 * a decorative layer that dims text in front of it is not seen; the pack
 * token tests (tests/unit/v19-pack-*-contrast) cover the sky and veil.
 * @template T
 * @param {Page} page
 * @param {() => Promise<T>} check
 * @returns {Promise<T>}
 */
export async function withDecorationHidden(page, check) {
  const marker = "data-rig-decoration-hidden";
  await page.evaluate((attr) => {
    for (const el of document.querySelectorAll('[aria-hidden="true"]')) {
      if (el.closest(`[${attr}]`)) continue;
      const picture = el.matches("svg, img, canvas") || el.querySelector("svg, img, canvas") !== null;
      if (!picture && (el.textContent ?? "").trim()) continue;
      el.setAttribute(attr, /** @type {HTMLElement} */ (el).style.visibility);
      /** @type {HTMLElement} */ (el).style.setProperty("visibility", "hidden", "important");
    }
  }, marker);
  try {
    return await check();
  } finally {
    await page.evaluate((attr) => {
      for (const el of document.querySelectorAll(`[${attr}]`)) {
        /** @type {HTMLElement} */ (el).style.visibility = el.getAttribute(attr) ?? "";
        el.removeAttribute(attr);
      }
    }, marker).catch(() => undefined);
  }
}

/*
 * Contrast faults #1682 uncovered and filed, each waiting on a design call.
 * They are taken out one element at a time, never a whole test, so the rest
 * of the screen stays checked: a whole-test expected failure on the
 * household page would hide #1307's `.zero` override behind #1684. Each
 * matcher sees the class list and the opening HTML of an axe node.
 */
/** @type {Record<string, (classes: Set<string>, html: string) => boolean>} */
const KNOWN_CONTRAST_FAULTS = {
  /* the at-rest "save" beside each household field */
  "#1684": (classes) => classes.has("fsave"),
  /* the calendar's out-of-month days, weekday heads, "due date" and "· esc"; "tap to copy" */
  "#1686": (classes, html) =>
    (classes.has("day") && classes.has("off")) || classes.has("dow") || classes.has("kb") || classes.has("rl-copy") ||
    /^<h3\b[^>]*>due date/.test(html),
};

/**
 * Takes out of axe's violations the colour-contrast nodes of the known
 * faults a test names, and says which named fault matched nothing -- so a
 * fix shows up as a failure asking for its entry to go, as an expected
 * failure's unexpected pass would.
 * @template {{ id: string, nodes: { html: string }[] }} V
 * @param {V[]} violations
 * @param {string[]} issues the KNOWN_CONTRAST_FAULTS keys this test expects
 * @returns {{ violations: V[], gone: string[] }}
 */
export function withoutKnownFaults(violations, issues) {
  const seen = new Set();
  const rest = violations.map((violation) => {
    if (violation.id !== "color-contrast") return violation;
    const nodes = violation.nodes.filter((node) => {
      const classes = new Set((/^<[a-z0-9]+\b[^>]*\bclass="([^"]*)"/i.exec(node.html)?.[1] ?? "").split(/\s+/));
      const issue = issues.find((key) => KNOWN_CONTRAST_FAULTS[key]?.(classes, node.html));
      if (issue) seen.add(issue);
      return !issue;
    });
    return { ...violation, nodes };
  }).filter((violation) => violation.nodes.length > 0);
  return { violations: rest, gone: issues.filter((issue) => !seen.has(issue)) };
}
