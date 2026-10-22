import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { settle } from "./pocket-states.js";

/* Same app the fidelity gate photographs (playwright.config.js webServer). */
const APP = process.env.FIDELITY_APP ?? "http://127.0.0.1:4173";

/*
 * SETTINGS ON A PHONE, AXE-CHECKED (#1137): the fixture harness's own
 * /settings, at 390x844, swept for automated WCAG A/AA violations at rest —
 * on every theme pack a reader can choose, not only the default, since a
 * colour token can clear the law on one pack's ground and miss it on
 * another's. `pickPack` mirrors what a tap on a swatch does
 * (theme-swatches.js's `applyTheme`): set `data-theme` and let the pack's
 * own tokens repaint the screen underneath.
 */
test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

const WCAG_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"];
const PACKS = ["afterdark", "starchart", "clouds", "dawn"];

/** @param {import("@playwright/test").Page} page @param {string} id */
async function pickPack(page, id) {
  await page.evaluate((theme) => { document.documentElement.dataset.theme = theme; }, id);
  await settle(page);
}

for (const pack of PACKS) {
  test(`/settings has no automated WCAG A/AA violations at rest, ${pack}`, async ({ page }) => {
    await page.goto(`${APP}/settings`, { waitUntil: "load" });
    await page.waitForSelector(".st-pocket [data-row]");
    await settle(page);
    await pickPack(page, pack);
    const results = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
    expect(results.violations).toEqual([]);
  });
}

/*
 * TEXT SIZE (#1180): the "Text size" radiogroup under the theme packs. Four
 * radios named standard / comfortable / large / extra large, exactly one
 * checked, no automated violations at rest or with the largest step on.
 */
test("/settings text size is a four-option radiogroup with no automated WCAG A/AA violations", async ({ page }) => {
  await page.goto(`${APP}/settings`, { waitUntil: "load" });
  await page.waitForSelector(".st-pocket [data-row]");
  await settle(page);
  const group = page.getByRole("radiogroup", { name: "Text size" });
  await expect(group).toBeVisible();
  const radios = group.getByRole("radio");
  await expect(radios).toHaveCount(4);
  await expect(radios).toHaveText(["standard", "comfortable", "large", "extra large"]);
  await expect(group.getByRole("radio", { checked: true })).toHaveCount(1);
  const results = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
  expect(results.violations).toEqual([]);
});

test("/settings text size has no automated WCAG A/AA violations on extra large", async ({ page }) => {
  await page.addInitScript(() => { localStorage.setItem("orbit-text-size", "extra-large"); });
  await page.goto(`${APP}/settings`, { waitUntil: "load" });
  await page.waitForSelector(".st-pocket [data-row]");
  await settle(page);
  await expect(page.getByRole("radiogroup", { name: "Text size" }).getByRole("radio", { name: "extra large" })).toBeChecked();
  const results = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
  expect(results.violations).toEqual([]);
});

