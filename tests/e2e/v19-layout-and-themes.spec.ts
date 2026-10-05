import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { resetDatabaseBetweenSpecFiles } from "./support/database";
import { entrancesSettled } from "./support/motion";
import {
  axeViolations,
  cleanup,
  seedHousehold,
  settleHome,
  signIn,
  type Household,
} from "./support/signed-in";

/* #1077: back to the stack's own seed before this file's setup runs. */
resetDatabaseBetweenSpecFiles();

/* The roster, read from its one home (web/src/lib/theme.js, #865) so a sixth
   pack is swept the day it lands. Parsed rather than imported: web/src holds
   no TypeScript and the root tsconfig sets allowJs false, so `pnpm typecheck`
   cannot type an import of it. tests/unit/v19-theme-roster.test.mjs holds the
   module to the same two literals this reads. */
const THEME_SOURCE = readFileSync(resolve(__dirname, "../../web/src/lib/theme.js"), "utf8");
const THEME_PACKS: string[] = JSON.parse(/export const THEME_PACKS = (\[[^\]]*\]);/.exec(THEME_SOURCE)?.[1] ?? "[]");
const DEFAULT_THEME = /export const DEFAULT_THEME = "([\w-]+)";/.exec(THEME_SOURCE)?.[1];
if (THEME_PACKS.length < 2 || !DEFAULT_THEME) throw new Error("#1178: could not read the theme roster from web/src/lib/theme.js");

/**
 * #1178: what authenticated-accessibility.spec.ts checked across viewports
 * and themes before the Next.js removal (8a315e18), ported to the v19
 * screens.
 *
 * 1. THE VIEWPORT MATRIX. Every signed-in v19 screen at the three sizes the
 *    old spec used -- 1440×900, 820×1180 and 412×915 -- with no
 *    document-level sideways scroll, every visible control inside the
 *    viewport and not cut off by a box that hides its overflow, and no axe
 *    WCAG A/AA violation at that size. 820 is the interesting one: it is
 *    under the dialect switch (max-width:900px, $lib/pocket/media.js), so a
 *    tablet gets the pocket screens drawn at nearly twice a phone's width.
 *    The matrix sets its own viewports, so it runs in the desktop project
 *    only, as the old spec's did ("one browser context runs the explicit
 *    desktop, tablet and phone matrix").
 *
 * 2. THE THEME PACKS. Every pack on the v1.3.0 roster (web/src/lib/theme.js,
 *    imported so a sixth pack is swept the day it lands) on every screen,
 *    with axe's WCAG A/AA rules -- colour contrast is the one a pack can
 *    break -- in both dialects, since the pocket screens carry their own
 *    per-pack rules (lib/pocket/tokens.css). The default pack is already
 *    swept on every screen by v19-axe-sweep.spec.ts, so it is not run twice.
 *    The pack is chosen the way the swatches choose it (settings/+page.svelte
 *    `pickPack`): `orbit-theme` in localStorage, read by app.html's
 *    pre-paint script.
 *
 *    The old spec also ran every Orbit text-size setting. v19 stores
 *    `textSize` (PUT /api/preferences) but no screen applies it, so there is
 *    nothing for a check to measure; that is a product gap, reported with
 *    #1178, not a check left out.
 */

type Screen = {
  name: string;
  /** "item" seeds a household with one item; "household" one without. */
  seed?: "household" | "item";
  path: (household?: Household) => string;
  ready: (page: Page, household?: Household) => Promise<unknown>;
};

const SCREENS: Screen[] = [
  { name: "/home", seed: "household", path: () => "/home", ready: (page) => settleHome(page) },
  /* #1120: the one exposed name field of whichever dialect is showing. */
  { name: "/create", path: () => "/create", ready: (page) => expect(page.getByRole("textbox", { name: "name", exact: true })).toBeVisible() },
  { name: "/inbox", path: () => "/inbox", ready: (page) => expect(page.getByRole("heading", { name: "Inbox" })).toBeVisible() },
  {
    name: "/settings",
    path: () => "/settings",
    ready: async (page) => {
      await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
      await entrancesSettled(page.locator(".st-pocket"));
    },
  },
  {
    name: "/settings/mail",
    path: () => "/settings/mail",
    ready: async (page) => {
      await expect(page.getByRole("heading", { name: "Your relay", level: 1 })).toBeVisible();
      await entrancesSettled(page.locator(".rl-pocket"));
    },
  },
  {
    name: "/administration",
    path: () => "/administration",
    ready: async (page) => {
      await expect(page.getByRole("heading", { name: "Administration" })).toBeVisible();
      /* The heading draws before `view` has loaded (the cards below it are
         `{#if view}`-gated, pocket.svelte's own loading skeleton otherwise),
         so waiting on the heading alone can leave the real cards — and
         their own entrance fades — still to come. Wait for the loading
         skeleton to clear first, so entrancesSettled below catches every
         entrance already under way rather than snapshotting an empty page
         a beat too early. */
      await expect(page.locator(".ad-loading")).toHaveCount(0);
      /* The tells, the jump strip's chips and every card below fade and
         slide in on arrival (pocket.svelte's .ad-tell/.ad-chip/.ad-card),
         same as the other pocket screens below — a scan mid-fade reads a
         control's ink through its own fading-in opacity and axe calls that
         a contrast violation that is gone a frame later (entrancesSettled's
         own doc comment). */
      await entrancesSettled(page.locator(".ad-pocket"));
    },
  },
  {
    name: "/household/[id]",
    seed: "household",
    path: (household) => `/household/${household?.id}`,
    ready: async (page, household) => {
      await expect(page.getByRole("heading", { name: household?.name })).toBeVisible();
      await entrancesSettled(page.locator(".hh-pocket"));
    },
  },
  {
    name: "/item/[id]",
    seed: "item",
    path: (household) => `/item/${household?.itemId}`,
    ready: (page, household) => expect(page.getByRole("heading", { name: household?.itemTitle })).toBeVisible(),
  },
];

/**
 * Signs in and arrives on `screen`, seeding its household first where it
 * needs one. Sign-in, a seed, the settle and an axe pass over a chart-heavy
 * screen outrun 30s on the capped stack, so every test gets the sweep's 60s.
 */
async function arrive(page: Page, screen: Screen): Promise<Household | undefined> {
  test.setTimeout(60_000);
  if (!screen.seed) {
    await signIn(page, screen.path());
    await screen.ready(page);
    return undefined;
  }
  await signIn(page, "/home");
  const household = await seedHousehold(page, "layout-themes", { withItem: screen.seed === "item" });
  await page.goto(screen.path(household));
  await screen.ready(page, household);
  return household;
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

/**
 * Everything on the page that breaks the layout at this size: the document
 * scrolling sideways, a visible control outside the viewport, or a visible
 * control cut off by an ancestor that hides its horizontal overflow. A
 * control inside a sideways scroll strip (overflow-x auto/scroll -- the
 * pocket's pack swatches, the system chips) is a scroll away rather than
 * out of reach, so it is the strip that must sit inside the viewport; and
 * the vertical axis is the page's own scroll.
 */
async function layoutProblems(page: Page): Promise<string[]> {
  return page.evaluate((overhang) => {
    const problems: string[] = [];
    const root = document.documentElement;
    const width = root.clientWidth;
    if (root.scrollWidth > width + 1) {
      problems.push(`the document scrolls sideways: ${root.scrollWidth}px of content in a ${width}px viewport`);
    }
    const describe = (el: Element) => {
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
      for (let node: Element | null = el; node; node = node.parentElement) {
        const style = getComputedStyle(node);
        if (style.display === "none" || Number.parseFloat(style.opacity) === 0) { drawn = false; break; }
      }
      if (!drawn) continue;

      /* Walk up once: the first box that hides overflow and is narrower than
         the control cuts it off; the first sideways scroll strip ends the
         walk, since everything inside it is a scroll away. */
      let strip: Element | null = null;
      let cutBy: Element | null = null;
      for (let node = el.parentElement; node && node !== document.body; node = node.parentElement) {
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

/* Real contrast failures the pack sweep found, left failing rather than
   excluded (#1178's report lists them for filing). Keyed "screen pack project". */
const ZERO_ON_LIGHT_PACK =
  "DEFECT (#1178): the desk household archive card's \"never in the file\" (small.zero, household.css:448) is drawn in "
  + "--warm (#c06a12), which fails 4.5:1 on the light packs; --warm-text is the pack's darker text shade for exactly this";
const PACK_DEFECTS: Record<string, string> = {
  "/household/[id] clouds desktop-chromium": ZERO_ON_LIGHT_PACK,
  "/household/[id] dawn desktop-chromium": ZERO_ON_LIGHT_PACK,
  /* #1183: the same .zero contrast failure, found again by desktop-firefox. */
  "/household/[id] clouds desktop-firefox": ZERO_ON_LIGHT_PACK,
  "/household/[id] dawn desktop-firefox": ZERO_ON_LIGHT_PACK,
  /* #1219: and by desktop-webkit (pipeline 2131), the same rule on the same
     node in ten runs of ten in the pinned Playwright image. */
  "/household/[id] clouds desktop-webkit": ZERO_ON_LIGHT_PACK,
  "/household/[id] dawn desktop-webkit": ZERO_ON_LIGHT_PACK,
};

const VIEWPORTS = [
  { name: "desktop", width: 1440, height: 900 },
  { name: "tablet", width: 820, height: 1180 },
  { name: "phone", width: 412, height: 915 },
];

test.describe("the signed-in v19 screens at every size and in every theme pack", () => {
  /*
   * #840, as in the sweep: an administrator with no household anywhere on
   * the instance is sent to the arrival instead of returnTo, and the plain
   * screens here sign in straight to themselves. One anchor household kept
   * up for the whole file is enough to let them through.
   */
  let anchor: { id: string; name: string };

  test.beforeAll(async ({ browser }) => {
    const context = await browser.newContext({ ignoreHTTPSErrors: true });
    const page = await context.newPage();
    await signIn(page, "/home");
    anchor = await seedHousehold(page, "layout-themes-anchor");
    await context.close();
  });

  test.afterAll(async ({ browser }) => {
    const context = await browser.newContext({ ignoreHTTPSErrors: true });
    const page = await context.newPage();
    await signIn(page, "/home");
    await cleanup(page, anchor);
    await context.close();
  });

  for (const viewport of VIEWPORTS) {
    for (const screen of SCREENS) {
      test(`${screen.name} at ${viewport.width}×${viewport.height} fits, keeps every control reachable, and has no WCAG A/AA violations`, async ({ page }) => {
        test.skip(test.info().project.name.startsWith("mobile"), "the matrix sets its own viewports; the desktop project runs it");
        /* Before the first navigation, so the dialect is chosen at this size. */
        await page.setViewportSize({ width: viewport.width, height: viewport.height });
        const household = await arrive(page, screen);
        try {
          expect(await layoutProblems(page), `${screen.name} at ${viewport.name} size`).toEqual([]);
          expect(await axeViolations(page), `${screen.name} at ${viewport.name} size`).toEqual([]);
        } finally {
          if (household) await cleanup(page, household);
        }
      });
    }
  }

  for (const pack of THEME_PACKS.filter((id) => id !== DEFAULT_THEME)) {
    for (const screen of SCREENS) {
      test(`${screen.name} in the ${pack} pack has no WCAG A/AA violations`, async ({ page }) => {
        const defect = PACK_DEFECTS[`${screen.name} ${pack} ${test.info().project.name}`];
        test.fail(Boolean(defect), defect);
        await page.addInitScript((id: string) => {
          try { localStorage.setItem("orbit-theme", id); } catch { /* storage blocked: the check below says so */ }
        }, pack);
        const household = await arrive(page, screen);
        try {
          /* The pack really is the one drawn, and its tokens resolved -- or
             a contrast pass would be measuring the default pack again. */
          await expect(page.locator("html")).toHaveAttribute("data-theme", pack);
          const tokens = await page.evaluate(() => {
            const style = getComputedStyle(document.documentElement);
            return ["--bg", "--ink"].map((name) => style.getPropertyValue(name).trim());
          });
          expect(tokens.every((value) => value.length > 0), `${pack}: --bg and --ink resolve`).toBe(true);
          expect(await axeViolations(page), `${screen.name} in ${pack}`).toEqual([]);
        } finally {
          if (household) await cleanup(page, household);
        }
      });
    }
  }
});
