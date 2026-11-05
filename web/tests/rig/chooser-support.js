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
  await pickInOpenCard(page, /^Choose key date/i, iso);
}

/** Opens the phone form's due-date calendar (a bottom sheet) and picks a day, turning months as needed. @param {import("@playwright/test").Page} page @param {string} iso */
export async function pickPocketDate(page, iso) {
  await page.locator('[id$="-due"]').click();
  await pickInOpenCard(page, /^Choose due date/i, iso);
}

/** Turns the open calendar toward `iso` (either way: it opens on the real month) and clicks the day. @param {import("@playwright/test").Page} page @param {RegExp} name @param {string} iso */
async function pickInOpenCard(page, name, iso) {
  const card = page.getByRole("dialog", { name });
  const cell = card.locator(`[data-iso="${iso}"]`);
  const [year, month] = iso.split("-").map(Number);
  for (let turns = 0; turns < 120 && (await cell.count()) === 0; turns += 1) {
    const shown = new Date(`1 ${(await card.getByRole("grid").getAttribute("aria-label")) ?? ""} UTC`);
    const gap = (year - shown.getUTCFullYear()) * 12 + (month - 1 - shown.getUTCMonth());
    await card.getByRole("button", { name: gap < 0 ? "Previous month" : "Next month" }).click();
  }
  await cell.click();
}
