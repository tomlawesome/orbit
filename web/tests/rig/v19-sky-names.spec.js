import { expect, test } from "@playwright/test";

import { APP, RIG_EXPECT_MS, RIG_TEST_MS, onPhone, signedIn } from "./a11y-support.js";
import { useFixtureScenes } from "../fidelity/pocket-states.js";

/*
 * #1461: planet names within N days, a per-user setting, set in Settings
 * beside a live sky. Both dialects; the fixture app's Harlow Home, today
 * pinned to 2026-08-13.
 *
 * Harlow Home's planets, by days until due: Gutter clearing -16 (overdue),
 * Car MOT +16, Boiler service +22, Chimney sweep +61, Roof replacement +100,
 * Smoke alarm batteries +122, Car full service +161. So at the default 30
 * days: the first three are named, the other four are not.
 *
 * The phone home draws only some planets (overdue, closest, ones with papers,
 * by the spacing law in pocket.svelte) and names only those, counted from the
 * page itself. L draws the caption "your sky, as these settings draw it" on
 * the desk only. The singular "within 1 day" is checked on the desk.
 *
 * Names this spec fixes for the build:
 *  - a name is an svg <text data-label="<item id>"> (core.js), aria-hidden;
 *  - Settings > Your sky > Planets holds a row labelled "names up close" whose
 *    range is named "Show a planet's name when it is due within this many days"
 *    (L's aria-label; min 0, max 365), a readout in an <output> ("within N
 *    days" / "none" at 0 / "every planet" at 365) that is also the range's
 *    aria-valuetext, and a preview: role="img" whose
 *    label ends "<N> names shown" (N a digit, 0 included);
 *  - the preview's planets are svg groups `[data-pl="<item id>"]` inside the
 *    role=img svg, and they are the planets home draws on that dialect (the
 *    preview behaves as the real dial: same drawn set, same naming rule);
 *  - the range saves on `change` with PUT /api/preferences, body.labelDays;
 *  - the fixture server holds that save for a browser that asked for the
 *    `keep-saves` scene, and answers the session (and so home) with it.
 */
test.use({ baseURL: APP });
test.describe.configure({ timeout: RIG_TEST_MS });

const NEAR = ["i-gutter", "i-mot", "i-boiler"];
const FAR = ["i-chimney", "i-roof", "i-smoke", "i-svc"];
const ALL = [...NEAR, ...FAR];

/* Days until due, today pinned (2026-08-13), and the pocket planet's own accessible name. */
const DAYS = { "i-gutter": -16, "i-mot": 16, "i-boiler": 22, "i-chimney": 61, "i-roof": 100, "i-smoke": 122, "i-svc": 161 };
const TITLES = {
  "i-gutter": "Gutter clearing", "i-mot": "Car MOT", "i-boiler": "Boiler service", "i-chimney": "Chimney sweep",
  "i-roof": "Roof replacement", "i-smoke": "Smoke alarm batteries", "i-svc": "Car full service",
};

/**
 * The planets home draws. The desk draws all seven; the phone draws only some
 * (overdue, closest, ones with papers, by the spacing law in pocket.svelte), so
 * it is counted from the page itself: the pocket's planet elements,
 * `.mdial .pk-body`, named by the item's title. Names go on drawn planets only.
 * @param {import("@playwright/test").Page} page
 * @param {boolean} phone
 * @returns {Promise<string[]>}
 */
async function drawnOnHome(page, phone) {
  if (!phone) return ALL;
  const labels = await page.locator(".mdial .pk-body").evaluateAll((els) => els.map((el) => el.getAttribute("aria-label") ?? ""));
  const drawn = Object.entries(TITLES).filter(([, title]) => labels.some((label) => label.startsWith(title))).map(([id]) => id);
  expect(drawn.length, "the phone draws at least one planet").toBeGreaterThan(0);
  return drawn;
}

/**
 * The planets the settings preview draws: `[data-pl="<item id>"]` inside the
 * preview svg (core.js's planet group). The owner's rule: the preview behaves
 * as the real dial, so these are the planets home draws (checked below), and
 * they are named by the same rule.
 * @param {import("@playwright/test").Page} page
 * @returns {Promise<string[]>}
 */
async function previewDrawn(page) {
  await expect(preview(page).locator("[data-pl]").first()).toBeAttached({ timeout: RIG_EXPECT_MS });
  const ids = await preview(page).locator("[data-pl]").evaluateAll((els) => els.map((el) => el.getAttribute("data-pl") ?? ""));
  return ids.sort();
}

/**
 * What home should name at N days: drawn planets due within N (overdue
 * included when N > 0), every drawn planet at 365, none at 0.
 * @param {string[]} drawn
 * @param {number} days
 */
const dueWithin = (drawn, days) => (days <= 0 ? [] : drawn.filter((id) => days >= 365 || DAYS[/** @type {keyof typeof DAYS} */ (id)] <= days));

/** @param {import("@playwright/test").Page} page */
const names = (page) => page.locator("text[data-label]");
/** @param {import("@playwright/test").Page} page */
const slider = (page) => page.getByRole("slider", { name: "Show a planet's name when it is due within this many days" });
/** The readout is an <output> (L's markup); "none" is also the range's end word, so never getByText.
 * @param {import("@playwright/test").Page} page */
const readout = (page) => page.locator("output");
/** @param {import("@playwright/test").Page} page */
const preview = (page) => page.getByRole("img", { name: /\d+ names? shown$/ });

/**
 * @param {import("@playwright/test").Page} page
 * @param {string[]} shown
 */
async function expectNamed(page, shown) {
  await expect(names(page)).toHaveCount(shown.length, { timeout: RIG_EXPECT_MS });
  for (const id of shown) await expect(page.locator(`text[data-label="${id}"]`)).toHaveCount(1);
  for (const id of ALL.filter((one) => !shown.includes(one))) await expect(page.locator(`text[data-label="${id}"]`)).toHaveCount(0);
}

test("home names the drawn planets due within 30 days, overdue included, and not the later ones", async ({ page }, testInfo) => {
  await signedIn("/home", "rest")(page);
  const drawn = await drawnOnHome(page, onPhone(testInfo));
  const expected = dueWithin(drawn, 30);
  if (!onPhone(testInfo)) expect([...expected].sort()).toEqual([...NEAR].sort());
  await expectNamed(page, expected);
  for (const name of await names(page).all()) {
    expect(await name.evaluate((el) => !!el.closest('[aria-hidden="true"]') || el.getAttribute("aria-hidden") === "true")).toBe(true);
    expect(await name.evaluate((el) => getComputedStyle(el).pointerEvents)).toBe("none");
  }
});

test("settings: the slider starts at 30, and the live preview shows the same three names", async ({ page }, testInfo) => {
  await signedIn("/settings", "rest")(page);
  await expect(slider(page)).toBeVisible({ timeout: RIG_EXPECT_MS });
  await expect(slider(page)).toHaveAttribute("min", "0");
  await expect(slider(page)).toHaveAttribute("max", "365");
  await expect(slider(page)).toHaveValue("30");
  await expect(slider(page)).toHaveAttribute("aria-valuetext", "within 30 days");
  await expect(readout(page)).toHaveText("within 30 days");
  await expect(page.getByText("names up close", { exact: true })).toBeVisible();
  const drawn = await previewDrawn(page);
  const expected = dueWithin(drawn, 30);
  if (!onPhone(testInfo)) expect([...expected].sort()).toEqual([...NEAR].sort());
  expect(expected.length).toBeGreaterThan(0);
  await expect(preview(page)).toHaveAttribute("aria-label", new RegExp(`\\b${expected.length} names? shown$`));
  await expectNamed(page, expected);
  /* L draws the caption on the desk only. */
  const caption = page.getByText("your sky, as these settings draw it");
  if (onPhone(testInfo)) await expect(caption).toHaveCount(0);
  else await expect(caption).toBeVisible();
});

test("settings: all shows every name in the preview at once; a reload of home shows them too", async ({ page }, testInfo) => {
  await useFixtureScenes(page, "keep-saves");
  await signedIn("/settings", "rest")(page);
  await expect(slider(page)).toBeVisible({ timeout: RIG_EXPECT_MS });

  /** @type {any[]} */
  const saves = [];
  page.on("request", (request) => {
    if (request.url().endsWith("/api/preferences") && request.method() === "PUT") saves.push(request.postDataJSON());
  });

  await slider(page).fill("365");
  /* the live sky and the readout follow before any save lands */
  await expect(readout(page)).toHaveText("every planet");
  await expect(slider(page)).toHaveAttribute("aria-valuetext", "every planet");
  const drawn = await previewDrawn(page);
  if (!onPhone(testInfo)) expect(drawn).toEqual([...ALL].sort());
  await expect(preview(page)).toHaveAttribute("aria-label", new RegExp(`\\b${drawn.length} names? shown$`));
  await expectNamed(page, dueWithin(drawn, 365));

  /* saved on release: one save, carrying the number */
  await expect.poll(() => saves.length, { timeout: RIG_EXPECT_MS }).toBe(1);
  expect(saves[0].labelDays).toBe(365);

  await page.goto(`${APP}/home`);
  await page.locator("body[data-home-ready]").waitFor({ state: "attached" });
  await expectNamed(page, dueWithin(await drawnOnHome(page, onPhone(testInfo)), 365));

  await page.goto(`${APP}/settings`);
  await expect(slider(page)).toHaveValue("365", { timeout: RIG_EXPECT_MS });
  await expect(slider(page)).toHaveAttribute("aria-valuetext", "every planet");
});

test("settings: none shows no names, in the preview and, once saved, on home", async ({ page }) => {
  await useFixtureScenes(page, "keep-saves");
  await signedIn("/settings", "rest")(page);
  await expect(slider(page)).toBeVisible({ timeout: RIG_EXPECT_MS });

  const saved = page.waitForRequest((request) => request.url().endsWith("/api/preferences") && request.method() === "PUT");
  await slider(page).fill("0");
  await expect(readout(page)).toHaveText("none");
  await expect(slider(page)).toHaveAttribute("aria-valuetext", "none");
  await expect(preview(page)).toHaveAttribute("aria-label", /0 names shown$/);
  await expectNamed(page, []);
  expect((await saved).postDataJSON().labelDays).toBe(0);

  await page.goto(`${APP}/home`);
  await expectNamed(page, []);
});

test("settings: a number between reads as within N days, and the preview keeps the planets due by then", async ({ page }, testInfo) => {
  await signedIn("/settings", "rest")(page);
  await expect(slider(page)).toBeVisible({ timeout: RIG_EXPECT_MS });
  await slider(page).fill("90");
  await expect(slider(page)).toHaveAttribute("aria-valuetext", "within 90 days");
  await expect(readout(page)).toHaveText("within 90 days");
  const expected = dueWithin(await previewDrawn(page), 90);
  if (!onPhone(testInfo)) expect([...expected].sort()).toEqual([...NEAR, "i-chimney"].sort());
  await expectNamed(page, expected);
  await expect(preview(page)).toHaveAttribute("aria-label", new RegExp(`\\b${expected.length} names? shown$`));
});

test("settings: the preview is a picture, not a control", async ({ page }) => {
  await signedIn("/settings", "rest")(page);
  await expect(preview(page)).toBeVisible({ timeout: RIG_EXPECT_MS });
  await expect(preview(page).getByRole("button")).toHaveCount(0);
  await expect(preview(page).getByRole("link")).toHaveCount(0);
  await expect(page.locator(".callout")).toHaveCount(0);
});

test("settings: one day reads \"within 1 day\", singular (desk)", async ({ page }, testInfo) => {
  test.skip(onPhone(testInfo), "the singular readout is checked on the desk");
  await signedIn("/settings", "rest")(page);
  await expect(slider(page)).toBeVisible({ timeout: RIG_EXPECT_MS });
  await slider(page).fill("1");
  await expect(readout(page)).toHaveText("within 1 day");
  await expect(slider(page)).toHaveAttribute("aria-valuetext", "within 1 day");
  await expectNamed(page, ["i-gutter"]);
});

test("settings: the preview draws the same planets as home, and names them by the same rule", async ({ page }, testInfo) => {
  await signedIn("/home", "rest")(page);
  const onHome = [...(await drawnOnHome(page, onPhone(testInfo)))].sort();
  const homeNamed = (await names(page).evaluateAll((els) => els.map((el) => el.getAttribute("data-label") ?? ""))).sort();
  expect(homeNamed).toEqual(dueWithin(onHome, 30).sort());

  await signedIn("/settings", "rest")(page);
  await expect(slider(page)).toBeVisible({ timeout: RIG_EXPECT_MS });
  expect(await previewDrawn(page)).toEqual(onHome);
  await expectNamed(page, homeNamed);
});
