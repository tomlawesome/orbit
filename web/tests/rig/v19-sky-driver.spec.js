import { expect, test } from "@playwright/test";

import { APP, RIG_EXPECT_MS, RIG_TEST_MS, onPhone, signedIn } from "./a11y-support.js";
import { useFixtureScenes } from "../fidelity/pocket-states.js";

/*
 * #1462: planets sit by the due date or by the user's warning date, a per-user
 * setting, set in Settings > Your sky > Planets beside the live sky (#1461).
 * Both dialects; the fixture app's Harlow Home, today pinned to 2026-08-13.
 *
 * Harlow Home's Gutter clearing is overdue by 16 days and carries its own
 * reminder days [14, 3]: by its warning date it sits 30 days past, nearer the
 * sun on the overdue curve. It is drawn on both dialects (the phone draws the
 * overdue planet), so it is the known planet. Boiler service (22 days, own
 * reminder days [14]) is also drawn on the desk: by its warning date it is 8
 * days out, nearer the sun.
 *
 * Names this spec fixes for the build:
 *  - Settings > Planets holds a row labelled "planets sit by": a group
 *    (role=group, aria-label "Planets sit by") with two buttons, "due date" and
 *    "my warning date", each carrying aria-pressed; "due date" is pressed by
 *    default;
 *  - under it the hint "Your first warning is N days before, so each planet
 *    sits N days nearer the sun." (the fixture's first-warning days are 14);
 *  - the live preview (role=img, label ends "<N> names shown") draws planets
 *    as `[data-pl="<item id>"]`; a planet's radius is read from the preview's
 *    svg centre to the centre of that group's first circle;
 *  - pressing a button saves at once with PUT /api/preferences, body.skyDriver
 *    "due" | "warning"; the fixture server holds that for a browser that asked
 *    for the `keep-saves` scene and answers the session (and so home) with it;
 *  - the desk draws a planet as `.body-link[data-body=<id>]` (its data-t and
 *    aria-label are the callout's date text) inside `svg.dial`; the phone as
 *    `.mdial .pk-body[data-body=<id>]`, its date text in the manifest row
 *    `[data-row-key=<id>]` (the row's first `.trail`). Neither changes.
 */
test.use({ baseURL: APP });
test.describe.configure({ timeout: RIG_TEST_MS });

const HINT = "Your first warning is 14 days before, so each planet sits 14 days nearer the sun.";

/** @param {import("@playwright/test").Page} page */
const group = (page) => page.getByRole("group", { name: "Planets sit by" });
/** @param {import("@playwright/test").Page} page */
const dueButton = (page) => group(page).getByRole("button", { name: "due date", exact: true });
/** @param {import("@playwright/test").Page} page */
const warningButton = (page) => group(page).getByRole("button", { name: "my warning date", exact: true });
/** @param {import("@playwright/test").Page} page */
const preview = (page) => page.getByRole("img", { name: /\d+ names? shown$/ });

/**
 * Waits for every running finite animation on the element, its ancestors and its descendants (home's `arrive` entrance
 * scales the dial from .16 to 1) to finish, so geometry is read at rest. An end
 * state, not a delay.
 * @param {import("@playwright/test").Locator} anyElement
 */
async function atRest(anyElement) {
  await anyElement.evaluate(async (el) => {
    const finite = () => el.ownerDocument.getAnimations().filter((a) => {
      const target = /** @type {Element | null} */ (a.effect && "target" in a.effect ? a.effect.target : null);
      return target && (target.contains(el) || el.contains(target)) && Number.isFinite(a.effect?.getComputedTiming().endTime ?? Infinity) && a.playState === "running";
    });
    for (let pending = finite(); pending.length; pending = finite()) await Promise.all(pending.map((a) => a.finished.catch(() => undefined)));
  });
}

/**
 * Distance, in screen px, between the centres of two elements.
 * @param {import("@playwright/test").Locator} centre
 * @param {import("@playwright/test").Locator} planet
 */
async function distance(centre, planet) {
  await expect(planet).toBeAttached({ timeout: RIG_EXPECT_MS });
  await atRest(planet);
  const [c, p] = await Promise.all([centre.boundingBox(), planet.boundingBox()]);
  if (!c || !p) throw new Error("no box to measure");
  return Math.hypot(p.x + p.width / 2 - (c.x + c.width / 2), p.y + p.height / 2 - (c.y + c.height / 2));
}

/** A planet's distance from the sun in the Settings preview.
 * @param {import("@playwright/test").Page} page
 * @param {string} id */
const previewRadius = (page, id) => distance(preview(page), preview(page).locator(`[data-pl="${id}"] circle`).first());

/** A planet's distance from the sun on home, as the dialect draws it.
 * @param {import("@playwright/test").Page} page
 * @param {string} id
 * @param {boolean} phone */
function homeRadius(page, id, phone) {
  return phone
    ? distance(page.locator(".mdial svg").first(), page.locator(`.mdial .pk-body[data-body="${id}"] circle`).first())
    : distance(page.locator("svg.dial").first(), page.locator(`.body-link[data-body="${id}"] circle`).first());
}

/** The date text home gives a planet: the callout's on the desk, the manifest row's on the phone.
 * @param {import("@playwright/test").Page} page
 * @param {string} id
 * @param {boolean} phone */
async function dateText(page, id, phone) {
  if (phone) return (await page.locator(`[data-row-key="${id}"] .trail`).first().textContent()) ?? "";
  const link = page.locator(`.body-link[data-body="${id}"]`);
  return `${await link.getAttribute("data-t")} | ${await link.getAttribute("aria-label")}`;
}

/** @param {import("@playwright/test").Page} page */
async function openHome(page) {
  await page.goto(`${APP}/home`);
  await page.locator("body[data-home-ready]").waitFor({ state: "attached" });
}

/** @param {boolean} phone */
const known = (phone) => (phone ? ["i-gutter"] : ["i-gutter", "i-boiler"]);

test("settings: the row 'planets sit by' starts on the due date, with its hint", async ({ page }) => {
  await signedIn("/settings", "rest")(page);
  await expect(group(page)).toBeVisible({ timeout: RIG_EXPECT_MS });
  await expect(page.getByText("planets sit by", { exact: true })).toBeVisible();
  await expect(dueButton(page)).toHaveAttribute("aria-pressed", "true");
  await expect(warningButton(page)).toHaveAttribute("aria-pressed", "false");
  await expect(page.getByText(HINT)).toBeVisible();
  /* the second row of the Planets group, under 'names up close' */
  const rows = page.locator(".kv", { has: page.locator("span", { hasText: /^(names up close|planets sit by)$/ }) });
  await expect(rows.nth(0)).toContainText("names up close");
  await expect(rows.nth(1)).toContainText("planets sit by");
});

test("settings: my warning date moves the planets nearer the sun, saves, and home follows; due date puts them back", async ({ page }, testInfo) => {
  const phone = onPhone(testInfo);
  await useFixtureScenes(page, "keep-saves");

  /* home as it is by the due date */
  await openHome(page);
  /** @type {Record<string, number>} */
  const homeDue = {};
  /** @type {Record<string, string>} */
  const homeText = {};
  for (const id of known(phone)) {
    homeDue[id] = await homeRadius(page, id, phone);
    homeText[id] = await dateText(page, id, phone);
  }

  await signedIn("/settings", "rest")(page);
  await expect(group(page)).toBeVisible({ timeout: RIG_EXPECT_MS });
  /** @type {Record<string, number>} */
  const previewDue = {};
  for (const id of known(phone)) previewDue[id] = await previewRadius(page, id);

  /* press "my warning date": pressed, saved, and the live sky draws the planets nearer */
  const saved = page.waitForRequest((request) => request.url().endsWith("/api/preferences") && request.method() === "PUT");
  await warningButton(page).click();
  await expect(warningButton(page)).toHaveAttribute("aria-pressed", "true");
  await expect(dueButton(page)).toHaveAttribute("aria-pressed", "false");
  expect((await saved).postDataJSON().skyDriver).toBe("warning");
  for (const id of known(phone)) {
    await expect.poll(() => previewRadius(page, id), { timeout: RIG_EXPECT_MS, message: `${id} in the preview` }).toBeLessThan(previewDue[id] - 1);
  }
  await expect(page.getByText(HINT)).toBeVisible();

  /* after a reload, home draws them nearer too, with the real due date text */
  await openHome(page);
  for (const id of known(phone)) {
    expect(await homeRadius(page, id, phone), `${id} on home`).toBeLessThan(homeDue[id] - 1);
    expect(await dateText(page, id, phone), `${id} date text`).toBe(homeText[id]);
  }

  /* the setting is still there on a reload of Settings */
  await page.goto(`${APP}/settings`);
  await expect(group(page)).toBeVisible({ timeout: RIG_EXPECT_MS });
  await expect(warningButton(page)).toHaveAttribute("aria-pressed", "true");
  await expect(dueButton(page)).toHaveAttribute("aria-pressed", "false");

  /* press "due date": back where they were */
  const savedBack = page.waitForRequest((request) => request.url().endsWith("/api/preferences") && request.method() === "PUT");
  await dueButton(page).click();
  await expect(dueButton(page)).toHaveAttribute("aria-pressed", "true");
  await expect(warningButton(page)).toHaveAttribute("aria-pressed", "false");
  expect((await savedBack).postDataJSON().skyDriver).toBe("due");
  for (const id of known(phone)) {
    await expect.poll(() => previewRadius(page, id), { timeout: RIG_EXPECT_MS, message: `${id} in the preview` }).toBeCloseTo(previewDue[id], 0);
  }
  await openHome(page);
  for (const id of known(phone)) {
    expect(await homeRadius(page, id, phone), `${id} on home`).toBeCloseTo(homeDue[id], 0);
    expect(await dateText(page, id, phone), `${id} date text`).toBe(homeText[id]);
  }
});

test("settings: the planets-sit-by buttons are keyboard buttons, and the hint is not a control", async ({ page }) => {
  await signedIn("/settings", "rest")(page);
  await expect(group(page)).toBeVisible({ timeout: RIG_EXPECT_MS });
  await expect(group(page).getByRole("button")).toHaveCount(2);
  await warningButton(page).focus();
  await expect(warningButton(page)).toBeFocused();
  await expect(page.getByText(HINT)).toBeVisible();
  await expect(page.getByText(HINT).getByRole("button")).toHaveCount(0);
});
