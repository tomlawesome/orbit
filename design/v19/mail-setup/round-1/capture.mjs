// Screenshots every scene of every direction into shots/.
// Desk: 1600x1000 viewport, the Mail block clipped whole (with a margin), 2x.
// Phone: 390x844, 2x; the page whole, or for the sheet scenes the viewport
// scrolled to the Sending card with the sheet up.
// Run: node capture.mjs   (Playwright must resolve; set NODE_PATH if needed)
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const dir = path.dirname(fileURLToPath(import.meta.url));
mkdirSync(path.join(dir, "shots"), { recursive: true });

const DIRECTIONS = [["j", "j-one-card.html"], ["k", "k-two-cards.html"]];
const DESK = ["set-up", "another-account", "fresh", "mailbox-only", "editor", "editor-another", "imported"];
const PHONE = ["set-up", "fresh", "editor", "editor-another"];

const browser = await chromium.launch();
let count = 0;
try {
  for (const [letter, file] of DIRECTIONS) {
    const url = pathToFileURL(path.join(dir, file)).href;
    const desk = await browser.newContext({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 2 });
    const dp = await desk.newPage();
    dp.on("pageerror", (e) => console.log("PAGEERROR", file, e.message));
    for (const scene of DESK) {
      await dp.goto(`${url}?shot#${scene}`);
      await dp.waitForTimeout(300);
      const box = await dp.evaluate(() => {
        const kids = [...document.getElementById("mail-slot").children];
        const r = kids.map((k) => k.getBoundingClientRect());
        const top = Math.min(...r.map((x) => x.top)) + scrollY;
        const bottom = Math.max(...r.map((x) => x.bottom)) + scrollY;
        return { top, bottom };
      });
      await dp.screenshot({
        path: path.join(dir, "shots", `${letter}-${scene}.png`), fullPage: true,
        clip: { x: 0, y: Math.max(0, box.top - 10), width: 1600, height: box.bottom - box.top + 20 },
      });
      count++;
    }
    await desk.close();

    const ph = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true });
    const pp = await ph.newPage();
    pp.on("pageerror", (e) => console.log("PAGEERROR", file, e.message));
    for (const scene of PHONE) {
      await pp.goto(`${url}?shot&phone#${scene}`);
      await pp.waitForTimeout(300);
      const sheet = scene.startsWith("editor");
      if (sheet) {
        await pp.evaluate(() => {
          const el = document.getElementById("ad-sending") || document.getElementById("ad-mail");
          const sending = [...document.querySelectorAll("#ad-mail .p-caps")].find((c) => c.textContent === "Sending");
          (document.getElementById("ad-sending") ?? sending).scrollIntoView({ block: "start" });
          scrollBy(0, -16);
        });
        await pp.waitForTimeout(150);
        await pp.screenshot({ path: path.join(dir, "shots", `${letter}-${scene}-phone.png`) });
        if (scene === "editor-another") {
          // the sheet's body scrolls: the foot of the form, as a thumb would reach it
          await pp.evaluate(() => { const b = document.querySelector(".p-sheet-layer .body"); b.scrollTop = b.scrollHeight; });
          await pp.waitForTimeout(100);
          await pp.screenshot({ path: path.join(dir, "shots", `${letter}-${scene}-phone-end.png`) });
          count++;
        }
      } else {
        await pp.screenshot({ path: path.join(dir, "shots", `${letter}-${scene}-phone.png`), fullPage: true });
      }
      count++;
    }
    await ph.close();
  }
} finally {
  await browser.close();
}
console.log(`${count} shots`);
