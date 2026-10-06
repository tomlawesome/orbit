// Round 5 of #1177 — PNG export and self-review screenshots.
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
  for (const [scale, name] of [[1, "l-banner.png"]]) {
    const page = await browser.newPage({ viewport: { width: 1600, height: 840 }, deviceScaleFactor: scale });
    await page.goto("file://" + path.join(here, "l-banner.svg"));
    await page.waitForTimeout(400);
    await page.screenshot({ path: path.join(here, name) });
    await page.close();
  }
  const page = await browser.newPage({ viewport: { width: 1680, height: 1200 }, deviceScaleFactor: 1 });
  await page.goto("file://" + path.join(here, "index.html"));
  await page.waitForTimeout(400);
  for (const t of ["light", "dark"]) {
    await page.locator(`#l-${t}`).screenshot({ path: path.join(shots, `l-${t}.png`) });
  }
  await page.screenshot({ path: path.join(shots, "index-full.png"), fullPage: true });
  await page.close();
} finally {
  await browser.close();
}
console.log("rendered");
})();
