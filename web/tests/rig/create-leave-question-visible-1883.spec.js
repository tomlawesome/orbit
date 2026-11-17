import { expect, test } from "@playwright/test";

import { APP } from "../fidelity/pocket-states.js";

/*
 * #1883: the create page mounts the pocket form and the desk form together and
 * CSS shows one. Both hold unsaved text in the registry (web/src/lib/unsaved.js);
 * only a VISIBLE form may ask the leave question, and the layout's confirm
 * ("Discard this entry? What you've typed will be lost.") is the fallback that
 * is always on screen. Visibility is read at navigation time, so resizing back
 * and forth needs no syncing.
 *
 * Desktop browser projects only: the spec resizes the window itself.
 */
test.skip(({ isMobile }) => isMobile, "the spec resizes a desktop window between the two dialects");

const SETTLE = 20_000;
const NARROW = { width: 600, height: 900 };
const WIDE = { width: 1280, height: 900 };
const CONFIRM = "Discard this entry? What you've typed will be lost.";
const NAME = "Gutter clearing proving";

/** @param {import("@playwright/test").Page} page */
async function gotoCreate(page) {
  await page.goto(`${APP}/create`, { waitUntil: "load" });
  await page.locator("#card[data-ready]").waitFor({ state: "attached", timeout: SETTLE });
}

/** The phone's name field. @param {import("@playwright/test").Page} page */
const pocketName = (page) => page.getByRole("form", { name: "New entry" }).getByRole("textbox", { name: "name", exact: true });

/** Follows an in-app link through the router, whichever form is showing. @param {import("@playwright/test").Page} page */
const navigate = (page) => page.locator("a.cancel-link").evaluate((a) => /** @type {HTMLAnchorElement} */ (a).click());

/** Every native dialog, answered as told. @param {import("@playwright/test").Page} page @param {boolean} accept */
function answerDialogs(page, accept) {
  /** @type {string[]} */
  const asked = [];
  page.on("dialog", (dialog) => {
    asked.push(dialog.message());
    void (accept ? dialog.accept() : dialog.dismiss()).catch(() => {});
  });
  return asked;
}

/** Two painted frames after a navigation was handled. @param {import("@playwright/test").Page} page */
const handled = (page) => page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));

test("typed on narrow, then widened: leaving shows the layout's confirm; cancel keeps the page and the phone text", async ({ page }) => {
  const asked = answerDialogs(page, false);
  await page.setViewportSize(NARROW);
  await gotoCreate(page);
  await pocketName(page).fill(NAME);

  await page.setViewportSize(WIDE);
  await navigate(page);
  await expect.poll(() => asked, { message: "the layout's confirm was not shown" }).toEqual([CONFIRM]);
  await handled(page);
  await expect(page, "cancelling the confirm must keep the page").toHaveURL(/\/create(\?.*)?$/);
  await expect(page.getByText("Leave without adding?"), "the hidden pocket's callout must not be the question").not.toBeVisible();

  await page.setViewportSize(NARROW);
  await expect(pocketName(page)).toHaveValue(NAME);
});

test("typed on narrow, then widened: accepting the confirm navigates with no second prompt", async ({ page }) => {
  const asked = answerDialogs(page, true);
  await page.setViewportSize(NARROW);
  await gotoCreate(page);
  await pocketName(page).fill(NAME);

  await page.setViewportSize(WIDE);
  await navigate(page);
  await expect(page).toHaveURL(/\/home(\?.*)?$/, { timeout: SETTLE });
  await handled(page);
  expect(asked, "exactly one question, the layout's confirm").toEqual([CONFIRM]);
});

test("typed on narrow, widened and shrunk back: leaving shows the pocket's own callout, not the confirm", async ({ page }) => {
  const asked = answerDialogs(page, false);
  await page.setViewportSize(NARROW);
  await gotoCreate(page);
  await pocketName(page).fill(NAME);

  await page.setViewportSize(WIDE);
  await page.setViewportSize(NARROW);
  await navigate(page);
  await expect(page.getByText("Leave without adding?")).toBeVisible();
  await handled(page);
  expect(asked, "the native confirm must not run beside the callout").toEqual([]);
  await expect(page).toHaveURL(/\/create(\?.*)?$/);
});

test("typed in the desk form on wide, then shrunk: leaving shows the layout's confirm (the desk has no ask)", async ({ page }) => {
  const asked = answerDialogs(page, false);
  await page.setViewportSize(WIDE);
  await gotoCreate(page);
  await page.locator("#f-name").fill(NAME);

  await page.setViewportSize(NARROW);
  await navigate(page);
  await expect.poll(() => asked, { message: "the layout's confirm was not shown" }).toEqual([CONFIRM]);
  await handled(page);
  await expect(page.getByText("Leave without adding?")).not.toBeVisible();
  await expect(page).toHaveURL(/\/create(\?.*)?$/);
});
