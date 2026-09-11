// A one-screen contact sheet: page 1 of every document, side by side. Judging
// variation by opening six PDFs one at a time is how two rounds of sameness
// got through.
import { readdirSync } from "node:fs";
import { chromium } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
const HERE = dirname(fileURLToPath(import.meta.url));
const dir = resolve(HERE, "sources");


const b = await chromium.launch();
const files = readdirSync(dir).filter((f) => f.endsWith(".html") && !["index.html", "contact-sheet.html"].includes(f)).sort();
const cards = [];
for (const f of files) {
  const p = await b.newPage({ viewport: { width: 794, height: 1123 }, deviceScaleFactor: 1 });
  await p.goto(`file://${dir}/${f}`, { waitUntil: "networkidle" });
  const shot = `${f.replace(/\.html$/, "")}-p1.png`;
  await p.screenshot({ path: `${dir}/${shot}`, clip: { x: 0, y: 0, width: 794, height: 1123 } });
  await p.close();
  cards.push(`<figure><img src="${shot}" alt="${f}"><figcaption>${f.replace(/\.html$/, "")}</figcaption></figure>`);
}
await b.close();
const { writeFileSync } = await import("node:fs");
writeFileSync(`${dir}/contact-sheet.html`, `<!doctype html><meta charset="utf-8">
<title>Corpus contact sheet — page 1 of each</title>
<style>
 body{background:#2a2a2a;color:#eee;font:14px/1.4 sans-serif;margin:0;padding:1.5rem}
 h1{font-size:1.1rem;font-weight:600;margin:0 0 1rem}
 .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:1.2rem}
 figure{margin:0}
 img{width:100%;display:block;background:#fff;border:1px solid #555}
 figcaption{font-size:.8rem;color:#bbb;padding-top:.4rem;text-align:center}
 a{color:#8ab4f8}
</style>
<h1>Page 1 of each document — <a href="index.html">full PDFs and ground truth</a></h1>
<div class="grid">${cards.join("")}</div>`);
console.log(`contact sheet: ${files.length} documents`);
