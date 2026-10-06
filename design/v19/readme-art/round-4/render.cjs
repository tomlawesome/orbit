// Round 4 of #1177 — PNG exports (1× and 2×) and self-review screenshots.
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
  for (const [scale, name] of [[1, "k-banner.png"], [2, "k-banner@2x.png"]]) {
    const page = await browser.newPage({ viewport: { width: 1600, height: 840 }, deviceScaleFactor: scale });
    await page.goto("file://" + path.join(here, "k-banner.svg"));
    await page.waitForTimeout(400);
    await page.screenshot({ path: path.join(here, name) });
    await page.close();
  }
  const page = await browser.newPage({ viewport: { width: 1680, height: 1200 }, deviceScaleFactor: 1 });
  await page.goto("file://" + path.join(here, "index.html"));
  await page.waitForTimeout(400);
  for (const t of ["light", "dark"]) {
    await page.locator(`#k-${t}`).screenshot({ path: path.join(shots, `k-${t}.png`) });
  }
  await page.screenshot({ path: path.join(shots, "index-full.png"), fullPage: true });
  await page.close();
} finally {
  await browser.close();
}
console.log("rendered");
})();
