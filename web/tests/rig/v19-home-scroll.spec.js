import { expect, test } from "@playwright/test";

import { settled } from "../../../tests/e2e/support/keyboard";
import { APP, onPhone, rememberWrites, RIG_EXPECT_MS, RIG_TEST_MS, signedIn } from "./a11y-support.js";

/** @typedef {import("@playwright/test").Page} Page */

/*
 * #1249, moved to the rig (ADR-0039, #1611): after adding an item, "← YOUR
 * SKY" brought the owner back to a sky that would not scroll down to the
 * manifest (Firefox, desktop). Every way back to home after a save is walked
 * here, and each ends the same way: the reader turns the wheel and the
 * manifest arrives.
 *
 * The stack suite signed in and seeded a household; here the reader is the
 * fixture's, the state `/create` / `saves-kept` asks the fixture server to
 * keep this browser's save (so home's own load, read on the server, finds the
 * new item), and the save itself is this test's own write (rememberWrites).
 */
test.use({ baseURL: APP });
test.describe.configure({ timeout: RIG_TEST_MS });

test.beforeEach(({}, testInfo) => {
  test.skip(onPhone(testInfo), "the desk's sky and manifest; the pocket scrolls its own sheet");
});

/** Adds an item through the desk's create form; the save lands on /home.
 * @param {Page} page @param {string} name */
async function addItem(page, name) {
  await rememberWrites(page);
  await signedIn("/create", "saves-kept")(page);
  await page.locator("#f-name").fill(name);
  await page.getByRole("group", { name: /^section/ }).getByRole("button", { name: "Home" }).click();
  await page.locator("#f-date").fill("2026-09-12");
  await page.locator(".btn-primary").click();
  await expect(page).toHaveURL(/\/home(\?item=[^&]+)?$/);
  await expect(page.locator(".item", { hasText: name })).toBeVisible({ timeout: RIG_EXPECT_MS });
}

/** The owner's gesture: the wheel over the sky, until the manifest is in view.
 * @param {Page} page */
async function wheelToManifest(page) {
  await settled(page);
  const viewport = page.viewportSize();
  await page.mouse.move((viewport?.width ?? 1280) / 2, (viewport?.height ?? 800) / 2);
  const manifest = page.locator("#manifest-top");
  await expect(async () => {
    await page.mouse.wheel(0, 600);
    await expect(manifest).toBeInViewport({ timeout: 500 });
  }).toPass({ timeout: 10_000 });
}

test("after a save, the sky scrolls down to the manifest", async ({ page }) => {
  await addItem(page, "Scroll after save");
  await wheelToManifest(page);
});

/* #1319 (owner-decisions section 34): the belt is gone: the item's address is
   home with its drawer open, and the item's way back is putting that drawer
   away. Both are walked here, as a bookmark to that address would. */
test("after a save, the item's address and its drawer's way back return to a sky that scrolls", async ({ page }) => {
  await addItem(page, "Scroll via item");
  /* the save lands with the new row already open (`/home?item=`) */
  const id = new URL(page.url()).searchParams.get("item");
  expect(id, "the save did not land on the new item's address").toBeTruthy();
  await page.goto(`${APP}/home?item=${id}`);
  await expect(page).toHaveURL(new RegExp(`/home\\?item=${id}$`));
  const drawer = page.locator(`[id="${id}-view"]`);
  await expect(drawer).toBeVisible({ timeout: RIG_EXPECT_MS });
  await page.keyboard.press("Escape");
  await expect(drawer).toHaveCount(0);
  await expect(page).toHaveURL(/\/home$/);
  await wheelToManifest(page);
});

test("after a save, the create page's way back returns to a sky that scrolls", async ({ page }) => {
  await addItem(page, "Scroll via create");
  await page.goto(`${APP}/create`);
  await page.locator("#card[data-ready]").waitFor({ state: "attached" });
  await page.getByRole("link", { name: "← YOUR SKY" }).click();
  await expect(page).toHaveURL(/\/home$/);
  await wheelToManifest(page);
});
