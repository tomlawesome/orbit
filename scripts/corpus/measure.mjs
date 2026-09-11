import { chromium } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
const HERE = dirname(fileURLToPath(import.meta.url));
const dir = resolve(HERE, "sources");

const b = await chromium.launch();
const p = await b.newPage();
await p.goto(`file://${dir}/${process.argv[2]}`, { waitUntil: "networkidle" });
// A4 at 96dpi. A .page using min-height rather than height GROWS instead of
// overflowing, so scrollHeight matches the box and the old check read 0px
// while the page silently spilled onto an extra sheet. Measure against A4,
// not against the box.
const A4 = 1123;
console.log(await p.evaluate((A4) => [...document.querySelectorAll(".page")].map((el, i) => {
  const h = el.getBoundingClientRect().height;
  const over = Math.max(el.scrollHeight, h) - A4;
  return `page ${i + 1}: box ${h.toFixed(0)}px, content ${el.scrollHeight}px, over A4 by ${over.toFixed(0)}px${over > 1 ? "  <-- SPILLS" : ""}`;
}).join("\n"), A4));
await b.close();
