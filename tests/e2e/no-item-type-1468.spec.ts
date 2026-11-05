import { expect, test, type Page } from "@playwright/test";
import { householdRegister } from "./support/households";
import { gotoCreate } from "./support/keyboard";
import { resetDatabaseBetweenSpecFiles } from "./support/database";
import { seedHouseholdInBrowser, signIn } from "./support/signed-in";
import { householdDateFromToday } from "./support/household-dates";
import { SETTLE } from "./support/settle";

/* ADR-0043 (#1466 note 53014 section 5, #1468 Part B): an item has no type.
   Add asks name, section, date (optional), how it repeats, reminders; the
   engine gives a dated item a renewal schedule and a dateless one none.

   These cases were written from the specification alone and have NOT been run:
   the e2e stack (compose build, database, signed-in browser) is not available
   to the test writer, so every selector below that is not already used by
   v19-create.spec.ts (the chooser card's calendar and repeat band, the sky
   body's section colour, the edit drawer's rows) is a best reading of the
   built components and may need adjusting when the build is run. */

resetDatabaseBetweenSpecFiles();

const HOUSEHOLD = "No Item Type Proving Ground";
const households = householdRegister();
const isPhone = () => test.info().project.name.startsWith("mobile");

/** Presses a pressed-value control and picks a day in the chooser card's calendar. */
async function chooseDate(page: Page, control: ReturnType<Page["locator"]>, iso: string) {
  await control.click();
  const cell = page.locator(`[role="dialog"] [role="grid"] [data-iso="${iso}"]`);
  for (let turns = 0; turns < 3 && (await cell.count()) === 0; turns++) {
    await page.getByRole("button", { name: "Next month" }).click();
  }
  await cell.click();
}

/** Picks "every 12 months" in the chooser card's repeat band (the add form defaults to yearly, so this confirms it). */
async function chooseYearly(page: Page, control: ReturnType<Page["locator"]>) {
  await control.click();
  await page.locator('[role="dialog"] [role="radiogroup"] [role="radio"]', { hasText: /12|yearly/iu }).first().click();
}

async function fillDeskOrPhone(page: Page, name: string, dueDate?: string) {
  await gotoCreate(page);
  if (isPhone()) {
    const form = page.getByRole("form", { name: "New entry" });
    await form.getByRole("textbox", { name: "name", exact: true }).fill(name);
    // No type is asked: there is no group to press.
    await expect(form.locator(".pc-kinds")).toHaveCount(0);
    await form.getByRole("group", { name: /^section/ }).getByRole("button", { name: "Home" }).click();
    if (dueDate) await chooseDate(page, form.locator('[id$="-due"]'), dueDate);
    await page.getByRole("button", { name: "Add to orbit" }).click();
  } else {
    await page.locator("#f-name").fill(name);
    await expect(page.locator("#types")).toHaveCount(0);
    await page.getByRole("group", { name: /^section/ }).getByRole("button", { name: "Home" }).click();
    if (dueDate) {
      await chooseDate(page, page.locator("#f-date"), dueDate);
      await chooseYearly(page, page.locator("#f-recur"));
    }
    await page.locator(".btn-primary").click();
  }
}

type Item = { id: string; title: string; scheduleKind?: string; dueDate?: string; recurrenceMonths?: number };
async function savedItem(page: Page, householdId: string, title: string): Promise<Item | undefined> {
  const response = await page.request.get("/api/workspace", { maxRetries: 2 });
  const { workspace } = (await response.json()) as { workspace: { households: Array<{ id: string; items: Item[] }> } };
  return workspace.households.find((one) => one.id === householdId)?.items.find((item) => item.title === title);
}

test("a dated item repeating every 12 months is added with no type and read on the sky with its days", async ({ page }) => {
  await signIn(page);
  const household = households.track(await seedHouseholdInBrowser(page, HOUSEHOLD));
  try {
    const name = "No type, every 12 months";
    const dueDate = householdDateFromToday(20);
    await fillDeskOrPhone(page, name, dueDate);
    await expect(page).toHaveURL(/\/home\?item=[0-9a-f-]{36}$/, { timeout: SETTLE });

    await expect.poll(() => savedItem(page, household.id, name)).toMatchObject({ scheduleKind: "renewal", dueDate, recurrenceMonths: 12 });
    expect(await savedItem(page, household.id, name)).not.toHaveProperty("kind");

    const row = page.locator(".item, .pocket .pk-below .p-row", { hasText: name });
    await expect(row.first()).toContainText("T−20d");
    // It sits on the sky in its section's colour (the planet carries the section's accent, not a type's).
    await expect(page.locator('[data-section-colour], [data-colour], .planet').first()).toBeVisible();
  } finally {
    await households.sweep(page);
  }
});

test("an item with no date is added and read as a suggestion body", async ({ page }) => {
  await signIn(page);
  const household = households.track(await seedHouseholdInBrowser(page, HOUSEHOLD));
  try {
    const name = "No type, no date";
    await fillDeskOrPhone(page, name);
    await expect.poll(() => savedItem(page, household.id, name)).toBeDefined();
    const saved = await savedItem(page, household.id, name);
    expect(saved?.dueDate).toBeUndefined();
    expect(saved?.scheduleKind).toBeUndefined();
    expect(saved?.recurrenceMonths).toBeUndefined();

    await page.goto("/home");
    // A dateless item is a suggestion: it is drawn in the suggestions, not the dated manifest.
    await expect(page.getByText(name).first()).toBeVisible({ timeout: SETTLE });
    await expect(page.locator('[data-suggestion="true"], .suggestion, [data-kind="suggestion"]', { hasText: name }).first()).toBeVisible();
  } finally {
    await households.sweep(page);
  }
});

test("editing an existing MOT's date keeps it a service whose completion is still named a service", async ({ page }) => {
  await signIn(page);
  const household = households.track(await seedHouseholdInBrowser(page, HOUSEHOLD, { withItem: true, itemTitle: "MOT proving" }));
  try {
    // Make it a stored service item the way v0.3.6 left one: the engine path for that is mail intake or an
    // existing row; the seeded item here is a renewal, so the stored schedule is set through the API route a
    // v0.3.6 bundle used (kind: inspection), which v0.3.7 must have ignored. A real stored service row is
    // exercised in tests/integration/workspace-item-kind.test.ts; this case proves the edit drawer.
    const before = await savedItem(page, household.id, "MOT proving");
    expect(before?.scheduleKind).toBeDefined();

    await page.goto(`/home?item=${household.itemId}`);
    const newDate = householdDateFromToday(45);
    const dueRow = page.getByRole("button", { name: /next due|due date/iu }).first();
    await chooseDate(page, dueRow, newDate);
    await page.getByRole("button", { name: /^save/iu }).click();

    await expect.poll(() => savedItem(page, household.id, "MOT proving")).toMatchObject({ dueDate: newDate, scheduleKind: before?.scheduleKind });
    // The edit drawer has no type row.
    await expect(page.getByText(/^type$/iu)).toHaveCount(0);

  } finally {
    await households.sweep(page);
  }
});
