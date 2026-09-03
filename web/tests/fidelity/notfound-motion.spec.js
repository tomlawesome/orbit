import { expect, test } from "@playwright/test";

/*
 * #764 step 2's companion check. screens.spec.js's fidelity gate freezes
 * every CSS animation before it takes a single screenshot (see rewindSvgTime
 * / the animation-freeze block there), so it can prove pixels match without
 * ever being able to prove the six live animations under the rasterised
 * static graph are still running. This spec proves the other half: that
 * splitting the filtered group into a rasterised static image and a live SVG
 * subgroup (+error.svelte) did not also freeze the well it lives in.
 *
 * Six animated selectors, one per keyframe notfound.css drives inside the
 * (formerly monolithic) filtered group: precess (.disc-precess), dbreathe
 * (.disc-glow), pflick/pflick2 (.photon/.photon-hot), lens (.lensed, two
 * elements), smear (.smear, two elements — the near-side disc group and the
 * tidal-stream path).
 */
const ANIMATED_SELECTORS = [".disc-precess", ".disc-glow", ".photon", ".photon-hot", ".lensed", ".smear"];

const APP = process.env.FIDELITY_APP ?? "http://127.0.0.1:4173";
const SVG_NS = "http://www.w3.org/2000/svg";

test("notfound keeps its six animations live after rasterising the static graph", async ({ page }) => {
  await page.goto(`${APP}/some-missing-path`, { waitUntil: "load" });

  /* Same settle condition screens.spec.js uses for this screen: the
     gravity well's generated lensed arcs have been drawn. */
  await page.waitForFunction(() => document.querySelectorAll("#lensarcs path").length > 0);
  /* Same rasterised-ready wait screens.spec.js uses: the static subgroup's
     async raster (rasteriseSvg, an <img> decode) has landed. */
  await page.waitForFunction(() =>
    [...document.querySelectorAll(".world[data-rasterised]")].every(
      (el) => /** @type {HTMLElement} */ (el).dataset.rasterised === "ready",
    ),
  );

  const report = await page.evaluate(
    ({ selectors, svgNs }) =>
      selectors.map((selector) => ({
        selector,
        elements: [...document.querySelectorAll(selector)].map((el) => ({
          animationName: getComputedStyle(el).animationName,
          isSvg: el.namespaceURI === svgNs,
          insideRaster: Boolean(el.closest("image, canvas")),
        })),
      })),
    { selectors: ANIMATED_SELECTORS, svgNs: SVG_NS },
  );

  for (const { selector, elements } of report) {
    expect(elements.length, `expected at least one live element for ${selector}`).toBeGreaterThan(0);
    for (const el of elements) {
      expect(el.animationName, `${selector} lost its animation-name`).not.toBe("none");
      expect(el.isSvg, `${selector} is not a live SVG element`).toBe(true);
      expect(el.insideRaster, `${selector} ended up inside the rasterised image`).toBe(false);
    }
  }

  /* The static subgroup IS rasterised: an <image> with a real href stands
     where the outer "4" and the inner "4"'s still glyph used to be drawn
     live. */
  const staticRaster = await page.evaluate(() => {
    const img = document.querySelector(".world image");
    const href = img?.getAttribute("href");
    return Boolean(href && href.length > 0);
  });
  expect(staticRaster, "expected the static subgroup to be rasterised into an <image>").toBe(true);
});
