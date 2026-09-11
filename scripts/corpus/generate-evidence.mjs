// Propose EVIDENCE entries for the full-page documents. Each needle must be a
// snippet copied verbatim from the document's own text, so they are cut from
// the real Tika output rather than written by hand.
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
const HERE = dirname(fileURLToPath(import.meta.url));
const dir = resolve(HERE, "sources");

// `subtype` ground truth can name taxonomy groups instead of a literal
// phrase (owner decision 2026-09-11, #989). There is nothing to search a
// printed page for in that case -- a kind such as "Insurance" need not be
// printed at all -- so this proposes evidence for the one phrase the
// "ideal reply" tests actually use: the first synonym of the first kind.
const taxonomy = JSON.parse(readFileSync(resolve(HERE, "../../src/server/documents/subtype-taxonomy.json"), "utf8"));
const kindByName = new Map(taxonomy.kinds.map((k) => [k.name, k]));
function subtypeSearchPhrase(subtype) {
  if (subtype === undefined) return undefined;
  if (typeof subtype === "object" && !Array.isArray(subtype)) {
    const kind = kindByName.get(subtype.kinds?.[0]);
    return kind?.synonyms?.[0];
  }
  return Array.isArray(subtype) ? subtype[0] : subtype;
}

const MONTHS = ["January","February","March","April","May","June","July","August","September","October","November","December"];
const collapse = (s) => s.replace(/\s+/gu, " ").trim();
// Tika inserts backslash escapes that are not in the PDF (#982). Strip them
// only to locate a value; the needle stays as the document prints it.
const unescape_ = (s) => s.replace(/\\([&*_`#\[\]<>|~])/gu, "$1");
const CAP = 200;

function dateForms(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  const mi = m - 1, dd = String(d).padStart(2, "0"), mm = String(m).padStart(2, "0");
  return [`${d} ${MONTHS[mi]} ${y}`, `${dd} ${MONTHS[mi]} ${y}`, `${dd}/${mm}/${y}`, `${d}/${m}/${y}`, `${dd}-${mm}-${y}`, `${dd}.${mm}.${y}`, `${d} ${MONTHS[mi].slice(0,3)} ${y}`];
}

// A window around the value, trimmed back to whole words and clamped well
// under the 200-character span cap.
function window(text, value, before = 40, after = 70) {
  const i = text.indexOf(value);
  if (i === -1) return null;
  let start = Math.max(0, i - before);
  let end = Math.min(text.length, i + value.length + after);
  if (start > 0) { const sp = text.indexOf(" ", start); if (sp !== -1 && sp < i) start = sp + 1; }
  if (end < text.length) { const sp = text.lastIndexOf(" ", end); if (sp > i + value.length) end = sp; }
  const w = collapse(text.slice(start, end));
  return w.length <= CAP ? w : collapse(text.slice(i, i + value.length + 40)).slice(0, CAP);
}

const out = [];
for (const f of readdirSync(dir).filter((n) => n.endsWith(".truth.json")).sort()) {
  const base = f.replace(/\.truth\.json$/, "");
  const truth = JSON.parse(readFileSync(`${dir}/${f}`, "utf8"));
  const text = collapse(readFileSync(`${dir}/${base}.txt`, "utf8"));
  const e = truth.expected;
  const lines = [`  ${JSON.stringify(truth.filename)}: {`];
  const miss = [];
  for (const field of ["provider", "reference", "subtype"]) {
    const value = field === "subtype" ? subtypeSearchPhrase(e.subtype) : e[field];
    if (!value) continue;
    // Case is presentation, so find it however the page prints it.
    const flat = unescape_(text).toLowerCase();
    const idx = flat.indexOf(unescape_(collapse(value)).toLowerCase());
    // Map the position back: each stripped backslash shifted everything left.
    let real = 0, seen = 0;
    while (real < text.length && seen < idx) { if (!(text[real] === "\\" && /[&*_`#\[\]<>|~]/u.test(text[real + 1] ?? ""))) seen++; real++; }
    const len = collapse(value).length + (unescape_(collapse(value)).length !== collapse(value).length ? 0 : 0);
    const w = idx === -1 ? null : window(text, text.slice(real, real + len + 2).replace(/\s+$/u, ""));
    if (w) lines.push(`    ${field}: ${JSON.stringify(w)},`);
    else miss.push(field);
  }
  if (e.costMinor !== undefined) {
    const major = (e.costMinor / 100).toFixed(2);
    const sep = Number(major.split(".")[0]).toLocaleString("en-GB") + "." + major.split(".")[1];
    const printed = text.includes(sep) ? sep : major;
    const w = window(text, printed, 120, 25);
    if (w) lines.push(`    cost: { amount: ${JSON.stringify(printed)}, needle: ${JSON.stringify(w)} },`);
    else miss.push("cost");
  }
  if (e.recurrenceMonths !== undefined) {
    const w = window(text, `${e.recurrenceMonths} month`, 60, 40) ?? window(text, String(e.recurrenceMonths), 60, 40);
    if (w) lines.push(`    recurrence: { months: ${e.recurrenceMonths}, needle: ${JSON.stringify(w)} },`);
    else miss.push("recurrence");
  }
  if (e.dateRoles?.length) {
    lines.push("    dates: [");
    for (const r of e.dateRoles) {
      const form = dateForms(r.date).find((x) => text.includes(x));
      const w = form ? window(text, form, 55, 25) : null;
      if (w) lines.push(`      ${JSON.stringify(w)},`);
      else { miss.push(`date ${r.date}`); lines.push(`      /* MISSING ${r.date} */`); }
    }
    lines.push("    ],");
  }
  lines.push("  },");
  out.push(lines.join("\n"));
  if (miss.length) console.error(`!! ${base}: could not place ${miss.join(", ")}`);
}
console.log(out.join("\n"));
