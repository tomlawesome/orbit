import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

/* Same app the fidelity gate photographs (playwright.config.js webServer). */
const APP = process.env.FIDELITY_APP ?? "http://127.0.0.1:4173";

const WCAG_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"];

/*
 * The stumble (#1139): /kit/stumble genuinely fails in load
 * (+page.server.js), so this drives SvelteKit's real unexpected-error path
 * and checks the page a reader actually gets — never the wire's own
 * "Internal Error", never the bare fallback's "couldn't answer" sentence,
 * and no live <filter> in its SVG (the #764 rule: nothing here is filtered,
 * so there is no raster step to prove separately, unlike the 404's).
 */
const SIZES = [
  { name: "desk", viewport: { width: 1600, height: 1000 } },
  { name: "phone", viewport: { width: 390, height: 664 }, hasTouch: true, isMobile: true },
];

for (const size of SIZES) {
  test.describe(`the stumble at ${size.name}`, () => {
    test.use({ viewport: size.viewport, hasTouch: size.hasTouch, isMobile: size.isMobile });

    test("the copy, the two actions and the digits are Orbit's own", async ({ page }) => {
      await page.goto(`${APP}/kit/stumble`, { waitUntil: "load" });
      await page.waitForSelector(".stumble .digit");

      await expect(page.locator("h1")).toHaveText("Orbit stumbled");
      await expect(page.locator(".line-a")).toHaveText("Something went wrong on Orbit's side.");

      const again = page.locator("a.again");
      await expect(again).toHaveAttribute("data-sveltekit-reload", "");
      await expect(again).toHaveAttribute("href", /\/kit\/stumble$/);
      await expect(page.locator("a.home")).toHaveAttribute("href", "/");

      const bodyText = await page.locator("body").innerText();
      expect(bodyText).not.toContain("Internal Error");
      expect(bodyText).not.toContain("couldn’t answer");

      const digitGroups = page.locator(".stumble .digit");
      await expect(digitGroups).toHaveCount(3);
      const readings = await digitGroups.evaluateAll((groups) =>
        groups.map((g) => g.querySelector("text:last-of-type")?.textContent),
      );
      expect(readings).toEqual(["5", "0", "0"]);

      expect(await page.locator(".stumble svg filter").count()).toBe(0);
    });

    test("no automated WCAG A/AA violations", async ({ page }) => {
      await page.goto(`${APP}/kit/stumble`, { waitUntil: "load" });
      await page.waitForSelector(".stumble .digit");
      const results = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
      expect(results.violations).toEqual([]);
    });
  });
}
