import { randomUUID } from "node:crypto";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { resetDatabaseBetweenSpecFiles } from "./support/database";
import { householdDateFromToday } from "./support/household-dates";
import { sessionHeaders } from "./support/households";
import { cleanup, seedHousehold, signIn } from "./support/signed-in";

/* #1077: back to the stack's own seed before this file's setup runs. */
resetDatabaseBetweenSpecFiles();

/**
 * #1332 (design decision 2026-10-10, "where do these entries go?"): removing
 * a section that still holds entries opens a chooser -- the destination is the
 * second tap -- instead of arming or hiding the ×. Nothing is sent until save;
 * a pick marks the row removed, raises the destination's count and says so in
 * a status line; save sends `sections.replace` with `moveItemsTo`.
 *
 * Desk (>= 1200px): the chooser card beside the row, tiles two across.
 * Phone: the bottom sheet round the same tiles. The words are the issue's.
 *
 * E2E, not run where it was written: it needs the full stack.
 */

type Seeded = { id: string; name: string; sectionId: string; vehiclesId: string; garageId: string; atticId: string };

/**
 * A household with four sections: Home and Vehicles (empty), Garage holding
 * three entries, and Attic, hidden and empty.
 */
async function seedSections(page: Page): Promise<Seeded> {
  const base = await seedHousehold(page, "where-entries");
  const vehiclesId = randomUUID();
  const garageId = randomUUID();
  const atticId = randomUUID();
  const headers = { ...(await sessionHeaders(page)), "content-type": "application/json" };
  const listed = await page.request.post("/api/workspace/commands", {
    headers,
    data: {
      type: "sections.replace",
      householdId: base.id,
      sections: [
        { id: base.sectionId, name: "Home", icon: "home", accent: "sage", visible: true },
        { id: vehiclesId, name: "Vehicles", icon: "vehicle", accent: "blue", visible: true },
        { id: garageId, name: "Garage", icon: "device", accent: "sand", visible: true },
        { id: atticId, name: "Attic", icon: "service", accent: "plum", visible: false },
      ],
    },
  });
  if (!listed.ok()) throw new Error(`#1332: could not seed sections (${listed.status()})`);
  for (const n of [1, 2, 3]) {
    const itemId = randomUUID();
    const filed = await page.request.post("/api/workspace/commands", {
      headers,
      data: {
        type: "item.upsert",
        householdId: base.id,
        kind: "service",
        item: {
          id: itemId,
          sectionId: garageId,
          title: `where-entries garage ${n}`,
          currency: "GBP",
          dueDate: householdDateFromToday(20 + n),
          recurrenceMonths: 12,
        },
        activity: { id: randomUUID(), itemId, occurredAt: new Date().toISOString() },
      },
    });
    if (!filed.ok()) throw new Error(`#1332: could not seed an entry (${filed.status()})`);
  }
  return { ...base, vehiclesId, garageId, atticId };
}

/** The request a save sends: a `sections.replace` command, parsed. */
function sectionsReplaceRequest(page: Page) {
  return page.waitForRequest((request) => {
    if (request.method() !== "POST" || !request.url().endsWith("/api/workspace/commands")) return false;
    try {
      return JSON.parse(request.postData() ?? "{}").type === "sections.replace";
    } catch {
      return false;
    }
  });
}

/* ── the desk ───────────────────────────────────────────────────────────── */
test.describe("desk", () => {
  test.beforeEach(({ isMobile, viewport }) => {
    test.skip(isMobile || (viewport?.width ?? 0) < 1200, "the desk's chooser card; a phone draws the sheet");
  });

  const rowOf = (page: Page, name: string): Locator =>
    page.locator(".sec").filter({ has: page.getByRole("button", { name: `Remove ${name}` }) });

  test("the × on a section with entries opens the chooser; Esc removes nothing; a pick and save move the entries (#1332)", async ({ page }) => {
    test.setTimeout(120_000);
    await signIn(page, "/home");
    const household = await seedSections(page);
    try {
      await page.goto(`/household/${household.id}`);
      const drop = page.getByRole("button", { name: "Remove Garage" });
      await expect(drop).toBeVisible({ timeout: 30_000 });

      // 1. Every section row offers remove, the one holding entries too; the
      //    × is named for its section, not "Remove section".
      await expect(page.getByRole("button", { name: "Remove Vehicles" })).toBeVisible();
      await expect(page.getByRole("button", { name: "Remove Home" })).toBeVisible();
      await expect(page.getByRole("button", { name: "Remove section" })).toHaveCount(0);
      await expect(rowOf(page, "Garage").locator(".used")).toHaveText("3 entries");

      // 2. Opening: the card stands under the row, headed and named for the
      //    entries it will move, offering every other section as a tile.
      await drop.click();
      const chooser = page.getByRole("dialog", { name: "Choose where 3 entries go" });
      await expect(chooser).toBeVisible();
      await expect(chooser.getByRole("heading", { name: "where 3 entries go" })).toBeVisible();
      await expect(chooser.getByRole("button", { name: /close/ })).toContainText("esc");
      const rowBox = await rowOf(page, "Garage").boundingBox();
      const cardBox = await chooser.boundingBox();
      expect(rowBox && cardBox && cardBox.y >= rowBox.y, "the card is seated under the row").toBe(true);
      const tiles = chooser.getByRole("radiogroup", { name: "sections" });
      await expect(tiles.getByRole("radio")).toHaveCount(3);
      await expect(tiles.getByRole("radio", { name: /Home/ })).toBeVisible();
      await expect(tiles.getByRole("radio", { name: /Vehicles/ })).toBeVisible();
      await expect(tiles.getByRole("radio", { name: /Attic/ })).toContainText("hidden");
      await expect(tiles.getByRole("radio", { name: /Garage/ })).toHaveCount(0);

      // 3. Esc closes with nothing removed, and focus goes back to the ×.
      await page.keyboard.press("Escape");
      await expect(chooser).toBeHidden();
      await expect(drop).toBeFocused();
      await expect(rowOf(page, "Garage").locator(".used")).toHaveText("3 entries");
      await expect(page.getByRole("status").filter({ hasText: "removed" })).toHaveCount(0);

      // 4. A pick: the row goes, the destination's count rises, the status
      //    line says what will happen on save.
      await drop.click();
      await expect(chooser).toBeVisible();
      await tiles.getByRole("radio", { name: /Vehicles/ }).click();
      await expect(chooser).toBeHidden();
      await expect(page.getByRole("button", { name: "Remove Garage" })).toHaveCount(0);
      await expect(rowOf(page, "Vehicles").locator(".used")).toHaveText("3 entries");
      await expect(page.getByRole("status").filter({ hasText: "Garage removed" }))
        .toHaveText("Garage removed · 3 entries move to Vehicles when you save");

      // 5. Save sends the removal with moveItemsTo naming the destination.
      const sent = sectionsReplaceRequest(page);
      await page.locator(".c-sections").getByRole("button", { name: "save", exact: true }).click();
      const command = JSON.parse((await sent).postData() ?? "{}");
      expect(command.moveItemsTo).toBe(household.vehiclesId);
      expect(command.sections.map((one: { id: string }) => one.id)).not.toContain(household.garageId);
      await expect(page.locator(".c-sections .said")).toHaveText("saved");

      // 6. The entries landed: after a reload Garage is gone and Vehicles holds three.
      await page.reload();
      await expect(page.getByRole("button", { name: "Remove Vehicles" })).toBeVisible({ timeout: 30_000 });
      await expect(page.getByRole("button", { name: "Remove Garage" })).toHaveCount(0);
      await expect(rowOf(page, "Vehicles").locator(".used")).toHaveText("3 entries");
    } finally {
      await cleanup(page, household);
    }
  });

  test("an unsaved new section is offered once it has a name, marked new (#1332)", async ({ page }) => {
    test.setTimeout(90_000);
    await signIn(page, "/home");
    const household = await seedSections(page);
    try {
      await page.goto(`/household/${household.id}`);
      await expect(page.getByRole("button", { name: "Remove Garage" })).toBeVisible({ timeout: 30_000 });
      await page.getByRole("button", { name: "+ add a section" }).click();
      await page.getByRole("textbox", { name: "Section name" }).last().fill("Workshop");
      await page.getByRole("button", { name: "Remove Garage" }).click();
      const tiles = page.getByRole("dialog", { name: "Choose where 3 entries go" }).getByRole("radiogroup", { name: "sections" });
      await expect(tiles.getByRole("radio", { name: /Workshop/ })).toContainText("new");
      await page.keyboard.press("Escape");
    } finally {
      await cleanup(page, household);
    }
  });

  test("the last kept section has no ×: there is nowhere to send its entries (#1332)", async ({ page }) => {
    test.setTimeout(90_000);
    await signIn(page, "/home");
    const household = await seedHousehold(page, "where-entries-last", { withItem: true });
    try {
      await page.goto(`/household/${household.id}`);
      await expect(page.locator(".sec").first()).toBeVisible({ timeout: 30_000 });
      await expect(page.getByRole("button", { name: "Remove Home" })).toHaveCount(0);
      await expect(page.getByRole("button", { name: "Remove section" })).toHaveCount(0);
    } finally {
      await cleanup(page, household);
    }
  });
});

/* ── the phone ──────────────────────────────────────────────────────────── */
test.describe("phone", () => {
  test.beforeEach(({ isMobile }) => {
    test.skip(!isMobile, "the phone's sheet; the desk draws the chooser card");
  });

  const rowOf = (page: Page, name: string): Locator =>
    page.locator("[data-hh=sections] [data-row]").filter({ has: page.getByText(name, { exact: true }) });

  test("the remove act on a section with entries opens the sheet; Esc, undo, a pick and save (#1332)", async ({ page }) => {
    test.setTimeout(120_000);
    await signIn(page, "/home");
    const household = await seedSections(page);
    try {
      await page.goto(`/household/${household.id}`);
      const garage = rowOf(page, "Garage");
      const face = garage.locator("[data-row-face]");
      await expect(face).toBeVisible({ timeout: 30_000 });
      await expect(garage).toContainText("3 entries");

      // 1. The row's remove act is there for a section with entries, and
      //    opens the sheet rather than arming.
      await face.click();
      await page.getByRole("button", { name: "Remove Garage" }).click();
      const sheet = page.getByRole("dialog", { name: /where 3 entries go/ });
      await expect(sheet).toBeVisible();
      const tiles = sheet.getByRole("radiogroup", { name: "sections" });
      await expect(tiles.getByRole("radio")).toHaveCount(3);
      await expect(tiles.getByRole("radio", { name: /Attic/ })).toContainText("hidden");
      await expect(tiles.getByRole("radio", { name: /Garage/ })).toHaveCount(0);

      // 2. Esc closes with nothing removed; focus returns to the row.
      await page.keyboard.press("Escape");
      await expect(sheet).toBeHidden();
      await expect(face).toBeFocused();
      await expect(rowOf(page, "Garage")).toContainText("3 entries");

      // 3. A pick removes the row, raises the destination, says so, and
      //    counts one change; undo puts it all back.
      await face.click();
      await page.getByRole("button", { name: "Remove Garage" }).click();
      await sheet.getByRole("radio", { name: /Vehicles/ }).click();
      await expect(sheet).toBeHidden();
      await expect(rowOf(page, "Garage")).toHaveCount(0);
      await expect(rowOf(page, "Vehicles")).toContainText("3 entries");
      await expect(page.getByRole("status").filter({ hasText: "Garage removed" }))
        .toHaveText("Garage removed · 3 entries move to Vehicles when you save");
      await expect(page.getByRole("status").filter({ hasText: "1 change" })).toBeVisible();
      await page.getByRole("button", { name: "undo", exact: true }).click();
      await expect(rowOf(page, "Garage")).toContainText("3 entries");
      await expect(rowOf(page, "Vehicles")).toContainText("0 entries");

      // 4. Again, and save: moveItemsTo names Vehicles, and the entries land.
      await rowOf(page, "Garage").locator("[data-row-face]").click();
      await page.getByRole("button", { name: "Remove Garage" }).click();
      await sheet.getByRole("radio", { name: /Vehicles/ }).click();
      const sent = sectionsReplaceRequest(page);
      await page.getByRole("button", { name: "save", exact: true }).click();
      const command = JSON.parse((await sent).postData() ?? "{}");
      expect(command.moveItemsTo).toBe(household.vehiclesId);
      expect(command.sections.map((one: { id: string }) => one.id)).not.toContain(household.garageId);
      await page.reload();
      await expect(rowOf(page, "Vehicles")).toContainText("3 entries", { timeout: 30_000 });
      await expect(rowOf(page, "Garage")).toHaveCount(0);
    } finally {
      await cleanup(page, household);
    }
  });
});
