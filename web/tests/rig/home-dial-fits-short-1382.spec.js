import { expect, test } from "@playwright/test";

import { signedIn } from "./a11y-support.js";

/*
 * The desk's whole dial fits the window's height (#1382, owner answer 60a).
 *
 * At any window of 840 x 480 or larger the bounding box of the dial's svg sits
 * inside the window: top >= 0, bottom <= innerHeight. A tall window keeps the
 * dial it has (640 px wide at 1440 x 900), and the width-based shrinking (#485,
 * min(640px, 100vw - 456px)) still applies: 444 px at 900 x 900.
 *
 * Reduced motion, so the arrival animation does not scale the dial mid-measure.
 */
test.use({ reducedMotion: "reduce" });

const DIAL = ".desk .dialwrap>svg";

/** @param {import("@playwright/test").Page} page */
async function dialBox(page) {
  await expect(page.locator(DIAL)).toBeVisible();
  return page.evaluate((sel) => {
    const r = document.querySelector(sel).getBoundingClientRect();
    return { top: r.top, bottom: r.bottom, width: r.width, height: r.height, innerHeight: window.innerHeight };
  }, DIAL);
}

test.describe("the desk dial and the window's height", () => {
  for (const [width, height] of [[1280, 480], [1280, 540], [1366, 600], [1920, 560]]) {
    test(`fits inside a ${width} x ${height} window`, async ({ page }, testInfo) => {
      test.skip(testInfo.project.name !== "rig-desktop", "the sized windows are the desktop project's");
      await page.setViewportSize({ width, height });
      await signedIn("/home", "rest")(page);
      const box = await dialBox(page);
      console.log(`measured ${width}x${height}: svg ${box.width}x${box.height}, top ${box.top}, bottom ${box.bottom}`);
      expect(box.top).toBeGreaterThanOrEqual(0);
      expect(box.bottom).toBeLessThanOrEqual(box.innerHeight);
    });
  }

  for (const [width, height, wide] of [[1440, 900, 640], [900, 900, 444]]) {
    test(`is ${wide} px wide at ${width} x ${height}`, async ({ page }, testInfo) => {
      test.skip(testInfo.project.name !== "rig-desktop", "the sized windows are the desktop project's");
      await page.setViewportSize({ width, height });
      await signedIn("/home", "rest")(page);
      const box = await dialBox(page);
      console.log(`measured ${width}x${height}: svg ${box.width}x${box.height}, top ${box.top}, bottom ${box.bottom}`);
      expect(Math.abs(box.width - wide)).toBeLessThanOrEqual(1);
    });
  }
});
