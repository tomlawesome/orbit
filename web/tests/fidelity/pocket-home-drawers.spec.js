import { expect, test } from "@playwright/test";
import { APP, openRow, settle } from "./pocket-states.js";

/*
 * HOME'S DRAWERS ON A PHONE (#1120, review round §2.1): a manifest row
 * opens in place, its `complete` goes to the belt's record sheet for an
 * item with a cost to confirm, `open →` goes to the belt, a search result
 * closes the search and opens its row, and the item's own address opens
 * it on arrival. The dial keeps raising its sheet while the owner's
 * question 6 is open. Fixture data, at the height a phone browser leaves.
 */
test.use({ viewport: { width: 390, height: 664 }, hasTouch: true, isMobile: true });
test("complete goes to the record sheet", async ({ page }) => {
  await page.goto(`${APP}/home`, { waitUntil: "load" });
  await settle(page);
  const gutter = page.locator(".pocket .pk-below [data-row]", { hasText: "Gutter clearing" }).first();
  await openRow(page, gutter);
  await gutter.getByRole("button", { name: "Complete Gutter clearing" }).tap();
  await expect(page).toHaveURL(/\/item\/i-gutter/);
  await expect(page.getByRole("dialog", { name: "Record a completion" })).toBeVisible();
});
test("search result opens the row", async ({ page }) => {
  await page.goto(`${APP}/home`, { waitUntil: "load" });
  await settle(page);
  await page.locator(".msearch").click();
  await page.locator(".pk-field").fill("MOT");
  await page.locator(".pk-results [data-row-face]", { hasText: "Car MOT" }).first().click();
  const mot = page.locator(".pocket .pk-below [data-row]", { hasText: "Car MOT" }).first();
  await expect(mot).toHaveAttribute("data-open", "");
  await expect(page.locator(".p-sheet-layer.open")).toHaveCount(0);
  await expect(mot.locator("[data-row-face]")).toBeFocused();
});
test("the address opens the row", async ({ page }) => {
  await page.goto(`${APP}/home?item=i-boiler`, { waitUntil: "load" });
  await settle(page);
  const boiler = page.locator(".pocket .pk-below [data-row]", { hasText: "Boiler service" }).first();
  await expect(boiler).toHaveAttribute("data-open", "");
  await expect(boiler).toBeInViewport();
});
test("open → morphs to the belt", async ({ page }) => {
  await page.goto(`${APP}/home`, { waitUntil: "load" });
  await settle(page);
  const mot = page.locator(".pocket .pk-below [data-row]", { hasText: "Car MOT" }).first();
  await openRow(page, mot);
  await mot.getByRole("link", { name: "Open Car MOT — Volvo V60" }).tap();
  await expect(page).toHaveURL(/\/item\/i-mot/);
});
test("a planet on the dial still raises its sheet (question 6 open)", async ({ page }) => {
  await page.goto(`${APP}/home`, { waitUntil: "load" });
  await settle(page);
  await page.locator(".pk-body[data-sheet-title]").first().click();
  await expect(page.locator(".p-sheet-layer.open .pk-card")).toBeVisible();
});
