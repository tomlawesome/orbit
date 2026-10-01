// Round 8 of #1177 — exports: O and P as PNG (P's PNG is the still of the
// animated SVG), Q as PNG at 1× and 2× for jpeg.py; then the review panes.
//   NODE_PATH=<a node_modules holding playwright> node render.cjs
const { chromium } = require("playwright");
const path = require("node:path");
const fs = require("node:fs");
const here = __dirname;
const shots = path.join(here, "screenshots");
fs.mkdirSync(shots, { recursive: true });
(async () => {
const browser = await chromium.launch();
try {
  for (const [svg, png, scale] of [["o-banner.svg", "o-banner.png", 1], ["p-banner.svg", "p-banner.png", 1],
                                   ["q-banner.svg", "q-banner.png", 1], ["q-banner.svg", "q-banner@2x.png", 2]]) {
    const page = await browser.newPage({ viewport: { width: 1600, height: 840 }, deviceScaleFactor: scale, reducedMotion: "reduce" });
    await page.goto("file://" + path.join(here, svg));
    await page.waitForTimeout(400);
    await page.screenshot({ path: path.join(here, png) });
    await page.close();
  }
} finally { await browser.close(); }
console.log("rendered banners");
})();
