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

/*
 * #790: the starfield falls into the hole. Its saving grace under #764's
 * measured lesson — animated elements under a live filter are what costs
 * frames — is that each star copy is one unfiltered <canvas>, painted once
 * and moved only by its own transform (a scaled SVG group is what hung the
 * owner's laptop; +error.svelte has why). This holds all three halves: the
 * copies really are painted canvases, the infall is actually running, and
 * nothing that animates has a filter.
 */
test("notfound's starfield falls in, and nothing that moves is filtered", async ({ page }) => {
  /* The stars are in the HTML itself — the server-drawn still sky the
     first paint shows, before any script runs — with enough of them to be
     a sky (two copies each of 150 far and 36 near stars, the near ones
     with a glow circle each: 444 circles). */
  const html = await (await page.request.get(`${APP}/some-missing-path`)).text();
  expect(html, "the HTML should arrive with the still sky").toContain('<svg class="first"');
  expect(html.match(/<circle /g)?.length ?? 0, "the still sky should hold the stars").toBeGreaterThanOrEqual(444);
  /* And the copies arrive hidden and still: `live` is only set once all
     six are painted (#798), so the HTML must not carry it. */
  expect(html, "the copies must not be live before they are painted").not.toMatch(/class="infall live"/);

  await page.goto(`${APP}/some-missing-path`, { waitUntil: "load" });
  /* The sky is painted synchronously at mount, before the well's rasters
     even start; "ready" is simply the surest sign mount has run. Asked for
     as a real match, not every-of-nothing, because before hydration there
     is no .world[data-rasterised] at all. */
  await page.waitForFunction(() => document.querySelector('.world[data-rasterised="ready"]') !== null);

  const sample = () =>
    page.evaluate(() => {
      const falls = [...document.querySelectorAll(".infall .fall")];
      return {
        /* Every copy is a canvas with stars actually painted on it: some
           pixel, somewhere, is not transparent. */
        painted: falls.filter((el) => {
          if (!(el instanceof HTMLCanvasElement) || !el.width) return false;
          const px = el.getContext("2d")?.getImageData(0, 0, el.width, el.height).data;
          if (!px) return false;
          for (let i = 3; i < px.length; i += 4) if (px[i] > 0) return true;
          return false;
        }).length,
        falls: falls.map((g) => ({
          animationName: getComputedStyle(g).animationName,
          transform: getComputedStyle(g).transform,
        })),
        /* The still sky has handed over: once the canvases are painted it
           is gone, so nothing static is left under the moving copies. */
        still: document.querySelectorAll(".infall .first").length,
        live: document.querySelector(".infall.live") !== null,
        /* Anything in the star layers that is, or sits under, a filter. */
        skyFiltered: document.querySelectorAll(".infall filter, .infall [filter], .sky filter, .sky [filter]").length,
        /* Every painted, animated element on the screen that also carries a
           filter, by attribute or by computed style. Painted, because #764
           keeps its rasterised sources in the DOM under display:none — they
           still carry their filters, and are exactly what does not paint. */
        animatedFiltered: [...document.querySelectorAll("*")]
          .filter((el) => el.getClientRects().length > 0)
          .filter((el) => getComputedStyle(el).animationName !== "none")
          .filter((el) => el.hasAttribute("filter") || getComputedStyle(el).filter !== "none")
          .map((el) => `${el.tagName}.${el.getAttribute("class") ?? ""}`),
      };
    });

  const before = await sample();
  expect(before.falls.length, "expected the falling star copies").toBe(6);
  expect(before.painted, "every falling copy should be a painted canvas").toBe(6);
  expect(before.still, "the still sky should be gone once the canvases are painted").toBe(0);
  expect(before.live, "the copies should be live once the still sky is gone").toBe(true);
  for (const g of before.falls) expect(g.animationName, "a star group lost its infall").toMatch(/^infall/);
  expect(before.skyFiltered, "the sky must stay unfiltered").toBe(0);
  expect(before.animatedFiltered, "an animated element carries a live filter").toEqual([]);

  /* "Running" means the transform is changing, not just that a name is set:
     a paused or zero-duration animation would satisfy the name check. */
  await page.waitForTimeout(400);
  const after = await sample();
  for (let i = 0; i < before.falls.length; i++) {
    expect(after.falls[i].transform, `star group ${i} is not moving`).not.toBe(before.falls[i].transform);
  }
});
