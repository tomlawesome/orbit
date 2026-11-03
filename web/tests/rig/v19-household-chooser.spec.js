import { expect, test } from "@playwright/test";

import { tabTo } from "../../../tests/e2e/support/keyboard";
import { APP, onPhone, RIG_EXPECT_MS, RIG_TEST_MS, signedIn } from "./a11y-support.js";

/*
 * #1338 (household pick-lists, design call 2026-10-10), moved to the rig
 * (ADR-0039, #1611): on the desk household screen an owner's time zone
 * (#hhzone) and currency (#hhcur) are buttons that open a chooser card -- a
 * filter box over a listbox with the favourites first -- not a native select
 * and not a bottom sheet. This walks the card by keyboard alone: open, filter,
 * choose, dismiss, move, click away.
 *
 * The household is the fixture's Harlow Home (the reader owns it); nothing is
 * saved, so there is no write to answer.
 */
test.use({ baseURL: APP });
test.describe.configure({ timeout: RIG_TEST_MS });

test.beforeEach(({ viewport }, testInfo) => {
  test.skip(onPhone(testInfo) || (viewport?.width ?? 0) < 1200, "desk household screen only; a phone draws its own sheet");
});

test("the desk household picker is the chooser card, by keyboard (#1338)", async ({ page }) => {
  await signedIn("/household/hh-harlow-1", "any-dialect")(page);
  const zone = page.locator("#hhzone");
  const currency = page.locator("#hhcur");
  await expect(zone).toBeVisible({ timeout: RIG_EXPECT_MS });
  await expect(zone).toHaveJSProperty("tagName", "BUTTON");
  await expect(currency).toHaveJSProperty("tagName", "BUTTON");
  await expect(zone).toHaveAttribute("aria-expanded", "false");
  const listbox = page.getByRole("listbox");
  const zoneFilter = page.getByRole("searchbox", { name: "Find a time zone" });
  const currencyFilter = page.getByRole("searchbox", { name: "Find a currency" });

  // 1. Tab to the time zone, Enter: the card opens with focus in its filter.
  await tabTo(page, { selector: "#hhzone" }, { screen: "household, time zone" });
  await page.keyboard.press("Enter");
  await expect(zone).toHaveAttribute("aria-expanded", "true");
  await expect(zoneFilter).toBeVisible();
  await expect(zoneFilter).toBeFocused();
  await expect(listbox).toBeVisible();
  // Neither a native select nor a bottom sheet: the field is not a <select>,
  // and the card is drawn beside the field, not pinned to the viewport's foot.
  await expect(page.locator("select#hhzone, select#hhcur")).toHaveCount(0);
  const fieldBox = await zone.boundingBox();
  const listBox = await listbox.boundingBox();
  expect(fieldBox && listBox && listBox.y >= fieldBox.y, "the card sits under the field").toBe(true);
  // The six favourites come first, in this order.
  const favourites = ["Europe/London", "Europe/Dublin", "Europe/Paris", "America/New York", "Australia/Sydney", "UTC"];
  const options = listbox.getByRole("option");
  for (const [index, label] of favourites.entries()) {
    await expect(options.nth(index)).toContainText(label);
  }

  // 2. Type "dub", Enter: it closes, the field reads Dublin, focus returns,
  //    and the save control is live for the change.
  await page.keyboard.type("dub");
  await page.keyboard.press("Enter");
  await expect(listbox).toBeHidden();
  await expect(zone).toHaveAttribute("aria-expanded", "false");
  await expect(zone).toContainText("Europe/Dublin");
  await expect(zone).toBeFocused();
  // The field wears its own quiet save: touched, it is marked dirty (household.css "2c").
  await expect(page.locator(".field.dirty").filter({ has: page.locator("#hhzone") })).toHaveCount(1);

  // 3. The currency: Escape closes with nothing changed, focus back on it.
  const currencyBefore = (await currency.innerText()).trim();
  await tabTo(page, { selector: "#hhcur" }, { screen: "household, currency" });
  await page.keyboard.press("Enter");
  await expect(currency).toHaveAttribute("aria-expanded", "true");
  await expect(currencyFilter).toBeVisible();
  await expect(currencyFilter).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(listbox).toBeHidden();
  await expect(currency).toHaveAttribute("aria-expanded", "false");
  await expect(currency).toBeFocused();
  expect((await currency.innerText()).trim()).toBe(currencyBefore);
  await expect(zone).toContainText("Europe/Dublin");

  // 4. Open the time zone, ArrowDown twice: the second option has focus.
  //    A click outside the card closes it.
  await zone.focus();
  await page.keyboard.press("Enter");
  await expect(zoneFilter).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await expect(options.nth(1)).toBeFocused();
  await page.getByRole("heading", { level: 1 }).first().click();
  await expect(listbox).toBeHidden();
  await expect(zone).toHaveAttribute("aria-expanded", "false");
});
