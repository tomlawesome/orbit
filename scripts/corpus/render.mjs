// Render every sources/*.html to a sibling PDF, A4, backgrounds on.
import { readdirSync } from "node:fs";
import { chromium } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
const HERE = dirname(fileURLToPath(import.meta.url));
const dir = resolve(HERE, "sources");


const only = process.argv[2];
const files = readdirSync(dir).filter((f) => f.endsWith(".html") && !["index.html","contact-sheet.html"].includes(f)).filter((f) => !only || f === only);
const b = await chromium.launch();
for (const f of files) {
  const p = await b.newPage();
  await p.goto(`file://${dir}/${f}`, { waitUntil: "networkidle" });
  await p.pdf({ path: `${dir}/${f.replace(/\.html$/, ".pdf")}`, format: "A4", printBackground: true });
  await p.close();
  console.log("rendered", f);
}
await b.close();
