import { expect, test } from "@playwright/test";
import { APP, openRow, settle } from "./pocket-states.js";

/*
 * HOME'S DRAWERS ON A PHONE (#1120, review round §2.1): a manifest row
 * opens in place, its `complete` goes to the belt's record sheet for an
 * item with a cost to confirm, `open →` goes to the belt, a search result
 * closes the search and opens its row (or, with no row, goes to the item:
 * round 2, e), and the item's own address opens it on arrival. A planet on
 * the dial opens its row and a second tap on the lit body goes to the item
 * (owner's answer 6a); the dial arrives on every forward arrival, never on
 * Back (round 2, g). Fixture data, at the height a phone browser leaves.
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
test("a search result with no row goes straight to the item", async ({ page }) => {
  await page.goto(`${APP}/home`, { waitUntil: "load" });
  await settle(page);
  await expect(page.locator(".pocket .pk-below [data-row]", { hasText: "Chimney sweep" })).toHaveCount(0);
  await page.locator(".msearch").click();
  await page.locator(".pk-field").fill("Chimney");
  await page.locator(".pk-results [data-row-face]", { hasText: "Chimney sweep" }).first().click();
  await expect(page).toHaveURL(/\/item\/i-chimney/);
});
test("a planet opens its row; a second tap on the lit body goes to the item", async ({ page }) => {
  await page.goto(`${APP}/home`, { waitUntil: "load" });
  await settle(page);
  const body = page.locator(".mdial .pk-body[aria-label='Gutter clearing']");
  await body.click();
  const gutter = page.locator(".pocket .pk-below [data-row]", { hasText: "Gutter clearing" }).first();
  await expect(gutter).toHaveAttribute("data-open", "");
  await expect(page.locator(".p-sheet-layer.open")).toHaveCount(0);
  await expect(gutter).toBeInViewport();
  await expect(body).toHaveClass(/lit/);
  await body.scrollIntoViewIfNeeded();
  await body.click();
  await expect(page).toHaveURL(/\/item\/i-gutter/);
});
test("the dial arrives on a forward arrival, never on Back", async ({ page }) => {
  const dial = page.locator(".pocket .mdial");
  /** Whether the arrival is playing, or has played, on the dial now. */
  const arriving = () => dial.evaluate((el) => el.getAnimations().some((a) => /** @type {CSSAnimation} */ (a).animationName === "pocket-arrive"));
  await page.goto(`${APP}/home`, { waitUntil: "load" });
  await expect(dial).toHaveClass(/arrive/);
  await settle(page);
  const mot = page.locator(".pocket .pk-below [data-row]", { hasText: "Car MOT" }).first();
  await openRow(page, mot);
  await mot.getByRole("link", { name: "Open Car MOT — Volvo V60" }).tap();
  await expect(page).toHaveURL(/\/item\/i-mot/);
  await page.goBack();
  await expect(page).toHaveURL(/\/home/);
  await expect(dial).not.toHaveClass(/arrive/);
  expect(await arriving(), "Back replayed the arrival").toBe(false);
  await page.goForward();
  await expect(page).toHaveURL(/\/item\/i-mot/);
  /* A forward arrival again, as a link on any screen makes it. */
  await page.evaluate(() => {
    const a = document.createElement("a");
    a.href = "/home";
    document.body.append(a);
    a.click();
  });
  await expect(page).toHaveURL(/\/home$/);
  await expect(dial).toHaveClass(/arrive/);
  expect(await arriving(), "a second forward arrival did not arrive").toBe(true);
});

/* A chip in "other skies" flies to that household, as the desk does (#1118,
   owner 2026-09-25, 7a). */
test.describe("at 390x844", () => {
  test.use({ viewport: { width: 390, height: 844 } });
  test("a chip in other skies flies to that household", async ({ page }) => {
    await page.goto(`${APP}/home`, { waitUntil: "load" });
    await settle(page);
    /* Marks this document so a real (non-SPA) browser navigation, which the
       chip's plain href would still complete on its own, is told apart from
       the fly() handler actually taking the tap: only a client-routed
       goto() carries this flag through to the destination. */
    await page.evaluate(() => { /** @type {any} */ (window).__pocket1118 = true; });
    const chip = page.locator(".skies .msys", { hasText: "Seaside Cottage" });
    await chip.click();
    await expect(page).toHaveURL(/\/household\/hh-seaside-4551$/);
    await expect(page.getByRole("heading", { name: "Seaside Cottage" })).toBeVisible();
    expect(await page.evaluate(() => /** @type {any} */ (window).__pocket1118)).toBe(true);
  });
});
