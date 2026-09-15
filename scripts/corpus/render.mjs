// Render every sources/*.html to a sibling PDF, A4, backgrounds on.
import { readdirSync } from "node:fs";
import { chromium } from "@playwright/test";
import { corpusDir, positional } from "./corpus-dir.mjs";
const dir = corpusDir;

const only = positional[0];
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
