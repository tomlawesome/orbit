import { expect, test } from "@playwright/test";

import { signedIn } from "./a11y-support.js";

/*
 * #1074: the account panel on an empty sky.
 *
 * The account panel is chrome, not household data: the avatar, Inbox,
 * Settings, the THEME row and sign-out belong to every reader on /home,
 * whether or not they are in a household. Both dialects draw all of it while
 * the sky is empty, so a reader who is adrift can see the whole menu.
 *
 * Seeing it is not the same as being able to use it. The empty-sky mount takes
 * a branch of its own, and only `mountHome`/`mountPocket` bind `button.orb`
 * and `#morb`: on the empty sky the orb had nothing listening and the panel
 * never opened. These two journeys are the reproduction #1074 was filed
 * without. They wait for home to say it is live (`body[data-home-ready]`,
 * #1064: a failure is "nothing is listening", never "the test was early"),
 * then work the panel: open it, change the theme, find sign-out, and walk out
 * of it onto /settings.
 *
 * Moved from tests/e2e (ADR-0039, #1611): the reader is `/home empty-sky`
 * (no household, five systems in the sky) in place of a throwaway household
 * deleted from under a signed-in session. Sign-out is not pressed.
 */

const SETTLE = 20_000;

/** The live theme, which both dialects' THEME rows write to <html>. @param {import("@playwright/test").Page} page */
const liveTheme = (page) => page.evaluate(() => document.documentElement.dataset.theme ?? null);

test("home (desk, empty sky): the account panel opens and its controls answer", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name.endsWith("phone"), "the desk dialect; the pocket has its own journey below");

  await signedIn("/home", "empty-sky")(page);
  await expect(page.getByRole("heading", { name: "you’re adrift" })).toBeVisible({ timeout: SETTLE });
  await page.waitForSelector("body[data-home-ready]", { timeout: SETTLE });

  /* The orb is drawn for this reader -- the panel's whole contents are chrome,
     not household data -- so the press below lands on something real. */
  const orb = page.locator("button.orb");
  const panel = page.locator("#account");
  await expect(orb).toBeVisible();
  await orb.click();
  await expect(panel).toHaveClass(/open/);
  await expect(orb).toHaveAttribute("aria-expanded", "true");
  await panel.evaluate((el) => Promise.all(el.getAnimations({ subtree: true }).map((a) => a.finished)));

  /* THEME answers: the swatch row is wired, not just painted. */
  await panel.locator(".swatches button[title='after dark']").click();
  await expect.poll(() => liveTheme(page)).toBe("afterdark");

  /* Sign-out is there and is one press (owner, 2026-10-06), so this does not press it. */
  const signout = panel.locator("button.signout");
  await expect(signout).toBeVisible();
  await expect(signout).toHaveText(/sign out/);

  /* And the panel is a way out of home, not an ornament. */
  await panel.getByRole("link", { name: "Settings" }).click();
  await expect(page).toHaveURL(/\/settings/);
});

test("home (pocket, empty sky): the account menu opens and its controls answer", async ({ page }, testInfo) => {
  test.skip(!testInfo.project.name.endsWith("phone"), "the pocket dialect; the desk has its own journey above");

  await signedIn("/home", "empty-sky")(page);
  await expect(page.locator(".mgroup.adrift")).toBeVisible({ timeout: SETTLE });
  await page.waitForSelector("body[data-home-ready]", { timeout: SETTLE });

  const morb = page.locator("#morb");
  /* #1120: the pocket's account menu is the kit's hatch, a sheet portalled to
     the end of <body>; its layer wears `open` while it is up. */
  const menu = page.locator('.p-sheet-layer:has(nav[aria-label="Go to"])');
  await expect(morb).toBeVisible();
  await morb.click();
  await expect(menu).toHaveClass(/open/);
  await expect(morb).toHaveAttribute("aria-expanded", "true");
  await menu.evaluate((el) => Promise.all(el.getAnimations({ subtree: true }).map((a) => a.finished)));

  await menu.locator("button.swatch[title='after dark']").click();
  await expect.poll(() => liveTheme(page)).toBe("afterdark");

  /* Sign-out is there and is one tap (owner, 2026-10-06), so this does not tap it. */
  await expect(menu.getByRole("button", { name: /sign out/ })).toBeVisible();

  await menu.getByRole("link", { name: "Settings" }).click();
  await expect(page).toHaveURL(/\/settings/);
});
