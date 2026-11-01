import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

import { APP, door, onPhone } from "./a11y-support.js";

/*
 * The maintenance page people actually see (#526; ADR-0013), moved to the rig
 * (ADR-0039, #1610): what the screen shows and how it behaves in a browser.
 *
 * The screen is `/maintenance`, which under the fixture app renders a known
 * window (src/lib/data/fixtures/maintenance.js): three entries by default, the
 * one-entry state at `?entries=one`. The fixture's words are the stack
 * version's own, so the assertions read the same.
 *
 * What the server answers while a window is open (the 503 at the URL asked,
 * no-store, Retry-After, the arrival closed, /login and /logout open, the
 * administrator passing, a member shown the screen) is in
 * tests/unit/hooks-server-maintenance-screens.test.mjs (#1612); the API's
 * envelope in tests/integration/maintenance-guard.test.ts. What stays on the
 * stack, in tests/e2e/maintenance.spec.ts, is the window itself end to end:
 * ending it reopens the instance at the same URL.
 */
test.use({ baseURL: APP });

const STARTED = "We are moving Orbit to new storage. Documents and mail are paused while everything copies across.";
const HALFWAY = "The copy is about halfway. Still on track for the time below.";
const VERIFYING = "Verifying the copied documents before we reopen.";

test("one entry reads well on its own: no arrow, no drawer", async ({ page }) => {
  await page.goto("/maintenance?entries=one");
  await expect(page.getByRole("heading", { name: "maintenance — back soon" })).toBeVisible();
  await expect(page.getByText(VERIFYING)).toBeVisible();
  await expect(page.getByText("back by")).toBeVisible();
  await expect(page.locator("details")).toHaveCount(0);
});

test("newest first, and the earlier entries open from the keyboard", async ({ page }) => {
  await door("maintenance", "rest")(page);
  await expect(page.getByText(VERIFYING)).toBeVisible();
  await expect(page.getByText(STARTED)).toBeHidden();

  const arrow = page.getByRole("group").locator("summary");
  await expect(arrow).toHaveAccessibleName("Earlier updates");
  await arrow.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByText(HALFWAY)).toBeVisible();
  await expect(page.getByText(STARTED)).toBeVisible();

  const bodies = await page.locator(".body").allTextContents();
  expect(bodies).toEqual([VERIFYING, HALFWAY, STARTED]);
});

test("the screen has no automated WCAG A or AA violations, drawer open", async ({ page }) => {
  await door("maintenance", "earlier-open")(page);
  await expect(page.getByText(STARTED)).toBeVisible();

  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();

  expect(results.violations).toEqual([]);
});

test("the screen fits the mobile viewport, drawer open", async ({ page }, testInfo) => {
  test.skip(!onPhone(testInfo), "the phone's width is the subject; the desk has nothing to overflow");
  await door("maintenance", "earlier-open")(page);
  await expect(page.getByText(STARTED)).toBeVisible();
  const viewport = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }));
  expect(viewport.scrollWidth).toBe(viewport.clientWidth);
});
