import { expect, test, type Locator, type Page } from "@playwright/test";
import { cleanupHousehold, sessionHeaders } from "./support/households";
import { homeIsLive } from "./support/keyboard";
import { resetDatabaseBetweenSpecFiles } from "./support/database";
import { seedHousehold, signIn } from "./support/signed-in";
import { renderedFrames } from "./support/frames";

/* #1077: back to the stack's own seed before this file's setup runs. */
resetDatabaseBetweenSpecFiles();

/**
 * #1473: while the first-run tour plays, the page is paused as a whole.
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
 * the tour is playing, pressing the opener (by pointer and by keyboard) does
 * not bring the menu's links up; once the tour is skipped the same press
 * opens the menu and About reaches /about. Timeouts are short on purpose so a
 * failure reports in seconds, not after Playwright's long action wait.
 */

test.use({ reducedMotion: "reduce" });

const SHORT = 3_000;

/** The account menu opener this width draws: the desk's orb, or the pocket's. */
function opener(page: Page, phone: boolean) {
  return phone ? page.locator("#morb") : page.locator("button.orb");
}

/** The account menu this width draws: the desk's card, or the pocket's hatch. */
function menuOf(page: Page, phone: boolean) {
  return phone ? page.locator('.p-sheet-layer:has(nav[aria-label="Go to"])') : page.locator("#account");
}

/**
 * Makes a press and waits until the page has taken it in: a capturing
 * listener on the window records the `event` the press produces (a click for
 * a pointer or a finger, a keydown for the keyboard), and the page then draws
 * two frames, by which time whatever the press set off in its own scripts has
 * run. "The menu did not open" is then judged after the page has handled the
 * press, not after a guess at how long that takes.
 */
async function pressAndLetThePageTakeItIn(page: Page, event: "click" | "keydown", press: () => Promise<void>) {
  await page.evaluate((type) => {
    const seen = window as unknown as { __pressSeen: number };
    seen.__pressSeen = 0;
    addEventListener(type, () => { seen.__pressSeen += 1; }, { capture: true, once: true });
  }, event);
  await press();
  await page.waitForFunction(() => (window as unknown as { __pressSeen: number }).__pressSeen >= 1, undefined, { timeout: 20_000 });
  await renderedFrames(page);
}

/** Puts the tour record back to "never taken" through the product's own route. */
async function forgetTheWalk(page: Page) {
  const response = await page.request.put("/api/settings/tour", {
    headers: await sessionHeaders(page),
    data: { tourSeenAt: null },
  });
  if (!response.ok()) throw new Error(`clearing the tour record failed: ${response.status()} ${await response.text()}`);
}

/** Signs in, seeds a household, forgets the walk and lands on /home with the tour playing. */
async function withTourPlaying(page: Page, isMobile: boolean, body: (parts: { orb: Locator; menu: Locator; about: Locator; transport: Locator }) => Promise<void>) {
  await signIn(page, "/inbox");
  await page.waitForLoadState("networkidle");
  const household = await seedHousehold(page, "tour-inert");
  try {
    await forgetTheWalk(page);
    await page.goto("/home");
    await homeIsLive(page);

    /* Positive checks first: the tour really is playing and the opener really
       is there, so the absence asserted afterwards means something. */
    const transport = page.locator("#orbit-tour-transport");
    await expect(transport).toBeVisible({ timeout: 30_000 });
    await expect(page.locator("#orbit-tour-veil")).toBeAttached({ timeout: SHORT });
    const orb = opener(page, isMobile);
    await expect(orb).toBeAttached();
    const menu = menuOf(page, isMobile);
    await body({ orb, menu, about: menu.getByRole("link", { name: "About" }), transport });
  } finally {
    await cleanupHousehold(page, await sessionHeaders(page), household.id, household.name);
  }
}

test("a pointer press on the menu opener does nothing while the tour plays", async ({ page, isMobile }) => {
  test.setTimeout(90_000);
  await withTourPlaying(page, isMobile, async ({ orb, about }) => {
    /* force skips Playwright's wait for the opener to be hittable (what burnt
       120 s in the report); the press goes to whatever is on top at that spot. */
    await pressAndLetThePageTakeItIn(page, "click", () => orb.click({ force: true, timeout: 20_000 }));
    await expect(about, "#1473: the menu opened while the tour plays").toBeHidden({ timeout: SHORT });
  });
});

test("a touch on the menu opener does nothing while the tour plays", async ({ page, isMobile }) => {
  test.skip(!isMobile, "the finger is the pocket's pointer; the desk is covered by the press above");
  test.setTimeout(90_000);
  await withTourPlaying(page, isMobile, async ({ orb, about }) => {
    const box = await orb.boundingBox();
    if (!box) throw new Error("the menu opener has no box to touch");
    await pressAndLetThePageTakeItIn(page, "click", () => page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2));
    await expect(about, "#1473: the menu opened by touch while the tour plays").toBeHidden({ timeout: SHORT });
  });
});

test("the menu opener cannot be operated by keyboard while the tour plays", async ({ page, isMobile }) => {
  test.setTimeout(90_000);
  await withTourPlaying(page, isMobile, async ({ orb, about }) => {
    /* An inert control cannot take focus, so Enter on it does nothing either. */
    await orb.evaluate((el) => el.focus());
    await pressAndLetThePageTakeItIn(page, "keydown", () => page.keyboard.press("Enter"));
    await expect(about, "#1473: the menu opened by keyboard while the tour plays").toBeHidden({ timeout: SHORT });
  });
});

test("the menu opener sits in an inert part of the page while the tour plays", async ({ page, isMobile }) => {
  test.setTimeout(90_000);
  await withTourPlaying(page, isMobile, async ({ orb }) => {
    /* The standard modal pattern: the opener is inert itself or inside an inert ancestor. */
    expect(await orb.evaluate((el) => !!el.closest("[inert]")), "#1473: the menu opener is not inert while the tour plays").toBe(true);
  });
});

test("after the tour is skipped the menu opens and About reaches /about", async ({ page, isMobile }) => {
  test.setTimeout(90_000);
  await withTourPlaying(page, isMobile, async ({ orb, menu, about, transport }) => {
    /* Skip, through the pill's own button. */
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
