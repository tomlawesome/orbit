import { expect, test } from "@playwright/test";

/* Same app the fidelity gate photographs (playwright.config.js webServer). */
const APP = process.env.FIDELITY_APP ?? "http://127.0.0.1:4173";

/*
 * #1035: on a phone the belt's top strip drew four things on top of each
 * other. The search field is fixed at the top, centred, up to 360px wide; the
 * shared chrome (#1010) is fixed in the same strip, the way back on the left
 * and the account orb on the right; and the band's two end-caps ride above
 * the band where it leaves the frame, which on a 390px sky is up in that
 * strip too, because the ring radius floors at A_MIN and a phone therefore
 * sees a hugely magnified band.
 *
 * Measured at 390x844 before the fix: the field's box ran x24-366 across
 * "← YOUR SKY" (x26-115) and both end-caps, and the account orb sat on top
 * of "later →". The fix is belt.css's narrow-sky rules — the field takes a
 * row of its own and each end-cap starts past its own side's chrome — and
 * belt.behaviour.js's buildEnds, which reads those insets and holds the
 * label inside the frame.
 *
 * The same shape of check as signed-out-viewport.spec.js, and here for the
 * same reason: it is geometry, it needs a real layout engine, and this
 * harness already stands up the app the gate photographs. It belongs beside
 * the pixel gate rather than in the e2e suite, which needs a live instance.
 */

/** @typedef {{ top: number, bottom: number, left: number, right: number }} Edges */

/** The issue's own phone, a bigger one, two small ones, and two desks. */
const VIEWPORTS = [
  { width: 390, height: 844 },   /* the viewport #1035 was reported at */
  { width: 390, height: 800 },
  { width: 430, height: 932 },
  { width: 375, height: 667 },
  { width: 360, height: 740 },
  { width: 681, height: 900 },   /* the first width that keeps one row */
  { width: 1280, height: 800 },
  { width: 1600, height: 1000 }, /* the gate's own frame */
];

/** @param {Edges} a @param {Edges} b */
const intersects = (a, b) =>
  a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;

for (const { width, height } of VIEWPORTS) {
  test(`the belt's chrome, search field and end-caps do not collide at ${width}x${height}`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    await page.goto(`${APP}/item/i-mot`, { waitUntil: "load" });
    /* The gate's own settle for this screen: the band has its seats and the
       apex has its card, both of which arrive client-side. */
    await page.waitForFunction(
      () =>
        document.querySelectorAll("#seats .seat").length > 0
        && Boolean(document.querySelector(".item-card h2")),
    );

    const parts = await page.evaluate(() => {
      /** @param {Element} el @param {string} name */
      const edge = (el, name) => {
        const r = el.getBoundingClientRect();
        return { name, top: r.y, bottom: r.y + r.height, left: r.x, right: r.x + r.width };
      };
      /* `.back` is ambiguous on purpose-built markup — belt.css has its own
         in-card `.back` links — so the chrome's two are taken as the fixed
         ones, which is what Chrome.svelte draws them as. */
      const chrome = [...document.querySelectorAll(".back, .orb")]
        .filter((el) => getComputedStyle(el).position === "fixed")
        .map((el, i) => edge(el, el.classList.contains("back") ? "the way back" : `the account orb ${i}`));
      const find = [...document.querySelectorAll("#find, .findnote")].map((el) =>
        edge(el, el.id === "find" ? "the search field" : "the search field's note"));
      const ends = [...document.querySelectorAll(".endcap")].map((el) =>
        edge(el, `the "${(el.textContent ?? "").trim()}" end-cap`));
      return { parts: [...chrome, ...find, ...ends], ends: ends.length };
    });

    expect(parts.parts.length, "the top strip's parts were not found").toBeGreaterThanOrEqual(4);

    for (let i = 0; i < parts.parts.length; i++) {
      for (let k = i + 1; k < parts.parts.length; k++) {
        const a = parts.parts[i], b = parts.parts[k];
        expect(intersects(a, b), `${a.name} overlaps ${b.name} at ${width}x${height}`).toBe(false);
      }
    }

    /*
     * And the compass is still THERE on the phone this was reported at. The
     * end-caps are the band's own "which way is time" (#1010, owner
     * 2026-09-16), so clearing the collision by deleting them would be a
     * regression that the overlap check above would happily pass. On a sky
     * short enough that the band takes the whole strip they are deliberately
     * not drawn — the search field's note carries the same words — which is
     * why this is asserted at the reported viewport rather than at all of
     * them.
     */
    if (width === 390 && height === 844) {
      expect(parts.ends, "the belt lost its end-caps at the viewport #1035 was reported at").toBe(2);
    }
  });
}
