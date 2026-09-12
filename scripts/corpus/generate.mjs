// Generate the full-page corpus module from the rendered fixtures.
//
// The text is what the real Tika produced, so it is copied byte for byte and
// escaped with JSON.stringify. A template literal would eat the backslashes
// in Tika's `\&` escapes -- the very thing #982 is about -- and silently
// change the fixture.
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { basename, dirname, resolve } from "node:path";
import { corpusDir, positional } from "./corpus-dir.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

// The first positional argument still names the corpus directory, as it
// always did; `--dir` does the same job for the scripts that never took one.
const dir = positional[0] ?? corpusDir;
// Which corpus this is decides the module written and the constant exported.
// A hold-out is a separate module on purpose: it is scored, never added to
// `EXTRACTION_CORPUS`, so nothing tuning against the 24 can read it.
//
// Naming is derived from the directory's own basename rather than hard-coded
// to one hold-out, because a directory called `holdout` was never going to
// stay the only one (#997 added `holdout2` without reading `holdout`, and a
// third would follow the same rule): a fixed `HOLDOUT ? a : b` choice between
// exactly two names silently overwrote the first hold-out's module the day a
// second one was generated. `sources` keeps its historical, differently-named
// module and export; every other directory gets a module and export derived
// from its own name, so two hold-outs never collide.
const name = basename(dir);
const HOLDOUT = name !== "sources";
const out = positional[1] ?? resolve(
  HERE,
  HOLDOUT
    ? `../../src/server/documents/extraction-${name}-fullpage.ts`
    : "../../src/server/documents/extraction-corpus-fullpage.ts",
);
const exportName = positional[2] ?? (HOLDOUT ? `EXTRACTION_${name.toUpperCase().replace(/-/gu, "_")}_FULLPAGE` : "FULL_PAGE_CORPUS");

const entries = readdirSync(dir).filter((f) => f.endsWith(".truth.json")).sort().map((f) => {
  const base = f.replace(/\.truth\.json$/, "");
  const truth = JSON.parse(readFileSync(`${dir}/${f}`, "utf8"));
  const text = readFileSync(`${dir}/${base}.txt`, "utf8");
  const e = truth.expected;
  const lines = [`    dates: ${JSON.stringify(e.dates ?? [])},`];
  if (e.provider) lines.push(`    provider: ${JSON.stringify(e.provider)},`);
  if (e.reference) lines.push(`    reference: ${JSON.stringify(e.reference)},`);
  if (e.dateRoles) {
    lines.push("    dateRoles: [");
    for (const r of e.dateRoles) lines.push(`      { date: ${JSON.stringify(r.date)}, role: ${JSON.stringify(r.role)} },`);
    lines.push("    ],");
  }
  if (e.subtype) lines.push(`    subtype: ${JSON.stringify(e.subtype)},`);
  if (e.costMinor !== undefined) lines.push(`    costMinor: ${e.costMinor},`);
  if (e.currency) lines.push(`    currency: ${JSON.stringify(e.currency)},`);
  if (e.recurrenceMonths !== undefined) lines.push(`    recurrenceMonths: ${e.recurrenceMonths},`);
  if (e.scheduleKind) lines.push(`    scheduleKind: ${JSON.stringify(e.scheduleKind)},`);
  const notes = [].concat(truth.notes ?? []).map((n) => `   * - ${n.replace(/\*\//gu, "*\\/")}`).join("\n");
  return `  {
${notes ? `    // Ground-truth notes:\n${notes.split("\n").map((l) => "    //" + l.slice(4)).join("\n")}\n` : ""}    name: ${JSON.stringify(truth.name)},
    filename: ${JSON.stringify(truth.filename)},
    text: ${JSON.stringify(text)},
    expected: {
${lines.join("\n")}
    },
  },`;
});

const scoreCommand = name === "holdout" ? "npm run eval:holdout" : `npm run eval:holdout -- --${name}`;
const preamble = HOLDOUT
  ? `// GENERATED FILE — do not edit by hand.
//
// A HOLD-OUT set: full-page documents written after the extractor was
// tuned, by someone who had not read \`scripts/corpus/sources/\` (or, for a
// later hold-out, any earlier hold-out either -- \`${name}\` is${name === "holdout" ? "" : " not"} the first).
// They are the generalisation measurement, so they are deliberately NOT part
// of \`EXTRACTION_CORPUS\`: nothing tuning against the tuning set pulls them
// in, and tuning against a hold-out would destroy the only unseen number the
// project has for it.
//
// Score with \`${scoreCommand}\`. Regenerate with:
//
//   node scripts/corpus/generate.mjs --dir ${name}
//`
  : `// GENERATED FILE — do not edit by hand.
//
// Full-page extraction fixtures for #981. Regenerate with:
//
//   node scripts/corpus/generate.mjs
//`;

writeFileSync(out, `${preamble}
// Each document was written as HTML, rendered to PDF with Playwright at A4,
// and parsed with the real Tika using the request in \`tika.ts\`. The \`text\`
// below is Tika's output byte for byte — escapes, flattened table columns,
// repeated page headers and all. That is the point: the fixture is what
// production actually sees, not a tidied version of it.
//
// The originals live in \`${`scripts/corpus/${basename(dir)}/`}\`. Never edit
// \`text\` here; edit the HTML and regenerate, so the fixture and the document
// it came from cannot drift apart.

import type { CorpusDocument } from "./extraction-corpus";

export const ${exportName}: CorpusDocument[] = [
${entries.join("\n")}
];
`);
console.log(`${entries.length} documents -> ${out}`);
