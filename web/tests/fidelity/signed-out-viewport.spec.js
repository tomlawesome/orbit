import { expect, test } from "@playwright/test";

/* Same app the fidelity gate photographs (playwright.config.js webServer). */
const APP = process.env.FIDELITY_APP ?? "http://127.0.0.1:4173";

/*
 * #1011: the signed-out goodbye's farewell text used to sit a fixed
 * viewport-height distance (`bottom:26vh`) from the bottom of the window,
 * while the ring it accompanies is centred on the window's HEIGHT. On a
 * short window the two drift toward each other — at 670px tall the ring and
 * the farewell overlapped by roughly 60px, catching the "Sign back in"
 * button (rendered inside the ring, beneath the word) between them.
 *
 * The fix (flight.css, "THE FAREWELL RIDES WITH THE RING") measures the
 * farewell from the ring's centre line instead of the viewport's bottom
 * edge, so the gap between them is the same at any window height.
 * This asserts that directly: none of the three elements' boxes overlap,
 * at a short window (670px, where the old rule broke first), a middling one
 * (800px, where the old rule was already touching) and a tall one (1000px,
 * the fidelity gate's height, where the screen must stay pixel-identical to
 * its mockup — screens.spec.js checks that half).
 */

const WIDTH = 1280;
const HEIGHTS = [670, 800, 1000];

/** @param {{top:number,bottom:number,left:number,right:number}} a
 *  @param {{top:number,bottom:number,left:number,right:number}} b */
function intersects(a, b) {
  return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
}

for (const height of HEIGHTS) {
  test(`the ring, the sign-back-in button and the farewell do not collide at ${WIDTH}x${height}`, async ({ page }) => {
    await page.route("**/api/auth/session", (route) =>
      route.fulfill({ status: 401, contentType: "application/json", body: '{"error":"unauthenticated"}' }),
    );
    await page.route("**/api/health", (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: '{"status":"ready"}' }),
    );
    await page.route("**/api/auth/availability", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ configured: true, phase: "running", contactAddress: null }),
      }),
    );

    await page.setViewportSize({ width: WIDTH, height });
    await page.goto(APP + "/logout", { waitUntil: "load" });
    await page.waitForFunction(() =>
      document.body.classList.contains("showdusk") && document.body.classList.contains("farewell"),
    );
    await page.waitForFunction(() =>
      [...document.querySelectorAll(".world[data-rasterised]")].every(
        (el) => (/** @type {HTMLElement} */ (el)).dataset.rasterised === "ready",
      ),
    );
    // The farewell and the gate both ride a .9s opacity/transform entrance
    // (flight.css); let it finish so the boxes below are the settled ones.
    await page.waitForTimeout(1700);

    /** @param {string} selector */
    const box = async (selector) => {
      const rect = await page.locator(selector).boundingBox();
      expect(rect, `${selector} has no box`).toBeTruthy();
      return /** @type {{x:number,y:number,width:number,height:number}} */ (rect);
    };
    const toEdges = (/** @type {{x:number,y:number,width:number,height:number}} */ r) => ({
      top: r.y, bottom: r.y + r.height, left: r.x, right: r.x + r.width,
    });

    const ring = toEdges(await box("#dusk .glyph svg > circle"));
    const gate = toEdges(await box("#dusk .gate-wrap a"));
    const farewell = toEdges(await box("#dusk .farewell"));

    // The button stands under the ring since #1253 (orbit-site's lockup),
    // and the farewell hangs under the button: none of the three may meet.
    expect(intersects(ring, gate), "ring overlaps the sign-back-in button").toBe(false);
    expect(intersects(ring, farewell), "ring overlaps the farewell").toBe(false);
    expect(intersects(gate, farewell), "the sign-back-in button overlaps the farewell").toBe(false);
  });
}

/*
 * The farewell's words stay on screen on a phone. The farewell is centred by
 * its own box, and a build once lost that centring (the `translate` it was
 * centred with was dropped from the built CSS, which the dev server never
 * showed), so on the owner's phone "You are signed out." began at the ring's
 * right edge and ran off the screen. The ring and the way back in were fine,
 * so nothing else caught it. This reads the built page: the heading and the
 * line must both lie wholly inside the viewport, and sit on the ring's axis.
 */
for (const [width, height] of [[390, 844], [390, 664], [360, 640], [320, 568]]) {
  test.describe(`the farewell's words on a phone at ${width}x${height}`, () => {
    test.use({ viewport: { width, height }, hasTouch: true, isMobile: true, reducedMotion: "reduce" });

    test("the heading and its line lie inside the viewport, centred on the ring", async ({ page }) => {
      await page.route("**/api/auth/session", (route) =>
        route.fulfill({ status: 401, contentType: "application/json", body: '{"error":"unauthenticated"}' }),
      );
      await page.route("**/api/health", (route) =>
        route.fulfill({ status: 200, contentType: "application/json", body: '{"status":"ready"}' }),
      );
      await page.route("**/api/auth/availability", (route) =>
        route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ configured: true, phase: "running", contactAddress: null }),
        }),
      );
      await page.goto(APP + "/logout", { waitUntil: "load" });
      await page.waitForFunction(() =>
        document.body.classList.contains("showdusk") && document.body.classList.contains("farewell"),
      );
      await page.evaluate(() => document.fonts.ready);
      await page.waitForTimeout(1700);

      const ring = await page.locator("#dusk .glyph svg").boundingBox();
      expect(ring, "the ring has no box").toBeTruthy();
      const axis = /** @type {{x:number,width:number}} */ (ring).x + /** @type {{x:number,width:number}} */ (ring).width / 2;
      for (const selector of ["#dusk .farewell .said", "#dusk .farewell .sub"]) {
        // The heading is a block of a set width and the line wraps, so judge the
        // glyphs themselves: the text's own line boxes, not the element's.
        const lines = await page.locator(selector).evaluate((el) => {
          const range = document.createRange();
          range.selectNodeContents(el);
          return [...range.getClientRects()].map((r) => ({ left: r.left, right: r.right }));
        });
        expect(lines.length, `${selector} has no text`).toBeGreaterThan(0);
        const left = Math.min(...lines.map((l) => l.left));
        const right = Math.max(...lines.map((l) => l.right));
        expect(left, `${selector} runs off the left edge`).toBeGreaterThanOrEqual(0);
        expect(right, `${selector} runs off the right edge (${right.toFixed(0)} of ${width})`).toBeLessThanOrEqual(width);
        expect(Math.abs((left + right) / 2 - axis), `${selector} is off the ring's axis`).toBeLessThanOrEqual(4);
      }
    });
  });
}
