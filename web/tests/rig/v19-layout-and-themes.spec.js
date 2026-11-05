import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import AxeBuilder from "@axe-core/playwright";
import { expect as baseExpect, test } from "@playwright/test";

import { entrancesSettled } from "../../../tests/e2e/support/motion";
import { onPhone, RIG_EXPECT_MS, RIG_TEST_MS, signedIn, withDecorationHidden, withoutKnownFaults } from "./a11y-support.js";

const expect = baseExpect.configure({ timeout: RIG_EXPECT_MS });
test.describe.configure({ timeout: RIG_TEST_MS });

/** @typedef {import("@playwright/test").Page} Page */

/* The roster, read from its one home (web/src/lib/theme.js, #865) so a sixth
   pack is swept the day it lands. Parsed rather than imported, as the stack
   test did: tests/unit/v19-theme-roster.test.mjs holds the module to the same
   two literals this reads. */
const THEME_SOURCE = readFileSync(fileURLToPath(new URL("../../src/lib/theme.js", import.meta.url)), "utf8");
/* #1331: THEME_PACKS is derived from THEME_TABLE, so the ids are its rows' `id:` fields, in table order. */
const THEME_TABLE_SOURCE = /export const THEME_TABLE = \[([\s\S]*?)\n\];/.exec(THEME_SOURCE)?.[1] ?? "";
const THEME_PACKS = [...THEME_TABLE_SOURCE.matchAll(/\bid: "([\w-]+)"/g)].map((match) => match[1]);
const DEFAULT_THEME = /export const DEFAULT_THEME = "([\w-]+)";/.exec(THEME_SOURCE)?.[1];
if (THEME_PACKS.length < 2 || !DEFAULT_THEME) throw new Error("#1178: could not read the theme roster from web/src/lib/theme.js");

const WCAG_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"];
const DECORATIVE_BACKDROP = '.layer[aria-hidden="true"]';

/** WCAG A/AA violations on the page as it stands, decoration and the
 * named known faults (a11y-support.js withoutKnownFaults) excluded; and any
 * named fault that is no longer there.
 * @param {Page} page
 * @param {string[]} [known] */
async function axeViolations(page, known = []) {
  const results = await withDecorationHidden(page, () => new AxeBuilder({ page }).withTags(WCAG_TAGS).exclude(DECORATIVE_BACKDROP).analyze());
  const { violations, gone } = withoutKnownFaults(results.violations, known);
  /* Only what a person needs to act on: the rule, and where it fired. */
  return {
    violations: violations.map((violation) => ({
      rule: violation.id,
      targets: violation.nodes.map((node) => node.target.join(" ")),
    })),
    gone: gone.map((issue) => `${issue} no longer found here: take it off this test's known faults`),
  };
}

/** Checks the page with axe, allowing only the known faults named.
 * @param {Page} page
 * @param {string} what
 * @param {string[]} known */
async function expectNoAxeViolations(page, what, known) {
  const { violations, gone } = await axeViolations(page, known);
  expect(violations, what).toEqual([]);
  expect(gone, what).toEqual([]);
}

/*
 * #1178, moved to the rig (ADR-0039, #1611) from tests/e2e/v19-layout-and-themes.spec.ts:
 * what authenticated-accessibility.spec.ts checked across viewports and themes
 * before the Next.js removal, ported to the v19 screens.
 *
 * 1. THE VIEWPORT MATRIX. Every signed-in v19 screen (the item's own screen
 *    being home with its drawer open since #1319) at the three sizes the old
 *    spec used -- 1440x900, 820x1180 and 412x915 -- with no document-level
 *    sideways scroll, every visible control inside the viewport and not cut
 *    off by a box that hides its overflow, and no axe WCAG A/AA violation at
 *    that size. 820 is the interesting one: it is under the dialect switch
 *    (max-width:900px), so a tablet gets the pocket screens drawn at nearly
 *    twice a phone's width. The matrix sets its own viewports, so it runs in
 *    the desk projects only, as the old spec's did.
 *
 * 2. THE THEME PACKS. Every pack on the roster except the default (which the
 *    matrix and v19-axe-sweep.spec.js already sweep) on every screen, with
 *    axe's WCAG A/AA rules -- colour contrast is the one a pack can break. The
 *    pack is chosen the way the swatches choose it: `orbit-theme` in
 *    localStorage, read by app.html's pre-paint script.
 *
 * Every screen starts from a fixture state (the reader is the fixture's, in
 * Harlow Home), set at its viewport BEFORE the first navigation so the dialect
 * is chosen at that size: no sign-in, no household seeded, no pack saved to an
 * account (the fixture app has no account to save to; the stack suite's
 * savePack existed because an account's saved pack wins over the browser's
 * copy).
 *
 * The old spec also ran every Orbit text-size setting: v19 stores `textSize`
 * but no screen applies it, so there is nothing for a check to measure.
 */

/** @typedef {{ name: string, reach: (page: Page) => Promise<void>, ready: (page: Page) => Promise<unknown> }} Screen */

/** @type {Screen[]} */
const SCREENS = [
  { name: "/home", reach: signedIn("/home", "rest"), ready: (page) => page.locator("body[data-home-ready]").waitFor({ state: "attached" }) },
  /* #1120: the one exposed name field of whichever dialect is showing. */
  { name: "/create", reach: signedIn("/create", "any-dialect"), ready: (page) => expect(page.getByRole("textbox", { name: "name", exact: true })).toBeVisible() },
  { name: "/inbox", reach: signedIn("/inbox", "rest"), ready: (page) => expect(page.getByRole("heading", { name: "Inbox" })).toBeVisible() },
  {
    name: "/settings",
    reach: signedIn("/settings", "rest"),
    ready: async (page) => {
      await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
      await entrancesSettled(page.locator(".st-pocket"));
    },
  },
  {
    name: "/settings/mail",
    reach: signedIn("/settings/mail", "rest"),
    ready: async (page) => {
      await expect(page.getByRole("heading", { name: "Your relay", level: 1 })).toBeVisible();
      await entrancesSettled(page.locator(".rl-pocket"));
    },
  },
  {
    name: "/administration",
    reach: signedIn("/administration", "any-dialect"),
    ready: async (page) => {
      await expect(page.getByRole("heading", { name: "Administration" })).toBeVisible();
      /* The heading draws before `view` has loaded (the cards below it are
         `{#if view}`-gated), so wait for the loading skeleton to clear, then
         for the cards' own entrance fades: a scan mid-fade reads a control's
         ink through its fading-in opacity and axe calls that a contrast
         violation that is gone a frame later (entrancesSettled's doc). */
      await expect(page.locator(".ad-loading")).toHaveCount(0);
      await entrancesSettled(page.locator(".ad-pocket"));
    },
  },
  {
    name: "/household/[id]",
    reach: signedIn("/household/hh-harlow-1", "any-dialect"),
    ready: async (page) => {
      await expect(page.getByRole("heading", { name: "Harlow Home" })).toBeVisible();
      await entrancesSettled(page.locator(".hh-pocket"));
    },
  },
  /* #1319 (owner-decisions section 34): the item is home's drawer: the desk's
     drawer under its row, or (under the 900px switch, so the tablet too) the
     pocket row's own panel, with its foot row of pills and icons. The state is
     the Car MOT's own address, `/home?item=i-mot`. */
  {
    name: "/home?item=<id>",
    reach: signedIn("/home", "noted-item"),
    ready: async (page) => {
      const drawer = page.locator('[id="i-mot-view"], .pocket .pk-below [data-row-key="i-mot"][data-open]').filter({ visible: true });
      await expect(drawer.getByRole("group", { name: "Actions for Car MOT — Volvo V60" })).toBeVisible();
      await page.locator("body[data-home-ready]").waitFor({ state: "attached" });
      /* a phone's row unfolds; measure it drawn */
      await entrancesSettled(drawer);
    },
  },
];

/**
 * Arrives on `screen` at the page's viewport, in `pack` where one is asked
 * for, and waits for the screen to be drawn.
 * @param {Page} page @param {Screen} screen @param {string} [pack]
 */
async function arrive(page, screen, pack) {
  if (pack) {
    await page.addInitScript((id) => {
      try { localStorage.setItem("orbit-theme", id); } catch { /* storage blocked: the check below says so */ }
    }, pack);
  }
  await screen.reach(page);
  await screen.ready(page);
}

/**
 * The desk's two edge drawers hang their handles a few pixels past the frame
 * on purpose (home.css `.handle{right:-31px}` and `left:-46px`: the tab is
 * drawn as part of a drawer standing just off-screen), measured at 3px and
 * 7px at 1440×900. How much of a handle shows is a design call, not this
 * check's, so these two may overhang the viewport by this much and no more;
 * every other control must sit wholly inside it.
 */
const DESIGNED_EDGE_OVERHANG = { selectors: ["#edge-health", "#keydrawer button.handle"], px: 8 };

/** Everything on the page that breaks the layout at this size: the document scrolling
 * sideways, a visible control outside the viewport, or a visible control cut off by an
 * ancestor that hides its horizontal overflow. A control inside a sideways scroll strip
 * (overflow-x auto/scroll) is a scroll away rather than out of reach, so it is the strip
 * that must sit inside the viewport; the vertical axis is the page's own scroll.
 * @param {Page} page @returns {Promise<string[]>} */
async function layoutProblems(page) {
  return page.evaluate((overhang) => {
    /** @type {string[]} */
    const problems = [];
    const root = document.documentElement;
    const width = root.clientWidth;
    if (root.scrollWidth > width + 1) {
      problems.push(`the document scrolls sideways: ${root.scrollWidth}px of content in a ${width}px viewport`);
    }
    const describe = (/** @type {Element} */ el) => {
      const name = el.getAttribute("aria-label") ?? (el.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 40);
      return `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ""}${el.classList.length ? `.${Array.from(el.classList).join(".")}` : ""} "${name}"`;
    };
    const controls = document.querySelectorAll(
      'a[href], button, input:not([type="hidden"]), select, textarea, [tabindex]:not([tabindex="-1"]), [role="button"], [role="link"], [role="switch"], [role="radio"], [role="tab"], [role="checkbox"]',
    );
    for (const el of Array.from(controls)) {
      if (el.closest('[aria-hidden="true"], [inert]')) continue;
      const rect = el.getBoundingClientRect();
      /* sr-only text and collapsed rows: nothing drawn to clip. */
      if (rect.width < 2 || rect.height < 2) continue;
      if (getComputedStyle(el).visibility === "hidden") continue;
      let drawn = true;
      for (let node = /** @type {Element | null} */ (el); node; node = node.parentElement) {
        const style = getComputedStyle(node);
        if (style.display === "none" || Number.parseFloat(style.opacity) === 0) { drawn = false; break; }
      }
      if (!drawn) continue;

      /* Walk up once: the first box that hides overflow and is narrower than
         the control cuts it off; the first sideways scroll strip ends the
         walk, since everything inside it is a scroll away. */
      /** @type {Element | null} */
      let strip = null;
      /** @type {Element | null} */
      let cutBy = null;
      for (let node = /** @type {Element | null} */ (el.parentElement); node && node !== document.body; node = node.parentElement) {
        const overflowX = getComputedStyle(node).overflowX;
        if (/auto|scroll/.test(overflowX)) { strip = node; break; }
        if (!/hidden|clip/.test(overflowX)) continue;
        const box = node.getBoundingClientRect();
        if (rect.left < box.left - 1 || rect.right > box.right + 1) { cutBy = node; break; }
      }

      const reach = (strip ?? el).getBoundingClientRect();
      const slack = overhang.selectors.some((selector) => el.matches(selector)) ? overhang.px : 1;
      if (reach.left < -slack || reach.right > width + slack) {
        problems.push(`${describe(el)}${strip ? " (in a scroll strip)" : ""} sits outside the ${width}px viewport (${Math.round(reach.left)} to ${Math.round(reach.right)})`);
      } else if (cutBy) {
        problems.push(`${describe(el)} is cut off by ${describe(cutBy).split(" ")[0]}`);
      }
    }
    return problems;
  }, DESIGNED_EDGE_OVERHANG);
}

/** Filed contrast faults each check allows (a11y-support.js
   KNOWN_CONTRAST_FAULTS), keyed "screen size" for the matrix and
   "screen pack" for the packs. Desk projects only: the matrix and the packs
   run nowhere else.
   @type {Record<string, string[]>} */
const KNOWN_FAULTS = {
};

const VIEWPORTS = [
  { name: "desktop", width: 1440, height: 900 },
  { name: "tablet", width: 820, height: 1180 },
  { name: "phone", width: 412, height: 915 },
];

test.describe("the signed-in v19 screens at every size and in every theme pack", () => {
  for (const viewport of VIEWPORTS) {
    for (const screen of SCREENS) {
      test(`${screen.name} at ${viewport.width}×${viewport.height} fits, keeps every control reachable, and has no WCAG A/AA violations`, async ({ page }, testInfo) => {
        test.skip(onPhone(testInfo), "the matrix sets its own viewports; the desk projects run it");
        /* Before the first navigation, so the dialect is chosen at this size. */
        await page.setViewportSize({ width: viewport.width, height: viewport.height });
        await arrive(page, screen);
        expect(await layoutProblems(page), `${screen.name} at ${viewport.name} size`).toEqual([]);
        await expectNoAxeViolations(page, `${screen.name} at ${viewport.name} size`, KNOWN_FAULTS[`${screen.name} ${viewport.width}`] ?? []);
      });
    }
  }

  for (const pack of THEME_PACKS.filter((id) => id !== DEFAULT_THEME)) {
    for (const screen of SCREENS) {
      test(`${screen.name} in the ${pack} pack has no WCAG A/AA violations`, async ({ page }, testInfo) => {
        /* Owner, 2026-10-14: the default theme is checked at every size (above);
           every other pack at one size, the desk projects'. */
        test.skip(onPhone(testInfo), "other packs are checked at one size; the desk projects run them");
        await arrive(page, screen, pack);
        /* The pack really is the one drawn, and its tokens resolved -- or a
           contrast pass would be measuring the default pack again. */
        await expect(page.locator("html")).toHaveAttribute("data-theme", pack);
        const tokens = await page.evaluate(() => {
          const style = getComputedStyle(document.documentElement);
          return ["--bg", "--ink"].map((name) => style.getPropertyValue(name).trim());
        });
        expect(tokens.every((value) => value.length > 0), `${pack}: --bg and --ink resolve`).toBe(true);
        await expectNoAxeViolations(page, `${screen.name} in ${pack}`, KNOWN_FAULTS[`${screen.name} ${pack}`] ?? []);
      });
    }
  }
});
