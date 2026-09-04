import { expect, test } from "@playwright/test";

/*
 * #764's companion check. screens.spec.js's fidelity gate freezes every CSS
 * animation before it takes a single screenshot (see rewindSvgTime / the
 * animation-freeze block there), so it can prove pixels match without ever
 * being able to prove the six live animations under the (now mostly
 * rasterised) filtered group are still running. This spec proves the other
 * half.
 *
 * Step 2 rasterised the one static, filtered element left in the graph (the
 * inner "4"'s blur afterimage) and left the six animated elements live.
 * Step 4 went further: five of those six ride a transform or an opacity fade
 * over a filter that never has to re-run for that motion, so each is now
 * ALSO rasterised once, with its class (and so its CSS animation) moved onto
 * the resulting <image> — the same technique #501 used for Dawn's sway1/
 * sway2. `.disc-precess` is the one exception: it still rotates a live <g>
 * directly, now wrapping a mix of new rasters and untouched live shapes.
 *
 * So "the animation survives" no longer means "the original element is
 * still live SVG" for every selector — for `.lensed`/`.photon`/`.smear` the
 * right carrier IS an <image> now, and the ORIGINAL element is deliberately
 * hidden (display:none, kept in the DOM only so `#lensarcs path` — this
 * screen's settle condition — still finds what gravity-well.js drew). What
 * has to hold for all six is: whatever is actually rendered still carries a
 * live (non-"none") CSS animation-name.
 */
const ANIMATED_SELECTORS = [".disc-precess", ".disc-glow", ".photon", ".photon-hot", ".lensed", ".smear"];

const APP = process.env.FIDELITY_APP ?? "http://127.0.0.1:4173";
const SVG_NS = "http://www.w3.org/2000/svg";

test("notfound keeps its six animations live after rasterising the filtered group", async ({ page }) => {
  await page.goto(`${APP}/some-missing-path`, { waitUntil: "load" });

  /* Same settle condition screens.spec.js uses for this screen: the
     gravity well's generated lensed arcs have been drawn. Still true after
     step 4 — #lensarcs is hidden once rasterised, never removed. */
  await page.waitForFunction(() => document.querySelectorAll("#lensarcs path").length > 0);
  /* Same rasterised-ready wait screens.spec.js uses: every raster this
     screen builds (the text blur, plus step 4's five) has landed. */
  await page.waitForFunction(() =>
    [...document.querySelectorAll(".world[data-rasterised]")].every(
      (el) => /** @type {HTMLElement} */ (el).dataset.rasterised === "ready",
    ),
  );

  const report = await page.evaluate(
    ({ selectors, svgNs }) =>
      selectors.map((selector) => ({
        selector,
        elements: [...document.querySelectorAll(selector)]
          /* Excludes the hidden sources step 4 keeps around only for
             #lensarcs's element count: a display:none ancestor collapses an
             element's client rects to none, which is also exactly the
             signal that would catch a genuine regression (an element wired
             up but never actually painted). */
          .filter((el) => el.getClientRects().length > 0)
          .map((el) => ({
            tagName: el.tagName,
            animationName: getComputedStyle(el).animationName,
            isSvg: el.namespaceURI === svgNs,
          })),
      })),
    { selectors: ANIMATED_SELECTORS, svgNs: SVG_NS },
  );

  for (const { selector, elements } of report) {
    expect(elements.length, `expected at least one rendered element for ${selector}`).toBeGreaterThan(0);
    for (const el of elements) {
      expect(el.animationName, `${selector} (<${el.tagName}>) lost its animation-name`).not.toBe("none");
      expect(el.isSvg, `${selector} (<${el.tagName}>) is not a live SVG element`).toBe(true);
    }
  }

  /* The two elements with no filter at all (disc-glow, photon-hot) were
     never rasterised — confirms the "no filter, nothing to gain" half of
     the rule, not just the "rasterise it" half. */
  const untouched = await page.evaluate(() => ({
    discGlow: document.querySelector(".disc-glow")?.tagName,
    photonHot: document.querySelector(".photon-hot")?.tagName,
  }));
  expect(untouched.discGlow, "disc-glow should still be a live circle").toBe("circle");
  expect(untouched.photonHot, "photon-hot should still be a live circle").toBe("circle");

  /* Every raster this screen now builds is actually rasterised: the text
     blur (step 2) plus the five step 4 added (lensarcs, the lensed arch,
     photon, the near-side smear, the tidal-stream smear) — six <image>s
     with a real href, all inside the live .world SVG. */
  const rasterCount = await page.evaluate(
    () =>
      [...document.querySelectorAll(".world image")].filter((img) => {
        const href = img.getAttribute("href");
        return Boolean(href && href.length > 0);
      }).length,
  );
  expect(rasterCount, "expected six rasterised <image>s in .world").toBe(6);

  /* #lensarcs itself: still populated, just no longer painted. */
  const lensarcs = await page.evaluate(() => {
    const g = document.getElementById("lensarcs");
    return {
      pathCount: g?.querySelectorAll("path").length ?? 0,
      rendered: (g?.getClientRects().length ?? 0) > 0,
    };
  });
  expect(lensarcs.pathCount, "#lensarcs should still hold gravity-well.js's generated paths").toBeGreaterThan(0);
  expect(lensarcs.rendered, "#lensarcs should be hidden once its raster lands").toBe(false);
});
