import { expect, test } from "@playwright/test";

import { APP } from "../fidelity/pocket-states.js";
import { nameTheEntry } from "./chooser-support.js";

/*
 * #1930 (decision 52a, #1494 note 67381): the repeat band in the chooser card
 * stages like Tiles. Arrows, Home and End move focus and the check
 * (selection follows focus) but the card stays open and nothing is picked; a
 * press, Enter or Space lands the pick and closes the card; Esc closes it with
 * nothing picked. Each time the card opens, the check starts from the stored
 * value. Desk only: it is the Add form's repeat value (#f-recur).
 */

test.use({
  serviceWorkers: async ({}, use, testInfo) => {
    await use(testInfo.project.use.browserName === "webkit" ? "block" : "allow");
  },
});

test.beforeEach(() => {
  test.skip(test.info().project.name.includes("phone"), "the desk's lane, as create-chooser-1468.spec.js");
});

test.describe("desk Add: the repeat band stages in the chooser card (#1930)", () => {
  test("arrows check a cell but pick nothing and keep the card open; Esc drops it, a reopen starts from the stored value", async ({ page }) => {
    await page.goto(`${APP}/create`, { waitUntil: "load" });
    await page.locator("#card[data-ready]").waitFor({ state: "attached" });
    await nameTheEntry(page);
    const value = page.locator("button#f-recur");
    const card = page.getByRole("dialog", { name: /^Choose repeat/i });
    const stored = (await value.textContent()) ?? "";

    await value.click();
    await expect(card).toBeVisible();
    const start = card.locator("[role=radio][aria-checked=true]");
    await expect(start).toHaveCount(1);
    const startName = await start.getAttribute("aria-label");
    await start.focus();
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("ArrowDown");
    const reached = card.locator("[role=radio][aria-checked=true]");
    await expect(reached, "selection follows focus: the cell reached is checked, alone").toHaveCount(1);
    await expect(reached).toBeFocused();
    await expect(reached).not.toHaveAttribute("aria-label", startName ?? "");
    await expect(card, "an arrow does not close the card").toBeVisible();
    await expect(value, "an arrow picks nothing").toHaveText(stored);

    await page.keyboard.press("Escape");
    await expect(card).toBeHidden();
    await expect(value, "Esc picks nothing").toHaveText(stored);

    await value.click();
    await expect(card.locator("[role=radio][aria-checked=true]"), "the check restarts from the stored value").toHaveAttribute("aria-label", startName ?? "");
  });

  test("Enter lands the cell the arrows reached and closes the card", async ({ page }) => {
    await page.goto(`${APP}/create`, { waitUntil: "load" });
    await page.locator("#card[data-ready]").waitFor({ state: "attached" });
    await nameTheEntry(page);
    const value = page.locator("button#f-recur");
    const card = page.getByRole("dialog", { name: /^Choose repeat/i });
    const stored = (await value.textContent()) ?? "";

    await value.click();
    await card.locator("[role=radio][aria-checked=true]").focus();
    await page.keyboard.press("ArrowDown");
    const reached = card.locator("[role=radio][aria-checked=true]");
    await expect(reached, "selection follows focus").toBeFocused();
    const reachedName = (await reached.getAttribute("aria-label")) ?? "";
    await page.keyboard.press("Enter");
    await expect(card).toBeHidden();
    await expect(value).not.toHaveText(stored);
    await value.click();
    await expect(card.locator("[role=radio][aria-checked=true]")).toHaveAttribute("aria-label", reachedName);
  });

  test("a press on a cell lands it and closes the card", async ({ page }) => {
    await page.goto(`${APP}/create`, { waitUntil: "load" });
    await page.locator("#card[data-ready]").waitFor({ state: "attached" });
    await nameTheEntry(page);
    const value = page.locator("button#f-recur");
    const card = page.getByRole("dialog", { name: /^Choose repeat/i });
    await value.click();
    await card.getByRole("radio", { name: /6 months/i }).click();
    await expect(card).toBeHidden();
    await expect(value).toContainText(/every 6 months/i);
  });
});
