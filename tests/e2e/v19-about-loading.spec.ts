import { expect, test, type Page, type Route } from "@playwright/test";
import { settleArrival } from "./support/arrival";
import { claimInstanceAsAdministrator } from "./support/bootstrap";
import { resetDatabaseBetweenSpecFiles } from "./support/database";
import { sessionHeaders } from "./support/households";
import { seedHousehold } from "./support/signed-in";
import { answerPushWithoutAService } from "./support/webkit-push";
import { workerAccount } from "./support/worker-identity";

/* #1077: back to the stack's own seed before this file's setup runs. */
resetDatabaseBetweenSpecFiles();

/**
 * About shows that it is loading (#1465): a click on About that takes time
 * must put a visible loading indication on screen before the content
 * arrives, rather than leaving the reader looking at the old screen with
 * nothing to say the click was heard. Same sign-in and menu route as
 * v19-about.spec.ts; the slowness is made by holding back the page's data
 * request (the client-side `__data.json` the navigation reads) and the
 * `/api/about` read until the test lets them go.
 *
 * Runs on every project v19-about.spec.ts does, so desk and pocket both.
 */

/* #1502: both tests hold requests with `page.route`, and Playwright does not
   route a request a page controlled by a service worker makes (its
   documentation says to block service workers wherever routing is relied
   on; the same cause as #1219 in v19-hit-routing.spec.ts). Orbit's worker
   registers a little after the first page and controls pages loaded once it
   is active, so on a slow start /settings was sometimes controlled: the
   About data request then went past the hold, the navigation finished at
   once and there was never a wait to show a sign for (the 10 s timeout).
   The loading sign does not depend on the worker, so it is kept out. */
test.use({ serviceWorkers: "block" });

/** The account menu this width draws: the desk's card, or the pocket's hatch. */
async function openMenu(page: Page, phone: boolean) {
  if (!phone) {
    await page.locator("button.orb").click();
    return page.locator("#account");
  }
  await page.locator("button.porb").click();
  const hatch = page.locator('.p-sheet-layer:has(nav[aria-label="Go to"])');
  await expect(hatch).toHaveClass(/open/);
  return hatch;
}

async function signInAs(page: Page, account: string) {
  await answerPushWithoutAService(page);
  await page.goto("/api/auth/login?returnTo=/home");
  await page.getByRole("link", { name: account }).click();
  await settleArrival(page);
}

/* Owner-only half of the cleanup, as v19-about.spec.ts does. */
async function scheduleHouseholdDeletion(page: Page, householdId: string, name: string) {
  const response = await page.request.post(`/api/households/${householdId}/lifecycle`, {
    headers: await sessionHeaders(page),
    data: { action: "delete", confirmation: name },
  });
  if (response.status() === 404 || response.status() === 409) return;
  if (!response.ok()) throw new Error(`#1465: could not schedule cleanup of "${name}" (${response.status()})`);
}

/**
 * Any visible sign that something is loading: an element marked busy, a
 * progress bar, or a status line / text that says "loading". Assumed, not
 * confirmed by an existing test -- the fix may draw it as it likes so long
 * as one of these describes it.
 */
function loadingIndication(page: Page) {
  return page
    .locator('[aria-busy="true"]')
    .or(page.getByRole("progressbar"))
    .or(page.getByRole("status").filter({ hasText: /loading/i }))
    .or(page.getByText(/^\s*loading/i))
    .first();
}

test("a slow click on About shows that it is loading before the content arrives", async ({ page, browser, isMobile }) => {
  test.setTimeout(120_000);
  await claimInstanceAsAdministrator(browser);
  await signInAs(page, workerAccount("member"));
  const household = await seedHousehold(page, "AboutLoading");

  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const held: string[] = [];
  const hold = async (route: Route) => {
    held.push(new URL(route.request().url()).pathname);
    await gate;
    await route.continue().catch(() => {});
  };

  try {
    await page.goto("/settings");
    /* #1125: on a phone settings is its own layout and the desk's .cards are display:none. */
    await expect(page.locator(isMobile ? ".st-pocket .p-card" : ".helm-page .cards").first()).toBeVisible({ timeout: 30_000 });
    /* The first-run tour, if a stack still shows it, is dismissed as the other specs do. */
    await page.keyboard.press("Escape");

    const about = (await openMenu(page, isMobile)).getByRole("link", { name: "About" });
    await expect(about).toBeVisible();

    expect(
      await page.evaluate(() => navigator.serviceWorker?.controller ?? null),
      "#1502: a page a service worker controls is not routed, so nothing would be held",
    ).toBeNull();
    await page.route("**/api/about*", hold);
    await page.route("**/about/__data.json*", hold);
    await about.click();

    /* The click was heard: something says so while the data is still held. */
    await expect(loadingIndication(page)).toBeVisible({ timeout: 10_000 });
    /* ...and it is a real wait, not a flash: the content has not arrived. */
    await expect(page.locator(".about-page").getByRole("heading", { level: 2, name: "This Orbit" })).toBeHidden();
    expect(held.length, "the About data request was held back").toBeGreaterThan(0);

    release();

    await expect(page).toHaveURL(/\/about$/);
    await expect(page.locator(".about-page").getByRole("heading", { level: 2, name: "This Orbit" })).toBeVisible({ timeout: 30_000 });
    /* Once the content is there the loading indication goes. */
    await expect(loadingIndication(page)).toHaveCount(0, { timeout: 30_000 });
  } finally {
    release();
    await page.unroute("**/api/about*").catch(() => {});
    await page.unroute("**/about/__data.json*").catch(() => {});
    await scheduleHouseholdDeletion(page, household.id, household.name);
  }
});

/*
 * A screen reader announces text that is put INTO a live region, and often
 * says nothing for a region that arrives already filled. So the region that
 * will carry "Loading" must be in the page, and empty, before the click.
 */
test("the loading announcement goes into a live region that was already on the page, empty", async ({ page, browser, isMobile }) => {
  test.setTimeout(120_000);
  await claimInstanceAsAdministrator(browser);
  await signInAs(page, workerAccount("member"));
  const household = await seedHousehold(page, "AboutAnnounce");

  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const hold = async (route: Route) => {
    await gate;
    await route.continue().catch(() => {});
  };

  try {
    /* Same starting page as the test above: on the pocket's home the hatch's
       About link is not clickable for this script (the click waits out the
       test timeout), while from settings it is on both widths. */
    await page.goto("/settings");
    await expect(page.locator(isMobile ? ".st-pocket .p-card" : ".helm-page .cards").first()).toBeVisible({ timeout: 30_000 });
    await page.keyboard.press("Escape");

    const about = (await openMenu(page, isMobile)).getByRole("link", { name: "About" });
    await expect(about).toBeVisible();

    /* Every live region on the page now, with what each says now. Assumed
       identification: role="status" or aria-live="polite" (or an <output>). */
    const regions = await page.locator('[role="status"], [aria-live="polite"], output').elementHandles();
    const textOf = async (region: (typeof regions)[number]) => ((await region.textContent().catch(() => "")) ?? "").trim();
    const before = await Promise.all(regions.map(textOf));

    expect(
      await page.evaluate(() => navigator.serviceWorker?.controller ?? null),
      "#1502: a page a service worker controls is not routed, so nothing would be held",
    ).toBeNull();
    await page.route("**/api/about*", hold);
    await page.route("**/about/__data.json*", hold);
    await about.click();

    /* The same element -- not a new one -- comes to say "Loading". */
    let announcer = -1;
    await expect
      .poll(async () => {
        const now = await Promise.all(regions.map(textOf));
        announcer = now.findIndex((text) => /loading/i.test(text));
        return announcer;
      }, { message: "no live region that was on the page before the click came to say Loading", timeout: 10_000 })
      .toBeGreaterThanOrEqual(0);
    expect(before[announcer], "the region that announces Loading must have been empty before the click").toBe("");
  } finally {
    release();
    await page.unroute("**/api/about*").catch(() => {});
    await page.unroute("**/about/__data.json*").catch(() => {});
    await scheduleHouseholdDeletion(page, household.id, household.name);
  }
});
