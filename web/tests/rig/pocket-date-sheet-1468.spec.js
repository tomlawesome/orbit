import { expect, test } from "@playwright/test";

import { APP } from "../fidelity/pocket-states.js";

/*
 * #1468 test-bed defect, owner: "The date chooser should be consistent with
 * the desktop experience". The phone Add form's due-date sheet is the desk
 * calendar (Calendar.svelte, in ChooserCard layout="sheet"): a dark panel with
 * light text, a month header with arrows, a Monday-first grid with today
 * ringed, and a footer with the picked date and its distance from today. It
 * stays a bottom sheet, clear of the fixed "never mind / Add to orbit" bar.
 *
 * Seen on the test bed: the sheet panel is cream (246, 244, 238) while its
 * text inherits light grey (231, 233, 238), so it cannot be read, and the bar
 * covers the foot of the sheet. The colours below are the desk calendar's own
 * computed values, measured on the rig at 1600x1000.
 */

test.use({ reducedMotion: "reduce" });
test.beforeEach(() => {
  test.skip(!test.info().project.name.includes("phone"), "the phone's bottom sheet; the desk calendar is the reference");
});

const DESK = {
  day: "rgb(231, 233, 238)",
  weekday: "rgb(125, 136, 155)",
  month: "rgb(231, 233, 238)",
  arrow: "rgb(159, 166, 178)",
  pickedDate: "rgb(231, 233, 238)",
  todayRing: "rgb(159, 166, 178) 0px 0px 0px 1px inset",
};

/** @param {import("@playwright/test").Page} page */
async function openDue(page) {
  await page.goto(`${APP}/create`, { waitUntil: "load" });
  await page.getByRole("textbox", { name: "name", exact: true }).fill("Date sheet proving");
  await page.locator('[id$="-due"]').click();
  const sheet = page.getByRole("dialog", { name: /^Choose due date/i });
  await expect(sheet.getByRole("grid")).toBeVisible();
  await page.waitForTimeout(900); // the slide up settles
  return sheet;
}

/** A computed colour as [r, g, b] in 0..255, from rgb(), rgba() or color(srgb). @param {string} text */
function channels(text) {
  const numbers = (text.match(/-?\d*\.?\d+/g) ?? []).map(Number);
  return text.startsWith("color(srgb") ? numbers.slice(0, 3).map((n) => n * 255) : numbers.slice(0, 3);
}
/** The alpha of a computed colour: 1 when it names none. @param {string} text */
function alpha(text) {
  const numbers = (text.match(/-?\d*\.?\d+/g) ?? []).map(Number);
  return text.startsWith("color(srgb") ? (numbers[3] ?? 1) : text.startsWith("rgba") ? (numbers[3] ?? 1) : 1;
}
/** @param {number[]} rgb */
function luminance(rgb) {
  const [r, g, b] = rgb.map((v) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
/** @param {number[]} a @param {number[]} b */
function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** The sheet's computed style of one part. @param {import("@playwright/test").Locator} el @param {string} prop */
const style = (el, prop) => el.evaluate((n, p) => getComputedStyle(n)[/** @type {any} */ (p)], prop);

test.describe("the phone due-date sheet is the desk calendar (#1468)", () => {
  test("both phone chooser sheets are opaque, dark and identical (no form text shows through)", async ({ page }) => {
    await page.goto(`${APP}/create`, { waitUntil: "load" });
    await page.getByRole("textbox", { name: "name", exact: true }).fill("Date sheet proving");
    await page.locator('button[aria-label^="Reminders"]').first().click();
    const reminders = page.getByRole("dialog", { name: /Reminders/ });
    await expect(reminders).toBeVisible();
    await page.waitForTimeout(900);
    const remindBack = await style(reminders, "backgroundColor");
    await page.keyboard.press("Escape");
    await expect(reminders).toHaveCount(0);

    const sheet = await openDue(page);
    const dueBack = await style(sheet, "backgroundColor");
    expect(dueBack, "the two sheets share one background").toBe(remindBack);
    for (const [name, back] of [["due date", dueBack], ["Reminders", remindBack]]) {
      expect(alpha(back), `${name} sheet is opaque`).toBe(1);
      expect(luminance(channels(back)), `${name} sheet is dark`).toBeLessThan(0.05);
    }
  });

  test("every day's text reads at 4.5:1 or better against the panel", async ({ page }) => {
    const sheet = await openDue(page);
    const back = channels(await style(sheet, "backgroundColor"));
    const days = sheet.locator(".day:not(.off):not(.past)");
    const count = await days.count();
    expect(count).toBeGreaterThan(5);
    for (let i = 0; i < count; i += 1) {
      const text = channels(await style(days.nth(i), "color"));
      const opacity = Number(await days.nth(i).evaluate((n) => { let o = 1; for (let e = n; e; e = e.parentElement) o *= Number(getComputedStyle(e).opacity); return o; }));
      const seen = text.map((v, k) => v * opacity + back[k] * (1 - opacity));
      expect(contrast(seen, back), `day ${i}`).toBeGreaterThanOrEqual(4.5);
    }
    for (const part of [".nav b", ".dow"]) {
      expect(contrast(channels(await style(sheet.locator(part).first(), "color")), back), part).toBeGreaterThanOrEqual(4.5);
    }
  });

  test("the parts wear the desk calendar's colours", async ({ page }) => {
    const sheet = await openDue(page);
    expect(await style(sheet.locator(".day:not(.off):not(.past)").first(), "color")).toBe(DESK.day);
    expect(await style(sheet.locator(".dow").first(), "color")).toBe(DESK.weekday);
    expect(await style(sheet.locator(".nav b"), "color")).toBe(DESK.month);
    expect(await style(sheet.locator(".arrow").first(), "color")).toBe(DESK.arrow);
    expect(await style(sheet.locator(".foot .when b"), "color")).toBe(DESK.pickedDate);
    expect(await style(sheet.locator(".day.today"), "boxShadow"), "today is ringed as on the desk").toBe(DESK.todayRing);
  });

  test("has a month header with arrows, a Monday-first week, today ringed, and a footer", async ({ page }) => {
    const sheet = await openDue(page);
    await expect(sheet.locator(".dow")).toHaveText(["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"]);
    const header = sheet.locator(".nav b");
    await expect(header).toHaveText(/^[A-Z][a-z]+ \d{4}$/);
    const before = await header.textContent();
    await sheet.getByRole("button", { name: "Next month" }).click();
    await expect(header).not.toHaveText(/** @type {string} */ (before));
    await sheet.getByRole("button", { name: "Previous month" }).click();
    await expect(header).toHaveText(/** @type {string} */ (before));
    await expect(sheet.locator(".day.today")).toHaveCount(1);
    await expect(sheet.locator(".foot")).toContainText(/\d{2} [A-Z][a-z]+ \d{4}/);
  });

  test("after a pick, the footer says the date and its distance from today", async ({ page }) => {
    const sheet = await openDue(page);
    const today = /** @type {string} */ (await sheet.locator(".day.today").getAttribute("data-iso"));
    const ahead = new Date(`${today}T12:00:00Z`);
    ahead.setUTCDate(ahead.getUTCDate() + 10);
    const iso = ahead.toISOString().slice(0, 10);
    const cell = sheet.locator(`[data-iso="${iso}"]`);
    if ((await cell.count()) === 0) await sheet.getByRole("button", { name: "Next month" }).click();
    await sheet.locator(`[data-iso="${iso}"]`).click();
    await expect(sheet).toHaveCount(0);
    await page.locator('[id$="-due"]').click();
    const again = page.getByRole("dialog", { name: /^Choose due date/i });
    await expect(again.locator(".day.chosen")).toHaveAttribute("data-iso", iso);
    const long = new Intl.DateTimeFormat("en-GB", { day: "2-digit", month: "long", year: "numeric", timeZone: "UTC" }).format(ahead);
    await expect(again.locator(".foot")).toContainText(long);
    await expect(again.locator(".foot .rel")).toContainText(/10\s*d/);
  });

  test("the sheet's last row of days is not covered by the never mind / Add to orbit bar", async ({ page }) => {
    const sheet = await openDue(page);
    const bar = page.locator(".pk-bar");
    const lastRow = await sheet.locator(".day").evaluateAll((nodes) => {
      const boxes = nodes.map((n) => n.getBoundingClientRect());
      const bottom = Math.max(...boxes.map((b) => b.bottom));
      return nodes.filter((n, i) => boxes[i].bottom >= bottom - 1).map((n) => {
        const b = n.getBoundingClientRect();
        return { bottom: b.bottom };
      });
    });
    expect(lastRow.length).toBeGreaterThan(0);
    const barBox = await bar.boundingBox();
    /* Hidden to the eye. Inert is not enough: the page behind the sheet is inert
       while it stands (the bar is), and the bar is still drawn over the sheet. */
    const hidden = barBox === null || (await bar.evaluate((n) => getComputedStyle(n).display === "none"
      || getComputedStyle(n).visibility === "hidden" || Number(getComputedStyle(n).opacity) === 0));
    if (!hidden) {
      const top = /** @type {{ y: number }} */ (barBox).y;
      for (const day of lastRow) expect(day.bottom, "the last row ends above the bar").toBeLessThanOrEqual(top);
    }
  });
});
