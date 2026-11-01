import { expect, test } from "@playwright/test";

import { renderedFrames } from "../../../tests/e2e/support/frames";
import { SETTLE } from "../../../tests/e2e/support/settle";
import { APP, onPhone, signedIn } from "./a11y-support.js";

/** @typedef {import("@playwright/test").Locator} Locator */
/** @typedef {import("@playwright/test").Page} Page */

/*
 * #1473, moved to the rig (ADR-0039, #1610): while the first-run tour plays,
 * the page is paused as a whole.
 *
 * The bug: on the pocket home the account menu button still opened the menu
 * during the tour, but the tour's click catcher (#orbit-tour-catch) sat over
 * the menu's links and took every press -- a menu that looked usable and did
 * nothing. The decision for the fix is the standard modal-walkthrough
 * pattern: everything outside the current tour step is inert (the `inert`
 * attribute), the menu opener included, so the menu cannot be opened while
 * the tour plays. Never a state where the menu opens with dead links.
 *
 * Asserted by what a reader sees, not by the mechanism: the opener is there,
 * the tour is on, pressing the opener (by pointer, by finger and by keyboard)
 * does not bring the menu's links up; once the tour is skipped the same press
 * opens the menu and About reaches /about. Timeouts are short on purpose so a
 * failure reports in seconds, not after Playwright's long action wait.
 *
 * Every test starts from the fixture state `/home` / `film-rest` (a household
 * whose tour record says "never taken", the film held at its first chapter
 * through its own review hook), so nothing is signed into, seeded or reset.
 * The stack version let the film run; this holds it, which is the same
 * veil, catch pane and transport, and keeps a press from racing a chapter.
 */
test.use({ baseURL: APP, reducedMotion: "reduce" });

const SHORT = 3_000;

/**
 * The account menu opener this width draws: the desk's orb, or the pocket's.
 * @param {Page} page @param {boolean} phone
 */
function opener(page, phone) {
  return phone ? page.locator("#morb") : page.locator("button.orb");
}

/**
 * The account menu this width draws: the desk's card, or the pocket's hatch.
 * @param {Page} page @param {boolean} phone
 */
function menuOf(page, phone) {
  return phone ? page.locator('.p-sheet-layer:has(nav[aria-label="Go to"])') : page.locator("#account");
}

/**
 * Makes a press and waits until the page has taken it in: a capturing
 * listener on the window records the `event` the press produces (a click for
 * a pointer, a touchend for a finger, a keydown for the keyboard), and the
 * page then draws two frames, by which time whatever the press set off in its
 * own scripts has run. "The menu did not open" is then judged after the page
 * has handled the press, not after a guess at how long that takes.
 * @param {Page} page
 * @param {"click" | "touchend" | "keydown"} event
 * @param {() => Promise<unknown>} press
 */
async function pressAndLetThePageTakeItIn(page, event, press) {
  await page.evaluate((type) => {
    const seen = /** @type {any} */ (window);
    seen.__pressSeen = 0;
    addEventListener(type, () => { seen.__pressSeen += 1; }, { capture: true, once: true });
  }, event);
  await press();
  await page.waitForFunction(() => /** @type {any} */ (window).__pressSeen >= 1, undefined, { timeout: SETTLE });
  await renderedFrames(page);
}

/**
 * Lands on /home with the tour on, then hands the test the parts.
 * @param {Page} page
 * @param {boolean} phone
 * @param {(parts: { orb: Locator, menu: Locator, about: Locator, transport: Locator }) => Promise<void>} body
 */
async function withTourPlaying(page, phone, body) {
  await signedIn("/home", "film-rest")(page);

  /* Positive checks first: the tour really is on and the opener really is
     there, so the absence asserted afterwards means something. */
  const transport = page.locator("#orbit-tour-transport");
  await expect(transport).toBeVisible({ timeout: 30_000 });
  await expect(page.locator("#orbit-tour-veil")).toBeAttached({ timeout: SHORT });
  const orb = opener(page, phone);
  await expect(orb).toBeAttached();
  const menu = menuOf(page, phone);
  await body({ orb, menu, about: menu.getByRole("link", { name: "About" }), transport });
}

test("a pointer press on the menu opener does nothing while the tour plays", async ({ page }, testInfo) => {
  await withTourPlaying(page, onPhone(testInfo), async ({ orb, about }) => {
    /* force skips Playwright's wait for the opener to be hittable (what burnt
       120 s in the report); the press goes to whatever is on top at that spot. */
    await pressAndLetThePageTakeItIn(page, "click", () => orb.click({ force: true, timeout: SETTLE }));
    await expect(about, "#1473: the menu opened while the tour plays").toBeHidden({ timeout: SHORT });
  });
});

test("a touch on the menu opener does nothing while the tour plays", async ({ page }, testInfo) => {
  test.skip(!onPhone(testInfo), "the finger is the pocket's pointer; the desk is covered by the press above");
  await withTourPlaying(page, true, async ({ orb, about }) => {
    const box = await orb.boundingBox();
    if (!box) throw new Error("the menu opener has no box to touch");
    /* touchend, not click: the tour's catch pane cancels the touch, so no
       click is ever made from it, and the capturing listener still sees the
       touchend before the pane does. */
    await pressAndLetThePageTakeItIn(page, "touchend", () => page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2));
    await expect(about, "#1473: the menu opened by touch while the tour plays").toBeHidden({ timeout: SHORT });
  });
});

test("the menu opener cannot be operated by keyboard while the tour plays", async ({ page }, testInfo) => {
  await withTourPlaying(page, onPhone(testInfo), async ({ orb, about }) => {
    /* An inert control cannot take focus, so Enter on it does nothing either. */
    await orb.evaluate((el) => el.focus());
    await pressAndLetThePageTakeItIn(page, "keydown", () => page.keyboard.press("Enter"));
    await expect(about, "#1473: the menu opened by keyboard while the tour plays").toBeHidden({ timeout: SHORT });
  });
});

test("the menu opener sits in an inert part of the page while the tour plays", async ({ page }, testInfo) => {
  await withTourPlaying(page, onPhone(testInfo), async ({ orb }) => {
    /* The standard modal pattern: the opener is inert itself or inside an inert ancestor. */
    expect(await orb.evaluate((el) => !!el.closest("[inert]")), "#1473: the menu opener is not inert while the tour plays").toBe(true);
  });
});

test("after the tour is skipped the menu opens and About reaches /about", async ({ page }, testInfo) => {
  await withTourPlaying(page, onPhone(testInfo), async ({ orb, menu, about, transport }) => {
    /* Skip, through the pill's own button. Skipping records the tour as taken:
       this test's own write, answered as the server answers it. */
    await page.route("**/api/settings/tour", (route) =>
      route.request().method() === "PUT"
        ? route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ tour: { tourSeenAt: "2026-11-01T09:00:00.000Z" } }) })
        : route.fallback());
    await transport.locator(".skp").click({ timeout: SHORT });
    await expect(page.locator("#orbit-tour-veil")).toBeHidden({ timeout: SHORT });
    await expect(page.locator("#orbit-tour-catch")).toHaveCount(0, { timeout: 10_000 });

    /* Nothing is inert any more, the menu opens, About is pressable. */
    expect(await orb.evaluate((el) => !!el.closest("[inert]")), "the opener is still inert after the tour").toBe(false);
    await orb.click({ timeout: 10_000 });
    await expect(menu).toHaveClass(/open/, { timeout: 10_000 });
    await expect(about).toBeVisible({ timeout: SHORT });
    await about.click({ timeout: 10_000 });
    await expect(page).toHaveURL(/\/about$/, { timeout: 10_000 });
  });
});
