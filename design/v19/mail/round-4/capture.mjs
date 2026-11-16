// Screenshots every mail at 680 and 390 wide, plus a 680 "still" frame (?still
// removes the <style> block, as Gmail and Outlook for Windows do).
// Run: node capture.mjs   (Playwright must resolve; set NODE_PATH if it is not installed here)
import { createRequire } from "node:module";
import { readdirSync, mkdirSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");

const dir = path.dirname(fileURLToPath(import.meta.url));
const files = readdirSync(dir).filter((f) => f.endsWith(".html")).sort();
mkdirSync(path.join(dir, "shots"), { recursive: true });

const jobs = [
  { suffix: "680", width: 680, query: "" },
  { suffix: "390", width: 390, query: "" },
  { suffix: "still", width: 680, query: "?still" },
];

const browser = await chromium.launch();
try {
  for (const job of jobs) {
    // Animated frames wait for the whole story (the button blooms at about 6.8 s);
    // every file in a job runs in parallel so the wait is paid once.
    await Promise.all(
      files.map(async (f) => {
        const ctx = await browser.newContext({
          viewport: { width: job.width, height: 900 },
          deviceScaleFactor: 2,
        });
        const page = await ctx.newPage();
        await page.goto(pathToFileURL(path.join(dir, f)).href + job.query);
        await page.waitForTimeout(job.query ? 500 : 7500);
        const name = f.replace(/\.html$/, "");
        await page.screenshot({ path: path.join(dir, "shots", `${name}-${job.suffix}.png`), fullPage: true });
        await ctx.close();
      }),
    );
  }
} finally {
  await browser.close();
}
console.log(`${files.length * jobs.length} shots`);
