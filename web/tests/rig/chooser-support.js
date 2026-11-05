import { expect } from "@playwright/test";

/*
 * #1468 Part A: the desk Add form's key date is a pressed value that opens the
 * chooser card (a calendar), not a native date input. The values sit in
 * #disclose, which opens only once a name of 3+ characters is typed.
 */

/** Types a name so the rest of the form discloses. @param {import("@playwright/test").Page} page @param {string} [name] */
export async function nameTheEntry(page, name = "Chooser proving") {
  await page.locator("#f-name").fill(name);
  await expect(page.locator("#disclose.open")).toBeAttached();
}

/** Opens the key date's calendar and picks a day, turning months as needed. @param {import("@playwright/test").Page} page @param {string} iso */
export async function pickKeyDate(page, iso) {
  await page.locator("button#f-date").click();
  const card = page.getByRole("dialog", { name: /^Choose key date/i });
  const cell = card.locator(`[data-iso="${iso}"]`);
  for (let turns = 0; turns < 36 && (await cell.count()) === 0; turns += 1) {
    await card.getByRole("button", { name: "Next month" }).click();
  }
  await cell.click();
}
