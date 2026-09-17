// Renders the PNG icons from static/icon.svg (#1009): the SVG favicon alone
// leaves older browsers, iOS home screens and the Android install prompt
// with nothing, so each of those gets a bitmap cut from the same file.
// Run after changing icon.svg: `node scripts/render-icons.mjs`. The PNGs are
// committed, not built, so the Docker image needs no browser.
import { chromium } from "@playwright/test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../static/", import.meta.url));
const svg = readFileSync(`${root}icon.svg`, "utf8");
// iOS rounds the home-screen icon itself and paints transparent pixels
// black, so the touch icon is the tile squared off on its own ground.
const sizes = { "icon-32.png": 32, "apple-touch-icon.png": 180, "icon-192.png": 192, "icon-512.png": 512 };
const squared = new Set(["apple-touch-icon.png"]);

const browser = await chromium.launch();
for (const [file, size] of Object.entries(sizes)) {
  const page = await browser.newPage({ viewport: { width: size, height: size }, deviceScaleFactor: 1 });
  const ground = squared.has(file) ? "#060b1c" : "transparent";
  await page.setContent(`<style>html,body{margin:0;background:${ground}}svg{display:block;width:${size}px;height:${size}px}</style>${svg}`);
  await page.screenshot({ path: `${root}${file}`, omitBackground: !squared.has(file) });
  await page.close();
}
await browser.close();
console.log(`rendered ${Object.keys(sizes).join(", ")} into web/static/`);
