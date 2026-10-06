import { expect, test } from "@playwright/test";

/* Same app the fidelity gate photographs (playwright.config.js webServer). */
const APP = process.env.FIDELITY_APP ?? "http://127.0.0.1:4173";

/*
 * #1065: a belt seat painted its focus ring on a child.
 *
 * Each seat is a `<g role="button" tabindex="0" class="hit">` with its own
 * `outline:none` and a child `.fring` circle that opened on `:focus-visible`
 * — the same wrong shape #1062 found and fixed on the end-caps. A keyboard
 * audit that reads the computed style of THE ELEMENT THAT HAS FOCUS
 * (tests/e2e/support/keyboard.ts) sees nothing from a ring painted by a
 * child, and that audit's own fixture household holds only one item, so it
 * never focuses a seat at all — belt.css says so beside the fix. This check
 * is what actually proves a seat's ring, on the fixture household where
 * several seats are visible, the way belt-endcap-controls.spec.js proves
 * the end-caps'.
 *
 * The fix (belt.css, `.seat .hit:focus-visible`) puts the ring on the seat's
 * own <g> as an outline, matching the end-caps, and drops the .fring circle
 * from buildSeats entirely (belt.behaviour.js) — the pocket's document
 * clump keeps its own child ring untouched, since #1065 is scoped to seats.
 */

/** The desk the gate itself judges at, and a phone. */
const VIEWPORTS = [
  { width: 1600, height: 1000 },
  { width: 390, height: 844 },
];

/** @param {import("@playwright/test").Page} page */
async function openBelt(page) {
  await page.goto(`${APP}/item/i-mot`, { waitUntil: "load" });
  /* The gate's own settle for this screen: the band has its seats and the
     apex has its card, both of which arrive client-side. */
  await page.waitForFunction(
    () =>
      document.querySelectorAll("#seats .seat").length > 0
      && Boolean(document.querySelector(".item-card h2")),
  );
}

for (const { width, height } of VIEWPORTS) {
  test(`a focused belt seat paints its own outline at ${width}x${height}`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    await openBelt(page);

    /* Tabbed to rather than focused by script, the same reason
       belt-endcap-controls.spec.js does it this way: the point of #1065 is
       that a keyboard reader landing on a seat sees a ring on the thing that
       actually has focus. The walk is bounded generously and stops as soon
       as a seat is seen — the card and the end-caps are also in the Tab
       order and come first. */
    let seat = null;
    for (let i = 0; i < 60 && !seat; i++) {
      await page.keyboard.press("Tab");
      seat = await page.evaluate(() => {
        const hit = document.activeElement?.closest?.("#seats .seat .hit");
        if (!hit) return null;
        const cs = getComputedStyle(hit);
        return {
          label: hit.getAttribute("aria-label") ?? "",
          outlineStyle: cs.outlineStyle,
          outlineWidth: cs.outlineWidth,
          boxShadow: cs.boxShadow,
        };
      });
    }
    if (!seat) throw new Error("Tab never reached a belt seat");

    /* Read the way the e2e keyboard audit reads it: the computed style of
       THE ELEMENT THAT HAS FOCUS — an outline, or a box-shadow. The first
       cut of this control drew the ring as a child .fring circle, which
       left the focused <g> itself carrying nothing. */
    const outlined = seat.outlineStyle !== "none" && seat.outlineWidth !== "0px";
    const shadowed = Boolean(seat.boxShadow) && seat.boxShadow !== "none";
    expect(outlined || shadowed,
      `the focused seat paints no indicator on itself: ${JSON.stringify(seat)}`).toBe(true);
    /* Not a hairline that merely satisfies the check: it has to be seen
       against the band. */
    if (outlined) expect(Number.parseFloat(seat.outlineWidth)).toBeGreaterThanOrEqual(2);
    /* The name says what it does, rather than reading a bare id back to
       somebody who cannot see it. */
    expect(seat.label.length).toBeGreaterThan(0);
  });
}
