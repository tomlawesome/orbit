import { expect, test } from "@playwright/test";

/* Same app the fidelity gate photographs (playwright.config.js webServer). */
const APP = process.env.FIDELITY_APP ?? "http://127.0.0.1:4173";

/*
 * THE HOUSEHOLD ON A PHONE (#1122, proposal §2.10; owner decisions on #1122
 * and design/owner-decisions.md §25), driven in a real browser at 390x844
 * with touch on:
 *   · row acts are revealed only by a left/right swipe: nothing shows at
 *     rest and a tap on the row opens nothing
 *   · keyboard: focus the row, ← or → reveals, Tab walks the acts, Escape
 *     hides and returns to the row
 *   · screen readers: each act is a real button named with its object,
 *     out of the sighted Tab order until revealed
 *   · the save bar rises when something is unsaved, undo puts it away, and
 *     a failed save stays on it in red (2b)
 */
test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

const HOUSEHOLD = "/household/hh-lawson-1";

/** @param {import("@playwright/test").Page} page */
async function open(page) {
  await page.goto(`${APP}${HOUSEHOLD}`, { waitUntil: "load" });
  await page.waitForLoadState("networkidle");
  await page.evaluate(() => document.fonts.ready);
}

/**
 * A real touch swipe (Chromium's touch pipeline, so touch-action applies).
 * @param {import("@playwright/test").Page} page
 * @param {import("@playwright/test").Locator} row
 * @param {number} dx
 */
async function swipe(page, row, dx) {
  const box = /** @type {{ x: number, y: number, width: number, height: number }} */ (await row.boundingBox());
  const from = { x: box.x + box.width - 60, y: box.y + box.height / 2 };
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [from] });
  for (let i = 1; i <= 8; i++) {
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: from.x + (dx * i) / 8, y: from.y }] });
    await page.waitForTimeout(16);
  }
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await cdp.detach();
}

/** Every act button on the page that a finger could hit at its centre right now. @param {import("@playwright/test").Page} page */
const hittableActs = (page) => page.evaluate(() =>
  [...document.querySelectorAll(".hh-pocket [data-row-acts] button")].filter((b) => {
    const r = b.getBoundingClientRect();
    if (r.width <= 1 || r.bottom < 0 || r.top > innerHeight) return false;
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return Boolean(hit && b.contains(hit));
  }).map((b) => b.getAttribute("aria-label")));

test("no row act is visible at rest, and a tap on a row opens none", async ({ page }) => {
  await open(page);
  expect(await hittableActs(page)).toEqual([]);
  const emma = page.locator(".hh-members [data-row]", { hasText: "Emma Lawson" });
  await emma.locator("[data-row-face]").tap();
  await page.waitForTimeout(300);
  await expect(emma).not.toHaveAttribute("data-open", "");
  expect(await hittableActs(page)).toEqual([]);
});

test("a left swipe reveals a member's acts, and only that row's", async ({ page }) => {
  await open(page);
  const emma = page.locator(".hh-members [data-row]", { hasText: "Emma Lawson" });
  await swipe(page, emma, -200);
  await expect(emma).toHaveAttribute("data-open", "");
  await page.waitForTimeout(300);
  expect((await hittableActs(page)).sort()).toEqual(["Hand Lawson Home over to Emma Lawson", "Remove Emma Lawson"]);
});

test("an invitation's acts are behind the same swipe", async ({ page }) => {
  await open(page);
  const invite = page.locator(".hh-members [data-row]", { hasText: "daniel.lawson@example.com" });
  await invite.scrollIntoViewIfNeeded();
  await swipe(page, invite, -200);
  await expect(invite).toHaveAttribute("data-open", "");
  await page.waitForTimeout(300);
  expect((await hittableActs(page)).sort()).toEqual([
    "Resend the invitation to daniel.lawson@example.com",
    "Withdraw the invitation to daniel.lawson@example.com",
  ]);
});

test("keyboard: focus the row, an arrow reveals, Tab walks the acts, Escape hides", async ({ page }) => {
  await open(page);
  const face = page.getByRole("group", { name: "Rob Lawson" });
  await face.focus();
  await page.keyboard.press("ArrowRight");
  const row = page.locator("[data-row]", { has: face });
  await expect(row).toHaveAttribute("data-open", "");
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "Hand Lawson Home over to Rob Lawson" })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "Remove Rob Lawson" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(row).not.toHaveAttribute("data-open", "");
  await expect(face).toBeFocused();
});

test("screen readers: every act is a named button, out of the Tab order at rest", async ({ page }) => {
  await open(page);
  for (const name of [
    "Remove Emma Lawson", "Hand Lawson Home over to Gran", "Leave Lawson Home",
    "Withdraw the invitation to daniel.lawson@example.com", "Remove Services",
  ]) {
    const button = page.getByRole("button", { name });
    await expect(button, name).toHaveCount(1);
    await expect(button, name).toHaveAttribute("tabindex", "-1");
  }
  /* Tabbing through the members card never lands on an act. */
  await page.getByRole("group", { name: "Tom Lawson · you" }).focus();
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
  const face = page.getByRole("group", { name: "Home" });
  await face.focus();
  await page.keyboard.press("Alt+ArrowDown");
  expect(await titles()).toEqual([before[1], before[0], ...before.slice(2)]);
  await expect(page.locator("[data-hh=savebar]")).toContainText("1 change");
});
