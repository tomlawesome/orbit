import { expect, test } from "@playwright/test";

import { APP, useFixtureScenes } from "../fidelity/pocket-states.js";
import { ownWorkspace, upsertLikeTheEngine } from "./workspace-writes.js";

/*
 * #1468 Part A (spec: note 53008; owner decision 43; round 6 direction Q,
 * design/v19/home-sun/round-6/q-add-chooser-card.html): on the desk, Add's key
 * date, repeat and reminder are pressed values (buttons with
 * aria-haspopup="dialog" showing the current value) that stand the chooser
 * card in the lane, beside the form, where a dropped document is read:
 *
 *   - the key date opens the calendar (Calendar.svelte, role=grid);
 *   - repeat opens the repeat band (RepeatBand.svelte, a radiogroup);
 *   - reminders open day chips 7 / 14 / 30 / 60 / 90, any number at once,
 *     in a group named "Remind me this many days before".
 *
 * The pressed values keep the ids their labels point at: #f-date, #f-recur,
 * #f-reminder. The card is a role=dialog named "Choose <heading>".
 *
 * What the create sends (web/src/routes/create/entry.js intentOf): one
 * item.upsert whose item carries dueDate, recurrenceMonths and reminderDays,
 * an ARRAY of days. So the create path accepts several reminders (the engine
 * refuses too many, #1325), and the chips are not limited to one.
 *
 * Desk only. Every case fails today: the controls are native.
 */

test.use({
  reducedMotion: "reduce",
  serviceWorkers: async ({}, use, testInfo) => {
    await use(testInfo.project.use.browserName === "webkit" ? "block" : "allow");
  },
});

const SETTLE = 20_000;
const DOCUMENT_BYTES = Buffer.concat([Buffer.from("%PDF-1.4\n"), Buffer.alloc(2048, 32), Buffer.from("%%EOF\n")]);
/* the fixture's today is 2026-08-13 (fixtures/workspace.js) */
const KEY_DATE = "2026-08-20";

test.beforeEach(() => {
  test.skip(test.info().project.name.includes("phone"), "the desk's lane; the phone's due date is proven in tests/unit/add-chooser-card-1468.test.mjs");
});

/** @param {import("@playwright/test").Page} page */
async function gotoCreate(page) {
  await page.goto(`${APP}/create`, { waitUntil: "load" });
  await page.locator("#card[data-ready]").waitFor({ state: "attached", timeout: SETTLE });
}

/** The writes of a create answered for this test: the workspace takes the item, the document stage answers 201. @param {import("@playwright/test").Page} page */
async function savesAnswered(page) {
  const writes = await ownWorkspace(page, { "item.upsert": upsertLikeTheEngine });
  await page.route(/\/api\/households\/[^/]+\/documents$/, async (route) => {
    const request = route.request();
    if (request.method() !== "POST") return route.fallback();
    return route.fulfill({
      status: 201,
      json: { document: {
        id: request.headers()["x-orbit-document-id"], itemId: request.headers()["x-orbit-item-id"], displayName: "chooser.pdf",
        mediaType: "application/pdf", sizeBytes: 15, lifecycle: "stored", scanStatus: "clean", availableAt: new Date().toISOString(),
        deleteAfter: null, ready: true, failureCode: null, recoverable: false, recoveryExpiresAt: null, recoveryStatus: null,
      } },
      headers: { "cache-control": "no-store" },
    });
  });
  return { upserts: () => writes.sent("item.upsert") };
}

/** The chooser card standing now. @param {import("@playwright/test").Page} page @param {RegExp} name */
const chooser = (page, name) => page.getByRole("dialog", { name });

const dateValue = (/** @type {import("@playwright/test").Page} */ page) => page.locator("button#f-date");
const repeatValue = (/** @type {import("@playwright/test").Page} */ page) => page.locator("button#f-recur");
const reminderValue = (/** @type {import("@playwright/test").Page} */ page) => page.locator("button#f-reminder");

/** A renewal named, a document picked, a section chosen: what the form needs before Add. @param {import("@playwright/test").Page} page @param {string} name */
async function fillTheRest(page, name) {
  await page.locator('#card input[type="file"]').setInputFiles({ name: "chooser.pdf", mimeType: "application/pdf", buffer: DOCUMENT_BYTES });
  await page.locator("#f-name").fill(name);
  await page.getByRole("group", { name: /^section/ }).getByRole("button", { name: "Home" }).click();
}

/** Opens the calendar from the key date and picks a day. @param {import("@playwright/test").Page} page @param {string} iso */
async function pickDate(page, iso) {
  await dateValue(page).click();
  await chooser(page, /^Choose key date/i).locator(`[data-iso="${iso}"]`).click();
}

test.describe("desk Add: the chooser card in the lane (#1468, Q)", () => {
  test("shows key date, repeat and reminder as pressed values, and no native control", async ({ page }) => {
    await gotoCreate(page);
    await expect(page.locator("#card select, #card input[type=date]")).toHaveCount(0);
    for (const value of [dateValue(page), repeatValue(page), reminderValue(page)]) {
      await expect(value).toHaveAttribute("aria-haspopup", "dialog");
    }
    await expect(repeatValue(page)).toContainText(/every 12 months|yearly/i);
    await expect(reminderValue(page)).toContainText(/14\s*d/i);
  });

  test("pressing the key date opens the calendar in the lane, beside the form", async ({ page }) => {
    await gotoCreate(page);
    await dateValue(page).click();
    const card = chooser(page, /^Choose key date/i);
    await expect(card.getByRole("grid")).toBeVisible();
    const form = /** @type {{ x: number, width: number }} */ (await page.locator("#card").boundingBox());
    const stood = /** @type {{ x: number }} */ (await card.boundingBox());
    expect(stood.x, "the card stands beside the form, not over it").toBeGreaterThanOrEqual(form.x + form.width - 2);
  });

  test("picking a day updates the pressed value", async ({ page }) => {
    await gotoCreate(page);
    await pickDate(page, KEY_DATE);
    await expect(dateValue(page)).toContainText("20 Aug 2026");
  });

  test("pressing repeat opens the repeat band, and choosing a period updates the value", async ({ page }) => {
    await gotoCreate(page);
    await repeatValue(page).click();
    const card = chooser(page, /^Choose repeat/i);
    await expect(card.getByRole("radiogroup")).toBeVisible();
    await card.getByRole("radio", { name: /6 months/i }).click();
    await expect(repeatValue(page)).toContainText(/every 6 months/i);
  });

  test("pressing reminder opens day chips 7, 14, 30, 60 and 90, and several can be chosen at once", async ({ page }) => {
    await gotoCreate(page);
    await reminderValue(page).click();
    const card = chooser(page, /^Choose reminders/i);
    const chips = card.getByRole("group", { name: "Remind me this many days before" });
    await expect(chips.getByRole("button")).toHaveText(["7d", "14d", "30d", "60d", "90d"]);
    await chips.getByRole("button", { name: "30d" }).click();
    await chips.getByRole("button", { name: "60d" }).click();
    for (const day of ["14d", "30d", "60d"]) await expect(chips.getByRole("button", { name: day })).toHaveAttribute("aria-pressed", "true");
    await expect(chips.getByRole("button", { name: "7d" })).toHaveAttribute("aria-pressed", "false");
    await expect(reminderValue(page)).toContainText(/14\s*d/);
    await expect(reminderValue(page)).toContainText(/30\s*d/);
    await expect(reminderValue(page)).toContainText(/60\s*d/);
  });

  for (const [title, value, name] of /** @type {const} */ ([
    ["key date", dateValue, /^Choose key date/i],
    ["repeat", repeatValue, /^Choose repeat/i],
    ["reminder", reminderValue, /^Choose reminders/i],
  ])) {
    test(`Escape closes the ${title} card and returns focus to the pressed value`, async ({ page }) => {
      await gotoCreate(page);
      await value(page).click();
      await expect(chooser(page, name)).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(chooser(page, name)).toHaveCount(0);
      await expect(value(page)).toBeFocused();
    });
  }

  test("saving sends the date and the yearly repeat the native controls sent", async ({ page }) => {
    await useFixtureScenes(page, "keep-saves");
    const saves = await savesAnswered(page);
    await gotoCreate(page);
    await fillTheRest(page, "Chooser date proving");
    await pickDate(page, KEY_DATE);
    await page.locator(".btn-primary").click();
    await expect(page).toHaveURL(/\/home\?item=[0-9a-f-]{36}$/, { timeout: SETTLE });
    const sent = saves.upserts();
    expect(sent.map((one) => [one.item.dueDate, one.item.recurrenceMonths, one.item.reminderDays])).toEqual([[KEY_DATE, 12, [14, 3]]]);
  });

  test("saving sends the repeat and the several reminders that were chosen", async ({ page }) => {
    await useFixtureScenes(page, "keep-saves");
    const saves = await savesAnswered(page);
    await gotoCreate(page);
    await fillTheRest(page, "Chooser repeat proving");
    await pickDate(page, KEY_DATE);
    await repeatValue(page).click();
    await chooser(page, /^Choose repeat/i).getByRole("radio", { name: /6 months/i }).click();
    await reminderValue(page).click();
    const chips = chooser(page, /^Choose reminders/i).getByRole("group", { name: "Remind me this many days before" });
    await chips.getByRole("button", { name: "30d" }).click();
    await chips.getByRole("button", { name: "60d" }).click();
    await page.keyboard.press("Escape");
    await page.locator(".btn-primary").click();
    await expect(page).toHaveURL(/\/home\?item=[0-9a-f-]{36}$/, { timeout: SETTLE });
    const [one] = saves.upserts();
    expect(one.item.dueDate).toBe(KEY_DATE);
    expect(one.item.recurrenceMonths).toBe(6);
    expect(one.item.reminderDays, "reminderDays is an array: several are saved").toEqual(expect.arrayContaining([30, 60]));
  });
});
