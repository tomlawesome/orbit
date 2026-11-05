import { expect, test } from "@playwright/test";

import { APP } from "../fidelity/pocket-states.js";

/*
 * #1727 (W-R2): the create page draws the desk's .sky and
 * .vignette from the server, because `isPocket()` is false there; a phone sees
 * them until hydration removes them. The layout is decided in CSS instead
 * (pocket/media.js: `(max-width: 900px), (max-height: 600px)`), so the server
 * HTML is right before any script runs.
 *
 * The household page is not here: it is client-rendered (`ssr = false` in
 * household/[id]/+page.js), so its server page holds no sky or vignette at any
 * size and the desk case could never hold with scripts off; its first browser
 * render already reads isPocket(). Create passes `stars={false}`, so its
 * backdrop is the vignette alone and `.sky` is never drawn there.
 *
 * Scripts are off in every context here, so what is judged is the server's page
 * alone. The test sets its own viewports; the project only picks the browser.
 */
test.beforeEach(({}, testInfo) => {
  test.skip(testInfo.project.name !== "rig-desktop", "sets its own viewports; one project is enough");
});

const PAGES = [["create", "/create"]];
const SIZES = {
  phone: { width: 390, height: 844 },
  desk: { width: 1440, height: 900 },
};

/** True when the element is drawn: a box with area and display other than none. */
async function drawn(locator) {
  if ((await locator.count()) === 0) return false;
  return locator.first().evaluate((el) => {
    const box = el.getBoundingClientRect();
    return getComputedStyle(el).display !== "none" && box.width > 0 && box.height > 0;
  });
}

for (const [name, path] of PAGES) {
  for (const [size, viewport] of Object.entries(SIZES)) {
    test(`${name}: the server page on a ${size} ${size === "phone" ? "has no" : "shows the"} sky and vignette (#1727)`, async ({ browser }) => {
      const context = await browser.newContext({ viewport, javaScriptEnabled: false, reducedMotion: "reduce" });
      try {
        const page = await context.newPage();
        await page.goto(`${APP}${path}`, { waitUntil: "load" });
        const sky = page.locator(".sky");
        await expect(page.locator("body")).toBeAttached();
        const vignette = page.locator(".vignette");
        const want = size === "desk";
        expect(await drawn(sky), `.sky drawn on ${size}`).toBe(false); /* create has no starfield */
        expect(await drawn(vignette), `.vignette drawn on ${size}`).toBe(want);
      } finally {
        await context.close();
      }
    });
  }
}
