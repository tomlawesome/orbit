// Round 1 of #1177 — PNG exports and self-review screenshots.
// Playwright's Chromium (PLAYWRIGHT_BROWSERS_PATH honoured). Run after build.py:
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
  // 1. banners → PNG at their own size (1600×840, 1×)
  for (const k of ["a", "b", "c"]) {
    const page = await browser.newPage({ viewport: { width: 1600, height: 840 }, deviceScaleFactor: 1 });
    await page.goto("file://" + path.join(here, `${k}-banner.svg`));
    await page.screenshot({ path: path.join(here, `${k}-banner.png`), omitBackground: true });
    await page.close();
  }
  // 2. the index, every pane, plus the whole page
  const page = await browser.newPage({ viewport: { width: 1680, height: 1200 }, deviceScaleFactor: 1 });
  await page.goto("file://" + path.join(here, "index.html"));
  await page.waitForTimeout(300);
  for (const k of ["a", "b", "c"]) for (const t of ["light", "dark"]) {
    await page.locator(`#${k}-${t}`).screenshot({ path: path.join(shots, `${k}-${t}.png`) });
  }
  await page.screenshot({ path: path.join(shots, "index-full.png"), fullPage: true });
  await page.close();
} finally {
  await browser.close();
}
console.log("rendered");
})();
