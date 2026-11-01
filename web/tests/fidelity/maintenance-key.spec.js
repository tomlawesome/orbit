import { expect, test } from "@playwright/test";

/* Same app the fidelity gate photographs (playwright.config.js webServer). */
const APP = process.env.FIDELITY_APP ?? "http://127.0.0.1:4173";

/*
 * #1405: the screen a member sees when Orbit holds no usable encryption key
 * (/maintenance?kind=key&contact=1 under the fixture harness). Its words, the
 * words it must not say and the log hint are markup, proven in
 * tests/unit/maintenance-key.test.mjs (ADR-0039, #1613). What stays here needs
 * a real layout: it must not scroll sideways, on the desk and on the phone
 * (AGENTS.md: every screen on both layouts).
 */

const LAYOUTS = [
  { label: "desk", width: 1280, height: 800 },
  { label: "pocket", width: 400, height: 850 },
];

for (const layout of LAYOUTS) {
  test.describe(`the key screen on the ${layout.label}`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize({ width: layout.width, height: layout.height });
    });

    test("does not spill sideways", async ({ page }) => {
      await page.goto(`${APP}/maintenance?kind=key&contact=1`, { waitUntil: "load" });

      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      expect(overflow, "the key screen scrolls sideways").toBeLessThanOrEqual(0);
    });
  });
}
