import { expect, test } from "@playwright/test";
import { SIGNED_IN, openRow, settle } from "./pocket-states.js";

/* Same app the fidelity gate photographs (playwright.config.js webServer). */
const APP = process.env.FIDELITY_APP ?? "http://127.0.0.1:4173";

/*
 * ADMINISTRATION ON A PHONE (#1123, proposal §2.12 and §2.11; owner decisions
 * §25 and §19; review round §1.1, §2.6), in a real browser at 390x844 with
 * touch on. What the page shows and what its acts are called (rows shut at
 * rest and a tap opens them, disable arming, a system on the clock, a failed
 * document job, row meta, alerts and the jump strip, the invite sheet) are
 * proved on the mounted page in tests/unit/pocket-administration.test.mjs
 * (#1613, ADR-0039). What stays here needs computed style or geometry:
 *   · every shared text field is 16px (20px at extra-large), so iOS Safari
 *     does not zoom on focus
 *   · the opened row's three acts fit at 360
 */
test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

/** @param {import("@playwright/test").Page} page */
async function open(page) {
  await page.goto(`${APP}/administration`, { waitUntil: "load" });
  await page.waitForSelector(".ad-pocket [data-ad=people] .p-row");
  await settle(page);
}

/** @param {import("@playwright/test").Page} page @param {string} scope @param {string} text */
const row = (page, scope, text) => page.locator(`${scope} .p-row`, { hasText: text }).first();

/*
 * A text field is 16px or more at the standard text size, so iOS Safari does
 * not zoom on focus (#1180), and it still scales with the larger steps (the
 * floor is max(16px, 1rem), not a pin): 1.25 x 16 = 20px at extra-large.
 */
/** @param {import("@playwright/test").Page} page @param {string} selector @param {string} size */
async function fieldSizesAt(page, selector, size) {
  await page.evaluate((step) => { document.documentElement.dataset.textSize = step; }, size);
  return page.locator(selector).evaluateAll((fields) => fields.map((field) => parseFloat(getComputedStyle(field).fontSize)));
}

test("every shared text field is 16px at standard text size, 20px at extra-large", async ({ page }) => {
  await open(page);
  await page.getByRole("button", { name: "invite someone" }).click();
  await expect(page.getByRole("dialog", { name: "Invite someone" })).toBeVisible();
  const standard = await fieldSizesAt(page, ".p-input", "standard");
  expect(standard.length, "the screen shows .p-input fields").toBeGreaterThan(0);
  expect(standard.filter((px) => !(px >= 16)), `sizes at standard: ${standard}`).toEqual([]);
  const extra = await fieldSizesAt(page, ".p-input", "extra-large");
  expect(extra.filter((px) => !(px >= 20)), `sizes at extra-large: ${extra}`).toEqual([]);
});

test("settings' password field is 16px at standard text size, 20px at extra-large", async ({ page }) => {
  const sheet = SIGNED_IN.find((state) => state.route === "/settings" && state.state === "change-password-sheet");
  if (!sheet) throw new Error("pocket-states.js has no settings change-password-sheet state");
  await sheet.reach(page);
  const field = "#st-current, #st-new";
  const standard = await fieldSizesAt(page, field, "standard");
  expect(standard.length, "the sheet shows a password field").toBeGreaterThan(0);
  expect(standard.filter((px) => !(px >= 16)), `sizes at standard: ${standard}`).toEqual([]);
  expect((await fieldSizesAt(page, ".p-input", "standard")).filter((px) => !(px >= 16))).toEqual([]);
  const extra = await fieldSizesAt(page, field, "extra-large");
  expect(extra.filter((px) => !(px >= 20)), `sizes at extra-large: ${extra}`).toEqual([]);
});

/* The panel is tightest at 360: three acts must still sit wholly on the row
   once opened, none spilling past its edge. */
test.describe("at 360", () => {
  test.use({ viewport: { width: 360, height: 780 } });
  test("people's three acts fit the opened row", async ({ page }) => {
    await open(page);
    await expect(page.locator(".ad-pocket [data-row-panel]:not([hidden])")).toHaveCount(0);
    const emma = row(page, "[data-ad=people]", "Emma Harlow");
    await openRow(page, emma);
    await expect(emma.getByRole("button", { name: "Place Emma Harlow in a system" })).toBeVisible();
    await expect(emma.getByRole("button", { name: "Send Emma Harlow a new setup link" })).toBeVisible();
    await expect(emma.getByRole("button", { name: "Disable Emma Harlow" })).toBeVisible();
    const spill = await emma.locator("[data-row-acts]").evaluate((tray) =>
      [...tray.querySelectorAll("button")].some((b) => b.getBoundingClientRect().right > tray.getBoundingClientRect().right + 0.5));
    expect(spill).toBe(false);
  });
});
