import type { Locator, Page } from "@playwright/test";

/* #1468 Part A: a date on Add is a pressed value that opens the chooser card's
   calendar, so a test picks the day there rather than filling a date input. */

/** Presses a date control, then picks `iso` in the calendar it opens, turning months as needed. */
export async function pickDate(page: Page, control: Locator, iso: string): Promise<void> {
  await control.click();
  const cell = page.locator(`[role="dialog"] [role="grid"] [data-iso="${iso}"]`);
  for (let turns = 0; turns < 36 && (await cell.count()) === 0; turns += 1) {
    await page.getByRole("button", { name: "Next month" }).click();
  }
  await cell.click();
}

/** The phone Add form's due date. */
export const pickPocketDate = (page: Page, iso: string) => pickDate(page, page.locator('[id$="-due"]'), iso);
