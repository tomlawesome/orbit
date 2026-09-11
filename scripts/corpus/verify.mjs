// Verify each sources/<name>.truth.json against the real Tika output in
// <name>.txt. Nothing is assumed: every declared value must be findable in the
// text Tika actually produced, or the document is not usable as ground truth.
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
const HERE = dirname(fileURLToPath(import.meta.url));
const dir = resolve(HERE, "sources");



const MONTHS = ["January","February","March","April","May","June","July","August","September","October","November","December"];

// The printed forms a UK document may legitimately use for one ISO date.
function dateForms(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  const mi = m - 1, dd = String(d).padStart(2, "0"), mm = String(m).padStart(2, "0");
  return [
    `${dd}/${mm}/${y}`, `${d}/${m}/${y}`, `${dd}-${mm}-${y}`, `${dd}.${mm}.${y}`,
    `${d} ${MONTHS[mi]} ${y}`, `${dd} ${MONTHS[mi]} ${y}`,
    `${d} ${MONTHS[mi].slice(0, 3)} ${y}`, `${dd} ${MONTHS[mi].slice(0, 3)} ${y}`,
    `${MONTHS[mi]} ${d}, ${y}`, `${d}${["st","nd","rd"][((d%100-20)%10||d%100)-1]||"th"} ${MONTHS[mi]} ${y}`,
    iso,
  ];
}

// Tika escapes Markdown metacharacters that are not in the PDF (#982), and
// flattens table columns into runs of spaces. Normalise both away before
// looking for a value, so a real miss is not hidden by a known artefact.
const normalise = (s) => s.replace(/\\([&*_`#\[\]<>|~])/gu, "$1").replace(/\s+/gu, " ");
// Case is not a presence question, and the owner has ruled that all caps is a
// correct answer (#965 note 16522). Fold it when asking "is this value here".
const findable = (s) => normalise(s).toLowerCase();

function money(minor, currency) {
  const sym = currency === "GBP" ? "£" : "";
  const major = (minor / 100).toFixed(2);
  const withSep = Number(major.split(".")[0]).toLocaleString("en-GB") + "." + major.split(".")[1];
  return [`${sym}${major}`, `${sym}${withSep}`, major, withSep];
}

let bad = 0, files = 0;
for (const f of readdirSync(dir).filter((n) => n.endsWith(".truth.json")).sort()) {
  const base = f.replace(/\.truth\.json$/, "");
  let text, raw;
  try { raw = normalise(readFileSync(`${dir}/${base}.txt`, "utf8")); text = raw.toLowerCase(); }
  catch { console.log(`\n${base}\n  MISSING ${base}.txt — not parsed yet`); bad++; continue; }
  const truth = JSON.parse(readFileSync(`${dir}/${f}`, "utf8"));
  const e = truth.expected ?? {};
  const problems = [];
  files++;

  for (const iso of e.dates ?? []) {
    if (!dateForms(iso).some((form) => text.includes(form.toLowerCase()))) problems.push(`date ${iso} appears in no recognised printed form`);
  }
  for (const field of ["provider", "reference", "subtype"]) {
    const v = e[field];
    if (v !== undefined && !text.includes(findable(v))) problems.push(`${field} "${v}" is not in the Tika text`);
  }
  if (e.costMinor !== undefined) {
    if (e.currency === undefined) problems.push("costMinor declared without currency");
    if (!money(e.costMinor, e.currency).some((m) => text.includes(m))) problems.push(`costMinor ${e.costMinor} prints as none of ${money(e.costMinor, e.currency).join(" / ")}`);
  }
  if (e.currency !== undefined && e.costMinor === undefined) problems.push("currency declared without costMinor");
  if (e.recurrenceMonths !== undefined && !new RegExp(`\\b${e.recurrenceMonths}\\b`, "u").test(text)) {
    problems.push(`recurrenceMonths ${e.recurrenceMonths} is not printed in digits`);
  }
  const roles = e.dateRoles ?? [];
  if (roles.length !== (e.dates ?? []).length) problems.push(`${roles.length} dateRoles for ${(e.dates ?? []).length} dates`);
  for (const r of roles) {
    if (!["renewal","expiry","due","service","issued","start","other"].includes(r.role)) problems.push(`role "${r.role}" is not a DocumentDateRole`);
    if (!(e.dates ?? []).includes(r.date)) problems.push(`dateRoles names ${r.date}, which is not in dates`);
  }
  const derived = roles.some((r) => r.role === "renewal") ? "renewal" : roles.some((r) => r.role === "service") ? "service" : undefined;
  if (e.scheduleKind !== derived) problems.push(`scheduleKind is ${e.scheduleKind ?? "(absent)"} but the roles derive ${derived ?? "(none)"}`);

  const dateLike = (raw.match(/\b\d{1,2}[\/.-]\d{1,2}[\/.-]\d{2,4}\b|\b\d{1,2} (?:January|February|March|April|May|June|July|August|September|October|November|December) \d{4}\b/gu) ?? []).length;
  console.log(`\n${base}  ${text.length} chars, ${dateLike} date-like strings, ${(e.dates ?? []).length} of them answers`);
  if (problems.length === 0) console.log("  OK");
  else { bad++; for (const p of problems) console.log(`  FAIL ${p}`); }
}
console.log(`\n${files} documents checked, ${bad} with problems`);
process.exit(bad === 0 ? 0 : 1);
