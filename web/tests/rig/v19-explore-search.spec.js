import { expect, test } from "@playwright/test";

import { APP } from "../fidelity/pocket-states.js";
import { completeLikeTheEngine, ownWorkspace } from "./own-writes.js";

/*
 * #1161, "C · unrolled" (design/v19/search/round-1/BUILD.md): `#explore` and
 * the strip that draws above it, replacing POL-9's command palette. The pure
 * filter (name/section/provider/document text, top match) is pocket-search.js's
 * own `searchPocket`, proved directly in tests/unit/pocket-home.test.mjs; this
 * spec proves the desk wires it up: typing filters the strip's matches, arrow
 * keys and hover move the selection, Enter opens the selected entry, and the
 * note line's two acts (#1162) complete the closest thing due and add an item.
 * Desk only: the phone's search is its own sheet (ratified round 1 B).
 *
 * `#strip` is the SVG's own wrapper (aria-hidden), `#strip-note` the note line
 * under it, `#explore-results` the accessible read of the same results (a
 * `role="listbox"` of `role="option"` `li`s): the ids BUILD.md section 4 names.
 *
 * Moved from tests/e2e (ADR-0039, #1609). The two seeded items of the stack
 * suite are the fixture workspace's Harlow Home (fixtures/workspace.js, today
 * 2026-08-13):
 *   - title only            "volvo"        Car MOT -- Volvo V60 (i-mot)
 *   - section               "vehicles"     i-mot and i-svc, soonest first
 *   - provider              "british gas"  Boiler service (i-boiler)
 *   - the closest thing due                i-mot, 16 days out (i-gutter is overdue)
 */

const MOT = { id: "i-mot", title: "Car MOT — Volvo V60" };
const SERVICE = { id: "i-svc", title: "Car full service" };
const BOILER = { id: "i-boiler", title: "Boiler service" };

/* A held or aborted request is a `page.route`, which a request from a page
   Orbit's service worker controls skips on WebKit (#1196, #1235). Nothing in
   the tests that use it is about the worker, so on WebKit it is kept out. */
const KEEP_THE_WORKER_OFF_ON_WEBKIT = {
  serviceWorkers: async ({}, use, testInfo) => {
    await use(testInfo.project.use.defaultBrowserType === "webkit" ? "block" : "allow");
  },
};

/** @param {import("@playwright/test").Page} page */
async function atHome(page) {
  await page.goto(`${APP}/home`, { waitUntil: "load" });
  /* The markup is drawn before home's listeners are bound (#1064): typing in
     that gap is heard by nobody. Wait for the screen to be able to answer. */
  await expect(page.locator("body[data-home-ready]")).toBeAttached();
}

test.beforeEach(() => {
  test.skip(test.info().project.name.includes("phone"), "#explore's strip is the desk half; the phone has its own sheet");
});

test("typing in #explore filters the results by title, section and provider", async ({ page }) => {
  await atHome(page);
  const explore = page.locator("#explore");
  const results = page.locator("#explore-results");

  // Title.
  await explore.fill("volvo");
  await expect(results).toContainText(MOT.title);
  await expect(results).not.toContainText(BOILER.title);

  // Section: the household's own section carries the query.
  await explore.fill("vehicles");
  await expect(results).toContainText(MOT.title);
  await expect(results).toContainText(SERVICE.title);
  await expect(results).not.toContainText(BOILER.title);

  // Provider.
  await explore.fill("british gas");
  /* #explore-results is the screen reader's copy (visually hidden); what the
     eye sees is the strip's one mark. */
  await expect(results.getByRole("option").filter({ hasText: BOILER.title })).toHaveCount(1);
  await expect(page.locator("#strip .match")).toHaveCount(1);
  await expect(page.locator("#strip")).toBeVisible();

  // A query nothing answers.
  await explore.fill("no such orbit thing zzz");
  await expect(page.locator("#strip-note")).toContainText(`nothing in your orbit is called "no such orbit thing zzz"`);
});

test("Enter in #explore opens the top matched item", async ({ page }) => {
  await atHome(page);
  const explore = page.locator("#explore");
  await explore.fill("volvo");
  await explore.press("Enter");

  await expect(page).toHaveURL(new RegExp(`item=${MOT.id}`));
  await expect(page.locator(`[id="${MOT.id}"]`)).toBeVisible();
  await expect(page.locator(`[id="${MOT.id}"]`)).toContainText(MOT.title);
});

test("#strip is not visible before #explore is focused", async ({ page }) => {
  await atHome(page);
  await expect(page.locator("#strip")).toBeHidden();
});

test("#strip never draws below the field, even on a short viewport", async ({ page }) => {
  /* BUILD.md section 3: at 1536x730 the strip's top sits at about y=506, clear
     of the sun but with little headroom: the shortest window the desk dialect
     actually runs at (901px is the pocket/desk breakpoint). */
  await page.setViewportSize({ width: 1536, height: 730 });
  await atHome(page);
  const explore = page.locator("#explore");
  await explore.fill("mo"); // matches "Car MOT": draws at least one mark
  const strip = page.locator("#strip");
  await expect(strip).toBeVisible();

  const stripBox = await strip.boundingBox();
  const exploreBox = await explore.boundingBox();
  expect(stripBox).not.toBeNull();
  expect(exploreBox).not.toBeNull();
  if (stripBox && exploreBox) {
    expect(stripBox.y).toBeGreaterThanOrEqual(0);
    expect(stripBox.y + stripBox.height).toBeLessThanOrEqual(exploreBox.y);
  }
});

test("ArrowRight steps the strip's selection and Enter opens the selected entry", async ({ page }) => {
  await atHome(page);
  const explore = page.locator("#explore");
  await explore.fill("vehicles"); // both items, soonest (the MOT) first
  const items = page.locator("#explore-results li");
  await expect(items).toHaveCount(2);

  await explore.press("ArrowRight");
  await expect(items.nth(1)).toHaveAttribute("aria-selected", "true");

  await explore.press("Enter");
  await expect(page).toHaveURL(new RegExp(`item=${SERVICE.id}`));
  await expect(page.locator(`[id="${SERVICE.id}"]`)).toContainText(SERVICE.title);
});

test("hovering a mark selects it", async ({ page }) => {
  await atHome(page);
  const explore = page.locator("#explore");
  await explore.fill("vehicles"); // both items, so there is a second mark to hover
  const marks = page.locator("#strip .match");
  await expect(marks).toHaveCount(2);

  /* Hover the mark's own body (drawn last in its group), as a reader does: the
     group's box also spans the gap up to its label, and that empty middle is
     the SVG's, not the mark's. */
  await marks.nth(1).locator(":scope > :last-child").hover({ timeout: 10_000 });
  await expect(page.locator("#explore-results li").nth(1)).toHaveAttribute("aria-selected", "true");
});

/*
 * #1162: the note line's own two acts, BUILD.md left inert by #1161 and wired
 * up here: "complete" the closest thing due and "add" an item, by mouse and by
 * keyboard, through the same completeCommand/applyCommand and /create the rest
 * of the app already uses (item page, pocket-search).
 */

test("clicking the note line's add act, at rest, opens /create", async ({ page }) => {
  await atHome(page);
  await page.locator("#explore").focus();
  const addAct = page.locator("#strip-note .act", { hasText: "add an item" });
  await expect(addAct).toBeVisible();
  await addAct.click();

  await expect(page).toHaveURL(/\/create$/);
});

test("Enter on the no-match add act carries the typed name to /create", async ({ page }) => {
  await atHome(page);
  const explore = page.locator("#explore");
  await explore.fill("no such orbit thing zzz");
  await expect(page.locator("#strip-note")).toContainText('add "no such orbit thing zzz" as an item');
  /* The no-match branch's only entry is the add act, so the default selection
     (index 0) is already it: the same "Enter opens the selected entry" wiring
     the matched-item cases above prove. */
  await explore.press("Enter");

  await expect(page).toHaveURL(/\/create\?name=/);
  await expect(page.locator("#f-name")).toHaveValue("no such orbit thing zzz");
});

test("clicking the note line's complete act arms then fires, completing the closest item", async ({ page }) => {
  /* The fixture app keeps nothing, so the completion is answered here: the
     next due date a period on, as the engine works it out. */
  const writes = await ownWorkspace(page, { "item.complete": completeLikeTheEngine });
  await atHome(page);
  await page.locator("#explore").focus();
  /* Order matches stripActsOf: "complete" before "add" (BUILD.md section 1). */
  const completeAct = page.locator("#strip-note .act").first();
  await expect(completeAct).toHaveText(`→ complete "${MOT.title}"`);

  await completeAct.click();
  await expect(completeAct).toHaveText(`tap again to complete "${MOT.title}"`);

  await completeAct.click();
  // The strip closes on fire and the view re-reads with the new orbit.
  await expect(page.locator("#strip")).toBeHidden();
  expect(writes.sent("item.complete").map((one) => one.itemId)).toEqual([MOT.id]);
  /* 2026-08-29 a year on is 2027-08-29: 381 days from the fixture's today. */
  await expect(page.locator(`[id="${MOT.id}"]`)).toContainText(/T−381d/);
});

test.describe(() => {
  test.use(KEEP_THE_WORKER_OFF_ON_WEBKIT);

  /* #1584 web-home-1: the strip shuts when the complete lands, so a failed read
     of home after it cannot be said on the strip's own line (hidden with the
     strip). It is said in the wake, as the done line (landed.js), and the
     command is not read back as refused. */
  test("the strip's complete that lands while the read of home fails says the done line in the wake", async ({ page }) => {
    const writes = await ownWorkspace(page, { "item.complete": completeLikeTheEngine });
    await atHome(page);
    await page.locator("#explore").focus();
    const completeAct = page.locator("#strip-note .act").first();
    await expect(completeAct).toHaveText(`→ complete "${MOT.title}"`);
    await completeAct.click();
    await expect(completeAct).toHaveText(`tap again to complete "${MOT.title}"`);

    /* the home read only: /api/workspace/commands (the command POST) is another path */
    const homeRead = (/** @type {URL} */ url) => url.pathname === "/api/workspace";
    await page.route(homeRead, (route) => route.abort("connectionfailed"));
    await completeAct.click();

    await expect(page.locator("#strip")).toBeHidden();
    await expect(page.locator('.p-wake-host [role="status"]')).toHaveText(/^done — .*reload/, { timeout: 10_000 });
    await expect(page.locator('.p-wake-host [role="alert"]')).toHaveText("");
    await expect(page.getByText(/couldn.t complete it/)).toHaveCount(0);

    /* the command landed; only the screen was stale */
    expect(writes.sent("item.complete").map((one) => one.itemId)).toEqual([MOT.id]);
    await page.unroute(homeRead);
    await page.reload();
    await expect(page.locator(`[id="${MOT.id}"]`)).toContainText(/T−381d/);
  });
});
