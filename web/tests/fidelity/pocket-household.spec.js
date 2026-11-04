import { expect, test } from "@playwright/test";
import { settle } from "./pocket-states.js";

/* Same app the fidelity gate photographs (playwright.config.js webServer). */
const APP = process.env.FIDELITY_APP ?? "http://127.0.0.1:4173";

/*
 * THE HOUSEHOLD ON A PHONE (#1122, proposal §2.10; owner decisions on #1122
 * and design/owner-decisions.md §25; review round §1.1, §2.5), driven in a
 * real browser at 390x844 with touch on. What the rows show and what their
 * acts are called (shut at rest, a tap opens, invitations, knocks, section
 * acts), the save bar's counting, undo and failed save, and the Alt-arrow
 * move are proved on the mounted page in tests/unit/pocket-household.test.mjs
 * (#1613, ADR-0039). What stays here needs a real keyboard:
 *   · keyboard: Enter/Space on the face opens it, Tab walks the pills,
 *     Escape closes it and returns focus to the face
 */
test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

const HOUSEHOLD = "/household/hh-harlow-1";

/** @param {import("@playwright/test").Page} page */
async function open(page) {
  await page.goto(`${APP}${HOUSEHOLD}`, { waitUntil: "load" });
  await settle(page);
}

/** @param {import("@playwright/test").Page} page @param {string} scope @param {string} text */
const row = (page, scope, text) => page.locator(`${scope} [data-row]`, { hasText: text }).first();

test("keyboard: Enter opens the face, Tab walks the acts, Escape hides and returns focus", async ({ page }) => {
  await open(page);
  const face = row(page, ".hh-members", "Rob Harlow").locator("[data-row-face]");
  await face.focus();
  await page.keyboard.press("Enter");
  const rob = row(page, ".hh-members", "Rob Harlow");
  await expect(rob).toHaveAttribute("data-open", "");
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "Hand Harlow Home over to Rob Harlow" })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "Remove Rob Harlow" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(rob).not.toHaveAttribute("data-open", "");
  await expect(face).toBeFocused();
});
