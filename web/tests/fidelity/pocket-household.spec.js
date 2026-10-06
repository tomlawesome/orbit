import { expect, test } from "@playwright/test";
import { openRow, settle } from "./pocket-states.js";

/* Same app the fidelity gate photographs (playwright.config.js webServer). */
const APP = process.env.FIDELITY_APP ?? "http://127.0.0.1:4173";

/*
 * THE HOUSEHOLD ON A PHONE (#1122, proposal §2.10; owner decisions on #1122
 * and design/owner-decisions.md §25; review round §1.1, §2.5), driven in a
 * real browser at 390x844 with touch on:
 *   · a tap opens a row's acts in place: nothing shows at rest and only one
 *     row in a list is open at a time
 *   · keyboard: Enter/Space on the face opens it, Tab walks the pills,
 *     Escape closes it and returns focus to the face
 *   · screen readers: each act is a real named button, out of the page
 *     (aria-expanded, aria-controls, `hidden`) until its row opens
 *   · the save bar rises when something is unsaved, undo puts it away, and
 *     a failed save stays on it in red (2b)
 */
test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

const HOUSEHOLD = "/household/hh-lawson-1";

/** @param {import("@playwright/test").Page} page */
async function open(page) {
  await page.goto(`${APP}${HOUSEHOLD}`, { waitUntil: "load" });
  await settle(page);
}

/** @param {import("@playwright/test").Page} page @param {string} scope @param {string} text */
const row = (page, scope, text) => page.locator(`${scope} [data-row]`, { hasText: text }).first();

test("every row's panel is shut at rest, and its acts are out of the page", async ({ page }) => {
  await open(page);
  const shut = await page.evaluate(() =>
    [...document.querySelectorAll("[data-row-panel]")].every((panel) => panel instanceof HTMLElement && panel.hidden));
  expect(shut, "a row's panel is open without a tap").toBe(true);
  for (const name of [
    "Remove Emma Lawson", "Hand Lawson Home over to Gran", "Leave Lawson Home",
    "Withdraw the invitation to daniel.lawson@example.com", "Remove Services",
  ]) {
    await expect(page.getByRole("button", { name }), name).toHaveCount(0);
  }
});

test("a tap opens a member's row, and only that row's acts show", async ({ page }) => {
  await open(page);
  const emma = row(page, ".hh-members", "Emma Lawson");
  await openRow(page, emma);
  await expect(emma).toHaveAttribute("data-open", "");
  await expect(emma.getByRole("button", { name: "Hand Lawson Home over to Emma Lawson" })).toBeVisible();
  await expect(emma.getByRole("button", { name: "Remove Emma Lawson" })).toBeVisible();
  await expect(row(page, ".hh-members", "Rob Lawson")).not.toHaveAttribute("data-open", "");
});

test("an invitation's acts are in its opened row", async ({ page }) => {
  await open(page);
  const invite = row(page, ".hh-members", "daniel.lawson@example.com");
  await openRow(page, invite);
  await expect(invite).toHaveAttribute("data-open", "");
  await expect(invite.getByRole("button", { name: "Resend the invitation to daniel.lawson@example.com" })).toBeVisible();
  await expect(invite.getByRole("button", { name: "Withdraw the invitation to daniel.lawson@example.com" })).toBeVisible();
});

test("keyboard: Enter opens the face, Tab walks the acts, Escape hides and returns focus", async ({ page }) => {
  await open(page);
  const face = row(page, ".hh-members", "Rob Lawson").locator("[data-row-face]");
  await face.focus();
  await page.keyboard.press("Enter");
  const rob = row(page, ".hh-members", "Rob Lawson");
  await expect(rob).toHaveAttribute("data-open", "");
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "Hand Lawson Home over to Rob Lawson" })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "Remove Rob Lawson" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(rob).not.toHaveAttribute("data-open", "");
  await expect(face).toBeFocused();
});

test("tabbing across a shut row's face never reaches its acts", async ({ page }) => {
  await open(page);
  await row(page, ".hh-members", "Tom Lawson").locator("[data-row-face]").focus();
  for (let i = 0; i < 4; i++) {
    await page.keyboard.press("Tab");
    const inTray = await page.evaluate(() => Boolean(document.activeElement?.closest("[data-row-acts]")));
    expect(inTray).toBe(false);
  }
});

test("a knock keeps approve and decline on show", async ({ page }) => {
  await page.route("**/api/join-requests", (route) => route.fulfill({
    status: 200, contentType: "application/json",
    body: JSON.stringify({ requests: [{ id: "jr-1", householdId: "hh-lawson-1", userId: "u-ben", displayName: "Ben Lawson", createdAt: "2026-08-11T09:00:00Z" }] }),
  }));
  await open(page);
  await expect(page.getByRole("button", { name: "Approve Ben Lawson" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Decline Ben Lawson" })).toBeVisible();
});

test("the save bar rises with a change, counts it, and undo puts it away", async ({ page }) => {
  await open(page);
  const bar = page.locator("[data-hh=savebar]");
  await expect(bar).toBeHidden();
  const services = page.getByRole("switch", { name: "Services shown on the chart" });
  await services.scrollIntoViewIfNeeded();
  await services.click();
  await expect(services).toHaveAttribute("aria-checked", "false");
  await expect(bar).toBeVisible();
  await expect(bar).toContainText("1 change");
  await page.fill("#hh-name", "Lawson House");
  await expect(bar).toContainText("2 changes");
  await bar.getByRole("button", { name: "undo" }).click();
  await expect(bar).toBeHidden();
  await expect(services).toHaveAttribute("aria-checked", "true");
  await expect(page.locator("#hh-name")).toHaveValue("Lawson Home");
});

test("a failed save stays on the bar in red until the next attempt", async ({ page }) => {
  await page.route("**/api/workspace/commands", (route) => route.fulfill({
    status: 500, contentType: "application/json",
    body: JSON.stringify({ error: { code: "internal", message: "Orbit could not store the sections just now" } }),
  }));
  await open(page);
  const services = page.getByRole("switch", { name: "Services shown on the chart" });
  await services.scrollIntoViewIfNeeded();
  await services.click();
  const bar = page.locator("[data-hh=savebar]");
  await bar.getByRole("button", { name: "save" }).click();
  await expect(bar.getByRole("alert")).toHaveText("not saved — Orbit could not store the sections just now");
  await page.waitForTimeout(4500);
  await expect(bar.getByRole("alert")).toBeVisible();
  await expect(services).toHaveAttribute("aria-checked", "false");
});

test("sections reorder from the keyboard (Alt-↓), and the move collects into the bar", async ({ page }) => {
  await open(page);
  const titles = () => page.locator(".hh-sections [data-row] .title").allTextContents();
  const before = await titles();
  const face = row(page, ".hh-sections", "Home").locator("[data-row-face]");
  await face.focus();
  await page.keyboard.press("Alt+ArrowDown");
  expect(await titles()).toEqual([before[1], before[0], ...before.slice(2)]);
  await expect(page.locator("[data-hh=savebar]")).toContainText("1 change");
});

test("a section's acts open with edit first, then move up/down, then remove", async ({ page }) => {
  await open(page);
  const services = row(page, ".hh-sections", "Services");
  await openRow(page, services);
  const names = await services.locator("[data-row-acts] > *").evaluateAll(
    (pills) => pills.map((el) => el.getAttribute("aria-label")));
  expect(names).toEqual([
    "Edit Services", "Move Services up", "Move Services down", "Remove Services",
  ]);
  /* The first row offers no move up; the last offers no move down. */
  const home = row(page, ".hh-sections", "Home");
  await openRow(page, home);
  await expect(home.getByRole("button", { name: "Move Home up" })).toHaveCount(0);
  const dates = row(page, ".hh-sections", "Dates & renewals");
  await openRow(page, dates);
  await expect(dates.getByRole("button", { name: "Move Dates & renewals down" })).toHaveCount(0);
});
