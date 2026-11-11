import AxeBuilder from "@axe-core/playwright";
import { expect as baseExpect, test } from "@playwright/test";

import { APP, onPhone, RIG_EXPECT_MS, RIG_TEST_MS, settle, signedIn, withDecorationHidden, withoutKnownFaults } from "./a11y-support.js";

/* The rig's waits (a11y-support.js RIG_EXPECT_MS, RIG_TEST_MS): the stack's explicit long waits are gone with its sign-in, but the host is shared. */
const expect = baseExpect.configure({ timeout: RIG_EXPECT_MS });
test.describe.configure({ timeout: RIG_TEST_MS });

/*
 * #496, moved to the rig (ADR-0039, #1609): a full axe sweep across every
 * signed-in route, in both dialects. signed-out.spec.ts:119-128 covers the
 * door itself; this picks up everything behind it.
 *
 * `/home` draws one of two dialects chosen by viewport (the gravity-well dial
 * on a desk, the pocket dial on a phone); the other routes are dialect-blind
 * but run in both projects, which costs little and is never wrong. Each test
 * asserts one route or one overlay state, so a failing axe rule points at
 * what was on screen. Where a violation is real the assertion is left failing,
 * never filtered or skipped.
 *
 * Each test starts from a fixture state (../fidelity/pocket-states.js) or the
 * fixture route's own address; no sign-in, no household seeded.
 */

const WCAG_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"];

/*
 * The station backdrop's layers (`$lib/backdrops/station.js`) are pure
 * decoration and already `aria-hidden`: constellation names, "0 ITEMS"
 * satellite captions, bearing marks. axe still measures their contrast, and
 * WCAG 1.4.3 exempts decorative text, so they are excluded here rather than
 * lifted -- the chart pen is faint on purpose.
 */
const DECORATIVE_BACKDROP = '.layer[aria-hidden="true"]';

/**
 * @param {import("@playwright/test").Page} page
 * @param {string} [state] what was on screen, for the failure message
 * @param {string[]} [known] filed contrast faults this state still shows
 *   (a11y-support.js withoutKnownFaults); each must still be there
 */
async function axeCheck(page, state, known = []) {
  const results = await withDecorationHidden(page, () => new AxeBuilder({ page })
    .withTags(WCAG_TAGS)
    .exclude(DECORATIVE_BACKDROP)
    .analyze());
  const { violations, gone } = withoutKnownFaults(results.violations, known);
  expect(violations, state).toEqual([]);
  expect(gone.map((issue) => `${issue} no longer found: take it off this check's known faults`), state).toEqual([]);
}

/** The household page, as the fixtures know it. */
const HOUSEHOLD = "/household/hh-harlow-1";

test.describe("the signed-in v19 sweep", () => {
  test("/home has no automated WCAG A/AA violations", async ({ page }) => {
    await signedIn("/home", "rest")(page);
    await axeCheck(page);
  });

  /* `button.orb`, `#nstar`, `#edge-health` and `#keydrawer` are the DESKTOP
     chrome (home.css scopes them under `.desk`); the pocket dialect draws its
     own account trigger (`#morb`, pocket.svelte) and has no drawers of its own
     at all, so there is nothing there for axe to examine on that dialect. */
  test("/home account panel open has no automated WCAG A/AA violations", async ({ page }, testInfo) => {
    test.skip(onPhone(testInfo), "the account panel is desk-only chrome; the pocket dialect has no drawers");
    await signedIn("/home", "rest")(page);
    await page.locator("button.orb").click();
    await expect(page.locator("button.orb")).toHaveAttribute("aria-expanded", "true");
    await axeCheck(page);
  });

  /* #852: the pocket dialect's own account menu, the phone mirror of the desk
     `button.orb`/`#account` state above. `#morb` and the kit's hatch (#1120)
     are the pocket dialect's own trigger and panel. */
  test("/home pocket account menu open has no automated WCAG A/AA violations", async ({ page }, testInfo) => {
    test.skip(!onPhone(testInfo), "#morb and the hatch are pocket-only chrome; the desk dialect's own state is covered above");
    await signedIn("/home", "rest")(page);
    await page.locator("#morb").click();
    await expect(page.locator("#morb")).toHaveAttribute("aria-expanded", "true");
    await axeCheck(page);
  });

  test("/home add-to-orbit drawer open has no automated WCAG A/AA violations", async ({ page }, testInfo) => {
    test.skip(onPhone(testInfo), "the create drawer is desk-only chrome; the pocket dialect has no drawers");
    await signedIn("/home", "rest")(page);
    await page.locator("#nstar").click();
    await expect(page.locator("#nstar")).toHaveAttribute("aria-expanded", "true");
    await axeCheck(page);
  });

  test("/home system-status drawer open has no automated WCAG A/AA violations", async ({ page }, testInfo) => {
    test.skip(onPhone(testInfo), "the status drawer is desk-only chrome; the pocket dialect has no drawers");
    await signedIn("/home", "rest")(page);
    await page.locator("#edge-health").click();
    await expect(page.locator("#edge-health")).toHaveAttribute("aria-expanded", "true");
    await axeCheck(page);
  });

  /* The chart-key drawer only exists once the reader belongs to a household
     (`{#if !view?.emptySky}`, web/src/routes/home/+page.svelte); the fixture
     workspace has five. */
  test("/home chart-key drawer open has no automated WCAG A/AA violations", async ({ page }, testInfo) => {
    test.skip(onPhone(testInfo), "the key drawer is desk-only chrome; the pocket dialect has no drawers");
    await signedIn("/home", "rest")(page);
    const handle = page.locator("#keydrawer button.handle");
    await handle.click();
    await expect(handle).toHaveAttribute("aria-expanded", "true");
    await axeCheck(page);
  });

  /* The first-run walk, held at its first chapter: the fixture state
     `/home` / `film-rest` answers the tour record "never taken" and pauses the
     film through its own review hooks. */
  test("/home first-run tour overlay has no automated WCAG A/AA violations", async ({ page }, testInfo) => {
    /* The original skipped the phone ("the film has no pocket cut", §24), which
       #1083 made untrue (2026-09-30): the pocket cut ships, and the fixture
       state reaches it. Both projects sweep it. */
    void testInfo;
    await signedIn("/home", "film-rest")(page);
    const transport = page.locator("#orbit-tour-transport");
    await expect(transport).toBeVisible();
    /* film.js's own review hook for the chapter index: 0 is where a fresh film
       always opens. */
    await expect
      .poll(() => page.evaluate(() => /** @type {any} */ (window).__reading?.().chapter))
      .toBe(0);

    await axeCheck(page);

    await page.keyboard.press("Escape");
    await expect(page.locator("#orbit-tour-veil")).toBeHidden();
  });

  /** @type {{ path: string, state?: string, title?: string, ready: (page: import("@playwright/test").Page, phone: boolean) => Promise<unknown> }[]} */
  const PLAIN_ROUTES = [
    { path: "/inbox", ready: (page) => expect(page.getByRole("heading", { name: "Inbox" })).toBeVisible() },
    /* #1120: the form's one exposed name field -- the desk card's `#f-name`,
       or on a phone the pocket's own form (proposal §2.5); the other
       dialect's is hidden. */
    { path: "/create", ready: (page) => expect(page.getByRole("textbox", { name: "name", exact: true })).toBeVisible() },
    /* #1120: on a phone, settings and its relay draw their own pocket screens,
       whose cards rise in (st-rise, rl-rise); measure them drawn, not through
       the entrance's fading opacity (`settle` waits the finite ones out). On
       the desk those roots are display:none and hold no animations. */
    {
      path: "/settings",
      ready: async (page, phone) => {
        await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
        /* #1195: on desktop Safari /settings once drew only its header and
           axe's own `.analyze()` then hung scanning the blanked page; asserting
           the desk's own cards exist turns that hang into a bounded, catchable
           failure. True on every desktop engine, scoped off the phone, whose
           dialect has no `.cards`. */
        if (!phone) await expect(page.locator(".cards")).toBeVisible();
        await settle(page);
      },
    },
    /* #1509: the relay is the Mail card's `your relay` tab, reached by #mail;
       each dialect draws its own card and hides the other's. */
    {
      path: "/settings",
      state: "mail",
      title: "/settings#mail (the relay tab)",
      ready: async (page) => {
        await expect(page.getByRole("tab", { name: "your relay", exact: true })).toHaveAttribute("aria-selected", "true");
        await settle(page);
      },
    },
    {
      path: "/administration",
      ready: (page) => expect(page.getByRole("heading", { name: "Administration" })).toBeVisible(),
    },
  ];

  for (const route of PLAIN_ROUTES) {
    test(`${route.title ?? route.path} has no automated WCAG A/AA violations`, async ({ page }, testInfo) => {
      /* The phone's `rest` states for these two routes wait for pocket-only
         elements (administration `.ad-pocket`, create `#pocket-entry`, both
         hidden on a desk), so a desk takes the states both dialects reach. */
      const desk = !onPhone(testInfo);
      const shared = route.path === "/administration" || route.path === "/create";
      await signedIn(route.path, route.state ?? (desk && shared ? "any-dialect" : "rest"))(page);
      await route.ready(page, onPhone(testInfo));
      await axeCheck(page, undefined, []);
    });
  }

  test("/household/[id] has no automated WCAG A/AA violations", async ({ page }) => {
    await signedIn(HOUSEHOLD, "any-dialect")(page);
    await expect(page.getByRole("heading", { name: "Harlow Home" })).toBeVisible();
    /* #1122: on a phone the household's cards rise in; measure them drawn, not
       through the entrance's fading opacity. */
    await settle(page);
    await axeCheck(page, undefined, []);
  });

  /* #1319 (owner-decisions §34): the item is home's drawer, so the item screen
     is home with that drawer open: swept as it opens, with a document's preview
     up beside it (the bottom sheet on a phone), and with its rows in edit and
     the chooser up (the due date's calendar). */
  test("/home with an item's drawer open, its preview up, then its chooser up, has no automated WCAG A/AA violations", async ({ page }, testInfo) => {
    test.setTimeout(60_000);
    /* The preview and the chooser slide in; sweep them drawn, not mid-fade. */
    await page.emulateMedia({ reducedMotion: "reduce" });
    /* The fixture's Car MOT carries two papers (fixtures/workspace.js). */
    await page.goto(`${APP}/home?item=i-mot`, { waitUntil: "load" });
    const drawer = onPhone(testInfo)
      ? page.locator('.pocket .pk-below [data-row-key="i-mot"]')
      : page.locator('[id="i-mot-view"]');
    await expect(drawer.getByRole("group", { name: "Actions for Car MOT — Volvo V60" })).toBeVisible();
    await page.locator("body[data-home-ready]").waitFor({ state: "attached" });
    await axeCheck(page, "the drawer open");

    await drawer.getByRole("button", { name: "Open MOT certificate 2025" }).click();
    const preview = page.getByRole("dialog", { name: /^MOT certificate 2025/ });
    await expect(preview.getByRole("button", { name: "Read MOT certificate 2025" })).toBeEnabled();
    await expect(preview.getByRole("img", { name: "Page one of MOT certificate 2025" })).toBeVisible();
    await axeCheck(page, "the drawer open, its document's preview up");
    await page.keyboard.press("Escape");
    await expect(preview).toHaveCount(0);

    await drawer.getByRole("button", { name: "Edit this item" }).click();
    await drawer.getByRole("button", { name: /^due: / }).click();
    await expect(page.getByRole("dialog", { name: /due date/i })).toBeVisible();
    await axeCheck(page, "the drawer editing, the chooser up", []);
  });
});
