// Round 8 of #1177 — the review panes, taken after jpeg.py so Q shows the JPEG the README would serve.
const { chromium } = require("playwright");
const path = require("node:path");
const here = __dirname;
(async () => {
  const b = await chromium.launch();
  const page = await b.newPage({ viewport: { width: 1680, height: 1200 } });
  await page.goto("file://" + path.join(here, "index.html")); await page.waitForTimeout(600);
  for (const k of ["o", "p", "q"]) for (const t of ["light", "dark"])
    await page.locator(`#${k}-${t}`).screenshot({ path: path.join(here, "screenshots", `${k}-${t}.png`) });
  await page.screenshot({ path: path.join(here, "screenshots", "index-full.png"), fullPage: true });
  await b.close(); console.log("panes taken");
})();
