import { expect, test } from "@playwright/test";

import { APP, onPhone, signedIn } from "./a11y-support.js";

/** @typedef {import("@playwright/test").Page} Page */
/** @typedef {import("@playwright/test").Route} Route */

/*
 * ABOUT SHOWS THAT IT IS LOADING (#1465), moved to the rig (ADR-0039, #1611)
 * from tests/e2e/v19-about-loading.spec.ts.
 *
 * A click on About that takes time must put a visible loading indication on
 * screen before the content arrives, rather than leaving the reader looking at
 * the old screen with nothing to say the click was heard. The slowness is made
 * by holding back the page's data request (the client-side `__data.json` the
 * navigation reads) and the `/api/about` read until the test lets them go; the
 * fixture answers both once released. Starts from /settings, as the stack
 * version did; desk and pocket both.
 *
 * #1502: Playwright does not route a request a page controlled by a service
 * worker makes, so the worker is blocked: the loading sign does not depend on it.
 */
test.use({ baseURL: APP, serviceWorkers: "block" });

/**
 * The account menu this width draws: the desk's card, or the pocket's hatch.
 * @param {Page} page @param {boolean} phone
 */
async function openMenu(page, phone) {
  if (!phone) {
    await page.locator("button.orb").click();
    return page.locator("#account");
  }
  await page.locator("button.porb").click();
  const hatch = page.locator('.p-sheet-layer:has(nav[aria-label="Go to"])');
  await expect(hatch).toHaveClass(/open/);
  return hatch;
}

/**
 * Any visible sign that something is loading: an element marked busy, a
 * progress bar, or a status line / text that says "loading".
 * @param {Page} page
 */
function loadingIndication(page) {
  return page
    .locator('[aria-busy="true"]')
    .or(page.getByRole("progressbar"))
    .or(page.getByRole("status").filter({ hasText: /loading/i }))
    .or(page.getByText(/^\s*loading/i))
    .first();
}

/**
 * Holds the About data requests until `release()`.
 * @param {Page} page
 */
async function holdAbout(page) {
  /** @type {() => void} */
  let release = () => {};
  const gate = new Promise((resolve) => { release = () => resolve(undefined); });
  /** @type {string[]} */
  const held = [];
  /** @param {Route} route */
  const hold = async (route) => {
    held.push(new URL(route.request().url()).pathname);
    await gate;
    await route.continue().catch(() => {});
  };
  await page.route("**/api/about*", hold);
  await page.route("**/about/__data.json*", hold);
  return { held, release };
}

test("a slow click on About shows that it is loading before the content arrives", async ({ page }, testInfo) => {
  const phone = onPhone(testInfo);
  await signedIn("/settings", "any-dialect")(page);

  const about = (await openMenu(page, phone)).getByRole("link", { name: "About" });
  await expect(about).toBeVisible();

  expect(
    await page.evaluate(() => navigator.serviceWorker?.controller ?? null),
    "#1502: a page a service worker controls is not routed, so nothing would be held",
  ).toBeNull();
  const { held, release } = await holdAbout(page);
  try {
    await about.click();

    /* The click was heard: something says so while the data is still held. */
    await expect(loadingIndication(page)).toBeVisible();
    /* ...and it is a real wait, not a flash: the content has not arrived. */
    await expect(page.locator(".about-page").getByRole("heading", { level: 2, name: "This Orbit" })).toBeHidden();
    expect(held.length, "the About data request was held back").toBeGreaterThan(0);

    release();

    await expect(page).toHaveURL(/\/about$/);
    await expect(page.locator(".about-page").getByRole("heading", { level: 2, name: "This Orbit" })).toBeVisible();
    /* Once the content is there the loading indication goes. */
    await expect(loadingIndication(page)).toHaveCount(0);
  } finally {
    release();
  }
});

/*
 * A screen reader announces text that is put INTO a live region, and often
 * says nothing for a region that arrives already filled. So the region that
 * will carry "Loading" must be in the page, and empty, before the click.
 */
test("the loading announcement goes into a live region that was already on the page, empty", async ({ page }, testInfo) => {
  const phone = onPhone(testInfo);
  await signedIn("/settings", "any-dialect")(page);

  const about = (await openMenu(page, phone)).getByRole("link", { name: "About" });
  await expect(about).toBeVisible();

  /* Every live region on the page now, with what each says now. Assumed
     identification: role="status" or aria-live="polite" (or an <output>). */
  const regions = await page.locator('[role="status"], [aria-live="polite"], output').elementHandles();
  const textOf = async (/** @type {(typeof regions)[number]} */ region) => ((await region.textContent().catch(() => "")) ?? "").trim();
  const before = await Promise.all(regions.map(textOf));

  expect(
    await page.evaluate(() => navigator.serviceWorker?.controller ?? null),
    "#1502: a page a service worker controls is not routed, so nothing would be held",
  ).toBeNull();
  const { release } = await holdAbout(page);
  try {
    await about.click();

    /* The same element -- not a new one -- comes to say "Loading". */
    let announcer = -1;
    await expect
      .poll(async () => {
        const now = await Promise.all(regions.map(textOf));
        announcer = now.findIndex((text) => /loading/i.test(text));
        return announcer;
      }, { message: "no live region that was on the page before the click came to say Loading" })
      .toBeGreaterThanOrEqual(0);
    expect(before[announcer], "the region that announces Loading must have been empty before the click").toBe("");
  } finally {
    release();
  }
});
