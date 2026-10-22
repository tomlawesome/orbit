import { expect, test } from "@playwright/test";

/* Same app the fidelity gate photographs (playwright.config.js webServer). */
const APP = process.env.FIDELITY_APP ?? "http://127.0.0.1:4173";

/*
 * The dial draws each body twice: the clickable `.body-link` (data-body) and
 * a pointer-less twin `.body-vis` (data-vis) that carries the visible glow.
 * Storm's glow rules and the hover/highlight scale must reach the twin as
 * well as the link, and the two scale classes must agree.
 */
/** @param {import("@playwright/test").Page} page */
async function openDesk(page) {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`${APP}/home`, { waitUntil: "load" });
  await page.waitForFunction(() => document.body.dataset.homeReady === "true"
    && document.querySelectorAll('.body-vis[data-vis="i-gutter"] circle').length > 0);
}

for (const id of ["i-gutter", "i-mot", "i-boiler"]) {
  test(`in a storm the ${id} body's visible twin glows`, async ({ page }) => {
    await openDesk(page);
    await page.evaluate(() => document.body.classList.add("storm"));
    const twin = page.locator(`.body-vis[data-vis="${id}"] circle`).first();
    await expect(twin, `${id} has no visible twin on the desk dial`).toHaveCount(1);
    const filter = await twin.evaluate((el) => getComputedStyle(el).filter);
    expect(filter, "storm drops no shadow on the visible twin").toContain("drop-shadow");
  });
}

test("a hovered and a highlighted visible twin scale the same", async ({ page }) => {
  await openDesk(page);
  await page.addStyleTag({ content: ".body-vis :is(circle,path){transition:none !important}" });
  const twin = page.locator('.body-vis[data-vis="i-gutter"]').first();
  const read = async (/** @type {string} */ cls) => {
    await twin.evaluate((el, c) => { el.classList.remove("hot", "lit"); el.classList.add(c); }, cls);
    return twin.locator("circle").first().evaluate((el) => getComputedStyle(el).transform);
  };
  const hot = await read("hot");
  const lit = await read("lit");
  expect(hot, "hot leaves the circle unscaled").not.toBe("none");
  expect(lit).toBe(hot);
});
