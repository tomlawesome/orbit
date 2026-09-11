// Build an index page over the rendered corpus so the owner can page through
// the PDFs and see, next to each, what it is meant to test.
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { corpusDir } from "./corpus-dir.mjs";
const dir = corpusDir;


const rows = readdirSync(dir).filter((f) => f.endsWith(".pdf")).sort().map((pdf) => {
  const base = pdf.replace(/\.pdf$/, "");
  let truth = {}, chars = 0, dates = 0;
  try { truth = JSON.parse(readFileSync(`${dir}/${base}.truth.json`, "utf8")); } catch {}
  try {
    const t = readFileSync(`${dir}/${base}.txt`, "utf8");
    chars = t.length;
    dates = (t.match(/\b\d{1,2}[\/.-]\d{1,2}[\/.-]\d{2,4}\b|\b\d{1,2} (?:January|February|March|April|May|June|July|August|September|October|November|December) \d{4}\b/gu) ?? []).length;
  } catch {}
  const e = truth.expected ?? {};
  const notes = [].concat(truth.notes ?? []);
  return `<tr>
    <td><a href="${pdf}">${truth.name ?? base}</a><div class="sub">${pdf}</div></td>
    <td class="num">${chars.toLocaleString("en-GB")}</td>
    <td class="num">${dates}<span class="sub"> / ${(e.dates ?? []).length} answers</span></td>
    <td>${e.costMinor === undefined ? '<span class="none">no cost declared</span>' : "£" + (e.costMinor / 100).toFixed(2)}</td>
    <td>${(e.dateRoles ?? []).map((r) => `${r.date} <span class="sub">${r.role}</span>`).join("<br>") || '<span class="none">none</span>'}</td>
    <td>${notes.map((n) => `<div class="note">${n}</div>`).join("") || ""}</td>
  </tr>`;
}).join("\n");
writeFileSync(`${dir}/index.html`, `<!doctype html><meta charset="utf-8">
<title>Orbit extraction corpus — rebuild for #981</title>
<style>
 body{font:15px/1.5 system-ui,sans-serif;margin:2.5rem auto;max-width:1200px;padding:0 1.5rem;color:#1a1a1a}
 h1{font-size:1.5rem;margin-bottom:.2rem} p.lede{color:#555;margin-top:0}
 table{border-collapse:collapse;width:100%;margin-top:1.5rem}
 th,td{text-align:left;vertical-align:top;padding:.65rem .7rem;border-bottom:1px solid #e3e3e3}
 th{font-size:.78rem;text-transform:uppercase;letter-spacing:.04em;color:#666;border-bottom:2px solid #bbb}
 td.num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
 .sub{color:#888;font-size:.82rem} .none{color:#999;font-style:italic}
 .note{font-size:.85rem;color:#444;margin-bottom:.35rem}
 a{color:#0b57d0}
</style>
<h1>Extraction corpus rebuild — #981</h1>
<p class="lede">Each document is a full-page UK household paper, rendered to PDF and parsed with the real Tika.
The character count and date count are what Tika actually produced, not what the HTML says.
For comparison, the whole existing 36-document corpus is 10,583 characters, and 76 of its 77 dates are answers.</p>
<table>
<tr><th>Document</th><th>Chars</th><th>Dates</th><th>Cost</th><th>Expected dates</th><th>What it tests</th></tr>
${rows}
</table>`);
console.log("index written");
