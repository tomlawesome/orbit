import { expect, test } from "@playwright/test";

import { APP, RIG_EXPECT_MS, RIG_TEST_MS, onPhone } from "./a11y-support.js";

/** @typedef {import("@playwright/test").Page} Page */

/*
 * #1618: "a rig test shows the card on desk and phone". The what's-new card
 * (web/src/lib/whats-new/WhatsNew.svelte, ported from
 * design/v19/home-sun/round-5/j-whats-new.html) on the fixture reader's
 * /home, in both dialects: the desk's centred card and the phone's bottom
 * sheet.
 *
 * THE READER. The fixture route answers no releases (screenshots stay
 * still), so this test answers GET /api/whats-new itself, with one release
 * for everyone and one part for administrators, and keeps every dismissal it
 * is sent. The card's behaviour in detail (member and admin parts, newest
 * first, the three dismiss paths, waiting for the film) is in
 * tests/unit/whats-new-card.test.mjs; what is here is what needs a browser:
 * real layout, real focus and Tab, real keys, and the second arrival.
 */
test.use({ baseURL: APP, reducedMotion: "reduce" });
test.describe.configure({ timeout: RIG_TEST_MS });

const NEWS = {
  version: "v0.3.7",
  releases: [{
    version: "v0.3.7",
    forEveryone: [
      { lead: "Planets wear your section’s colour.", text: "Each section has a colour you choose; its items show it on the sky." },
      { lead: "Names up close.", text: "Planets due within 30 days show their name. Change the days in Settings." },
    ],
    forAdministrators: [
      { lead: "Notes like this one.", text: "Every release can carry a note for members and one for administrators; people see each once." },
    ],
  }],
};

/**
 * Answers the card's GET with `body` until a dismissal arrives, then with
 * nothing, as the server would; records each dismissal's body.
 * @param {Page} page
 */
async function answerNews(page) {
  /** @type {any[]} */
  const dismissals = [];
  await page.route("**/api/whats-new", (route) => route.request().method() === "GET"
    ? route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: { "cache-control": "no-store" },
      body: JSON.stringify(dismissals.length ? { version: NEWS.version, releases: [] } : NEWS),
    })
    : route.fallback());
  await page.route("**/api/whats-new/dismiss", (route) => {
    dismissals.push(route.request().postDataJSON());
    return route.fulfill({ status: 200, contentType: "application/json", body: '{"ok":true}' });
  });
  return dismissals;
}

/** @param {Page} page */
async function home(page) {
  await page.goto(`${APP}/home`, { waitUntil: "load" });
  await page.locator("body[data-home-ready]").waitFor({ state: "attached" });
}

test("the card shows once over the sky, desk card or phone sheet, and a second arrival is silent", async ({ page }, testInfo) => {
  const mobile = onPhone(testInfo);
  const dismissals = await answerNews(page);
  await home(page);

  const card = page.getByRole("dialog", { name: "New in this release" });
  await expect(card).toBeVisible({ timeout: RIG_EXPECT_MS });
  await expect(card).toHaveAttribute("aria-modal", "true");
  await expect(card).toContainText(/what['’]s new · orbit 0\.3\.7/i);
  await expect(card.getByRole("listitem")).toHaveCount(3);
  await expect(card).toContainText(/for administrators/i);

  /* Focus starts on the heading, and Tab stays in the card: link, then button. */
  await expect(card.getByRole("heading", { name: "New in this release" })).toBeFocused();
  const link = card.getByRole("link", { name: "All release notes" });
  const gotIt = card.getByRole("button", { name: "Got it" });
  await page.keyboard.press("Tab");
  await expect(link).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(gotIt).toBeFocused();

  /* Where it sits: centred, at most 460 wide, on the desk; a full-width sheet
     on the bottom edge on the phone, its footer in view. */
  const viewport = /** @type {{ width: number, height: number }} */ (page.viewportSize());
  const box = /** @type {{ x: number, y: number, width: number, height: number }} */ (await card.boundingBox());
  if (mobile) {
    expect(Math.round(box.width)).toBe(viewport.width);
    expect(Math.round(box.y + box.height)).toBe(viewport.height);
    await expect(gotIt).toBeInViewport();
    await expect(link).toBeInViewport();
    const tap = /** @type {{ height: number }} */ (await gotIt.boundingBox());
    expect(tap.height).toBeGreaterThanOrEqual(44);
  } else {
    expect(box.width).toBeLessThanOrEqual(460);
    expect(Math.abs(box.x + box.width / 2 - viewport.width / 2)).toBeLessThanOrEqual(2);
    expect(Math.abs(box.y + box.height / 2 - viewport.height / 2)).toBeLessThanOrEqual(2);
  }

  /* No close cross: one button, one link. */
  await expect(card.getByRole("button")).toHaveCount(1);
  await expect(card.getByRole("link")).toHaveCount(1);

  /* Got it dismisses, once, with the version the GET named. */
  await gotIt.click();
  await expect(card).toHaveCount(0);
  await expect.poll(() => dismissals.length, { timeout: RIG_EXPECT_MS }).toBe(1);
  expect(dismissals[0]).toEqual({ version: "v0.3.7" });

  /* A second arrival shows nothing and writes nothing. */
  await home(page);
  await expect(page.getByRole("dialog", { name: "New in this release" })).toHaveCount(0);
  expect(dismissals).toHaveLength(1);
});

test("Escape dismisses the card from the keyboard", async ({ page }) => {
  const dismissals = await answerNews(page);
  await home(page);
  const card = page.getByRole("dialog", { name: "New in this release" });
  await expect(card).toBeVisible({ timeout: RIG_EXPECT_MS });
  await page.keyboard.press("Escape");
  await expect(card).toHaveCount(0);
  await expect.poll(() => dismissals.length, { timeout: RIG_EXPECT_MS }).toBe(1);
  expect(dismissals[0]).toEqual({ version: "v0.3.7" });
});

test("All release notes dismisses and goes to About's release notes", async ({ page }) => {
  const dismissals = await answerNews(page);
  await home(page);
  const card = page.getByRole("dialog", { name: "New in this release" });
  await expect(card).toBeVisible({ timeout: RIG_EXPECT_MS });
  await card.getByRole("link", { name: "All release notes" }).click();
  await expect.poll(() => dismissals.length, { timeout: RIG_EXPECT_MS }).toBe(1);
  expect(dismissals[0]).toEqual({ version: "v0.3.7" });
  await expect(page).toHaveURL(/\/about#release-notes$/);
});
