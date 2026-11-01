import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { expect, test } from "@playwright/test";

import { gotoCreate } from "../../../tests/e2e/support/keyboard";
import { APP, door, onPhone, signedIn } from "./a11y-support.js";

/** @typedef {import("@playwright/test").Locator} Locator */
/** @typedef {import("@playwright/test").Page} Page */
/** @typedef {import("@playwright/test").TestInfo} TestInfo */

/*
 * #496, moved to the rig (ADR-0039, #1609): a screen-reader walkthrough of
 * the core journeys.
 *
 * A real screen reader needs a human in the loop, so this is the automated
 * proxy: for every core-journey screen it reads back what the browser's own
 * accessibility engine would announce (Playwright's `getByRole` and
 * `toHaveAccessibleName` are backed by the same accessible-name computation a
 * screen reader uses, not by `title` text) and writes the raw ARIA tree to
 * `test-results/playwright/aria/<route>--<project>.txt` so a human can read
 * the same thing back in plain text.
 *
 * Criterion 3 (decorative art) does NOT re-prove the home dial: that is
 * tests/e2e/v19-chart-accessibility.spec.ts's job. This file only asserts the
 * OTHER decorative backdrops each screen carries (the `.sky` / `.backdrop` /
 * `.satellites` starfields).
 *
 * Every screen starts from a fixture state or a fixture route's own address
 * (the fixture workspace's Harlow Home and its Car MOT); nothing is seeded.
 * Each test is independent, so one screen failing its promise hides nothing
 * about the rest.
 *
 * `baseURL` is the fixture app, so the keyboard helpers of the stack suite
 * (tests/e2e/support/keyboard.ts, `gotoCreate`) can be reused as they stand.
 */
test.use({ baseURL: APP });

const ROLES_NEEDING_NAMES = [
  "button", "link", "textbox", "combobox", "checkbox", "switch", "tab", "menuitem",
];

/** Text that must never appear in a live status/notice region (#411). */
const UNBOUNDED_TEXT_PATTERNS = /** @type {[RegExp, string][]} */ ([
  [/\b\d+\.\d+\.\d+\b/, "a version number"],
  [/\/(home|app|var|usr|srv|etc)\//, "a filesystem path"],
  [/\bat [\w./]+:\d+:\d+\b/, "a stack-trace frame"],
  [/\bError:\s/, "a raw error prefix"],
]);

/**
 * Every role the criterion cares about, across the whole page, must be named.
 * Soft assertions: one unnamed control should not hide the rest, so a single
 * run of this walkthrough surfaces every gap on the screen rather than only
 * the first.
 * @param {Page} page @param {string} screen
 */
async function assertEveryControlIsNamed(page, screen) {
  for (const role of ROLES_NEEDING_NAMES) {
    const locator = page.getByRole(/** @type {any} */ (role));
    const count = await locator.count();
    for (let index = 0; index < count; index += 1) {
      const control = locator.nth(index);
      await expect.soft(control, `${screen}: ${role} #${index} has no accessible name`).toHaveAccessibleName(/\S/);
    }
  }
}

/**
 * Criterion 2: one main, one h1, and no skipped heading level -- as a screen
 * reader meets them. #1120: a screen with a pocket dialect carries both its
 * desk and its pocket markup and shows one with display:none on the other, so
 * what is counted is what the accessibility tree exposes (getByRole leaves
 * out display:none, visibility:hidden and aria-hidden, but keeps anything
 * merely moved off-screen). Counting raw elements would pass a phone whose
 * only main is the hidden desk's, and fail a page whose second main no reader
 * can reach.
 * @param {Page} page @param {string} screen
 */
async function assertLandmarksAndHeadings(page, screen) {
  const main = page.getByRole("main");
  await expect.soft(main, `${screen}: expected exactly one main landmark`).toHaveCount(1);

  const h1 = page.getByRole("heading", { level: 1 });
  await expect.soft(h1, `${screen}: expected exactly one h1`).toHaveCount(1);

  const levels = await page.getByRole("heading").evaluateAll((elements) =>
    elements.map((element) => Number(element.getAttribute("aria-level")) || Number(element.tagName.slice(1))),
  );
  let previous = 0;
  for (const level of levels) {
    if (previous > 0 && level > previous + 1) {
      expect.soft(level, `${screen}: heading level skipped, from h${previous} to h${level} (order: ${levels.join(",")})`)
        .toBeLessThanOrEqual(previous + 1);
    }
    previous = level;
  }
}

/**
 * Criterion 4: a live region carries role=status/aria-live, and its text is
 * bounded.
 * @param {Locator} region @param {string} screen @param {string} label
 */
async function assertLiveRegionIsSafe(region, screen, label) {
  const role = await region.getAttribute("role");
  const live = await region.getAttribute("aria-live");
  expect.soft(role === "status" || role === "alert" || live !== null, `${screen}: ${label} has neither role=status/alert nor aria-live`).toBe(true);

  const text = (await region.innerText()).trim();
  for (const [pattern, description] of UNBOUNDED_TEXT_PATTERNS) {
    expect.soft(pattern.test(text), `${screen}: ${label} text "${text}" looks like it leaked ${description}`).toBe(false);
  }
}

/** @param {Page} page @param {TestInfo} testInfo @param {string} route */
async function writeSnapshot(page, testInfo, route) {
  const snapshot = await page.locator("body").ariaSnapshot();
  /* One file per route per project (the desk and the phone both walk every
     screen, and /home in particular has two dialects worth reading
     separately). testInfo.outputPath() refuses to leave its own per-test
     folder, so the flat, human-browsable "aria" folder is built from the
     project's output root. */
  const path = join(testInfo.project.outputDir, "aria", `${route}--${testInfo.project.name}.txt`);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, snapshot, "utf8");
}

/**
 * One screen, fully worked: snapshot written, every named-control criterion
 * checked, landmarks and headings checked. Screen-specific extras (criteria
 * 3/4/5) are layered on by the caller after this returns.
 * @param {Page} page @param {TestInfo} testInfo @param {string} route
 */
async function walkScreen(page, testInfo, route) {
  await writeSnapshot(page, testInfo, route);
  await assertEveryControlIsNamed(page, route);
  await assertLandmarksAndHeadings(page, route);
}

/** The fixture workspace's item the drawer tests read: Harlow Home's Car MOT. */
const ITEM_ID = "i-mot";
const ITEM_TITLE = "Car MOT — Volvo V60";

test.describe("#496 screen-reader walkthrough of the core journeys", () => {
  test("arrive/sign-in: the front door, signed out", async ({ page }, testInfo) => {
    await door("door", "rest")(page);
    await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();
    await walkScreen(page, testInfo, "arrive-sign-in");
    // Decorative: the dawn's own starfield and world layers.
    await expect(page.locator(".signin-stage")).toHaveAttribute("aria-hidden", "true");
  });

  test("/home", async ({ page }, testInfo) => {
    await signedIn("/home", "rest")(page);
    await expect(page.locator(".dialwrap, .mdial").filter({ visible: true })).toHaveCount(1);
    await walkScreen(page, testInfo, "home");

    // Criterion 3: the dial itself is v19-chart-accessibility.spec.ts's job;
    // this only checks the status drawer is present to check as a live region.
    const drawer = page.locator("#statusdrawer");
    await expect(drawer).toBeAttached();
    await assertLiveRegionIsSafe(drawer, "home", "#statusdrawer (system status)");
  });

  /* #1319 (owner-decisions §34): the drawer opens from `/home?item=<id>` and
     holds everything the belt did, so the drawer is what is read back: the
     screen with it open, then with its rows in edit and the chooser up (the
     due date's calendar), every control named and the landmarks and headings
     whole in both states. The desk's drawer is a named region; the phone's is
     the row's own panel. */
  test("/home?item=<id>: the item drawer, read and edited", async ({ page }, testInfo) => {
    await page.goto(`${APP}/home?item=${ITEM_ID}`, { waitUntil: "load" });
    const phone = onPhone(testInfo);
    const drawer = phone
      ? page.locator(`.pocket .pk-below [data-row-key="${ITEM_ID}"]`)
      : page.getByRole("region", { name: `${ITEM_TITLE} — full detail` });
    if (phone) await expect(drawer).toHaveAttribute("data-open", "");
    const acts = drawer.getByRole("group", { name: `Actions for ${ITEM_TITLE}` });
    await expect(acts).toBeVisible();
    await walkScreen(page, testInfo, "home-item-drawer");
    await expect(acts.getByRole("button")).toHaveText(["snooze", "complete", "attach a document", "retire"]);
    await expect(drawer.getByRole("button", { name: "Edit this item" })).toBeVisible();
    await expect(drawer.getByRole("button", { name: "Copy link" })).toBeVisible();

    await drawer.getByRole("button", { name: "Edit this item" }).click();
    await expect(drawer.getByRole("group", { name: `Editing ${ITEM_TITLE}` })).toBeVisible();
    await drawer.getByRole("button", { name: /^due: / }).click();
    const chooser = page.getByRole("dialog", { name: /due date/i });
    await expect(chooser).toBeVisible();
    await walkScreen(page, testInfo, "home-item-drawer-editing");
    await expect(chooser.getByRole("grid")).toHaveAccessibleName(/\S/);
    /* Put back as found: the chooser, then the unchanged edit. */
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");
    await expect(acts).toBeVisible();
  });

  test("/household/[id]", async ({ page }, testInfo) => {
    await signedIn("/household/hh-harlow-1", "any-dialect")(page);
    await expect(page.getByRole("heading", { name: "Harlow Home" })).toBeVisible();
    await walkScreen(page, testInfo, "household-id");
  });

  test("/create", async ({ page }, testInfo) => {
    /* #856: the walk reads a hydrated screen, so wait for the mount rather
       than for `load`. */
    await gotoCreate(page);
    await walkScreen(page, testInfo, "create");
    await expect(page.locator(".backdrop")).toHaveAttribute("aria-hidden", "true");
  });

  test("/settings", async ({ page }, testInfo) => {
    await signedIn("/settings", "rest")(page);
    await walkScreen(page, testInfo, "settings");
    await expect(page.locator(".sky").first()).toHaveAttribute("aria-hidden", "true");
  });

  test("/settings/mail", async ({ page }, testInfo) => {
    await signedIn("/settings/mail", "rest")(page);
    await walkScreen(page, testInfo, "settings-mail");
    await expect(page.locator(".satellites")).toHaveAttribute("aria-hidden", "true");
  });

  test("/inbox", async ({ page }, testInfo) => {
    await signedIn("/inbox", "rest")(page);
    await walkScreen(page, testInfo, "inbox");
    await expect(page.locator(".sky").first()).toHaveAttribute("aria-hidden", "true");
  });

  test("/administration", async ({ page }, testInfo) => {
    await signedIn("/administration", "any-dialect")(page);
    await expect(page.getByRole("heading", { name: "Administration" })).toBeVisible();
    await walkScreen(page, testInfo, "administration");
    await expect(page.locator(".station-backdrop")).toHaveAttribute("aria-hidden", "true");
  });

  /**
   * First-run tour overlay. The fixture state `/home` / `film-rest` answers
   * the tour record "never taken" and pauses the film at its first chapter
   * through the film's own review hooks.
   */
  test("first-run tour overlay", async ({ page }, testInfo) => {
    /* T-Q2 (#1151): the phone is not skipped. #1083 shipped a pocket cut of the
       film, and transport.js is one shared component, so the structural checks
       below (role, accessible names, the script and status regions existing)
       hold on both viewports. The desk cut's exact heading count and status
       wording are pinned desk-only: owner-decisions.md §32 records the pocket
       cut dropping content (chapter 2's recurrence beat). */
    const mobile = onPhone(testInfo);
    await signedIn("/home", "film-rest")(page);
    // #866 retired the dialog-shaped card for the one-take film: no
    // `role="dialog"` and, per transport.js, no focus management at all --
    // the pill is a `role="group"` landmark a reader tabs to like any other
    // toolbar, not something that grabs focus on arrival.
    const transport = page.locator("#orbit-tour-transport");
    await expect(transport).toBeVisible();

    await expect(transport).toHaveAttribute("role", "group");
    await expect(transport).toHaveAccessibleName(/\S/);

    await expect(page.getByRole("button", { name: /Play|Pause/ })).toHaveAccessibleName(/\S/);
    await expect(page.getByRole("button", { name: "Skip the tour" })).toHaveAccessibleName(/\S/);

    // #1097 (round 7): the film is not narrated -- a screen reader gets its
    // script instead, twelve headings deep on the desk cut, plus one
    // announcement when the film starts. Both live inside the transport,
    // visually hidden, never `aria-hidden` (design/v19/tour/round-7/README.md).
    const script = transport.getByRole("region", { name: "Tour script" });
    await expect(script).toHaveCount(1);

    const status = transport.getByRole("status");
    await expect(status).toHaveCount(1);

    if (mobile) {
      // Pocket content is pinned at twelve headings and this exact wording
      // once the pocket script's shape is confirmed; until then this only
      // proves the script and announcement exist and are not empty.
      await expect(script.locator("h3").first()).toBeAttached();
      await expect(status).not.toHaveText("");
    } else {
      await expect(script.locator("h3")).toHaveCount(12);
      await expect(status).toHaveText(
        "Orbit's tour is playing on screen: a short film over your own sky, "
        + "with a transport at the bottom. Press Escape to skip it. The full "
        + 'script is in the tour transport, under "Tour script".',
      );
    }

    await writeSnapshot(page, testInfo, "tour-overlay");

    // Esc reaches transport.js's own listener -> player.stop(), which clears
    // the veil synchronously; the pill itself then fades out and is removed a
    // second later (#1190), so the veil -- not the pill -- is what this waits on.
    await page.keyboard.press("Escape");
    await expect(page.locator("#orbit-tour-veil")).toBeHidden();
  });

  /**
   * Sign-out. It uses Chrome.svelte's own sign-out control reached from a
   * sub-screen, the real product path: one press (owner, 2026-10-06) revokes
   * the session, then hands the reader to /logout. The fixture server has no
   * session to revoke, so this test answers its own write (the revoke) and,
   * once it has, the session read that follows: signed out, as it would be.
   */
  test("sign-out screen", async ({ page }, testInfo) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    let revoked = false;
    await page.route("**/api/auth/logout", (route) => {
      revoked = true;
      return route.fulfill({ json: { redirectTo: null } });
    });
    await page.route("**/api/auth/session", (route) =>
      revoked ? route.fulfill({ status: 401, json: { error: "unauthenticated" } }) : route.fallback());
    await signedIn("/settings", "rest")(page);
    if (onPhone(testInfo)) {
      /* #1120: on a phone the sub-screen chrome's orb opens the hatch, and its
         sign-out pill is the same one-press control, in the pocket's own sheet. */
      await page.getByRole("button", { name: "Account and menu" }).click();
      const signOutPill = page.getByRole("dialog").getByRole("button", { name: /sign out/ });
      await expect(signOutPill).toHaveAccessibleName("sign out →");
      await signOutPill.click();
    } else {
      await page.locator("button.orb").click();
      await page.locator(".account .signout").click();
    }
    await expect(page).toHaveURL(/\/logout$/);
    await expect(page.getByRole("link", { name: "Sign back in" })).toBeVisible();

    await walkScreen(page, testInfo, "sign-out");
    await expect(page.locator(".signin-stage")).toHaveAttribute("aria-hidden", "true");
  });
});
