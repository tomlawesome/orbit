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

    // The button sits inside the ring by design (§10: "the ask sits inside
    // the ring directly beneath the word") — that overlap is not the bug.
    // Only the farewell colliding with either is.
    expect(intersects(ring, farewell), "ring overlaps the farewell").toBe(false);
    expect(intersects(gate, farewell), "the sign-back-in button overlaps the farewell").toBe(false);
  });
}
