// Give every corpus document its own typeface.
//
// Only ten fonts are installed on this host, and real household paper is not
// printed in ten faces -- every provider uses its own. The typeface also
// decides the PDF's character map, which is where extraction faults like the
// \& escape in #982 come from, so this is not only cosmetic.
//
// The assignment is FIXED, not random: the corpus text is committed ground
// truth, and a face that changed per render would change what Tika emits and
// silently invalidate it.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
const HERE = dirname(fileURLToPath(import.meta.url));
const dir = resolve(HERE, "sources");


const FACE = (family, file, weight = "100 900", style = "normal") =>
  `@font-face{font-family:"${family}";src:url("../fonts/${file}") format("truetype");font-weight:${weight};font-style:${style};font-display:block}`;

const DOCS = {
  // A government form, set in the family commissioned for Russian state use.
  "mot-certificate.html": {
    faces: [FACE("Corpus Sans", "PT_Sans-Web-Regular.ttf", "400"), FACE("Corpus Sans", "PT_Sans-Web-Bold.ttf", "700"), FACE("Corpus Mono", "PTM55FT.ttf", "400")],
    swap: [[/"Liberation Sans", sans-serif/g, '"Corpus Sans", sans-serif'], [/"Liberation Mono", monospace/g, '"Corpus Mono", monospace']],
  },
  // Bulk-printed insurance: a book serif, cheap and dense.
  "home-insurance-schedule.html": {
    faces: [FACE("Corpus Serif", "SourceSerif4.ttf")],
    swap: [[/"Liberation Serif", serif/g, '"Corpus Serif", serif']],
  },
  // A carbon pad: typewriter fill-ins against condensed pre-printed labels.
  "gas-safety-record.html": {
    faces: [FACE("Corpus Typewriter", "CourierPrime-Regular.ttf", "400"), FACE("Corpus Typewriter", "CourierPrime-Bold.ttf", "700"), FACE("Corpus Condensed", "ArchivoNarrow.ttf")],
    swap: [[/"Courier 10 Pitch", "Liberation Mono", "FreeMono", monospace/g, '"Corpus Typewriter", monospace'], [/"Courier 10 Pitch", "Liberation Mono", monospace/g, '"Corpus Typewriter", monospace'], [/"Liberation Sans", "FreeSans", sans-serif/g, '"Corpus Condensed", sans-serif']],
  },
  // A solicitor-ish letter, in an old-style garalde.
  "service-charge-demand.html": {
    faces: [FACE("Corpus Letter", "EBGaramond.ttf"), FACE("Corpus Letter", "EBGaramond-Italic.ttf", "100 900", "italic")],
    swap: [[/"Bitstream Charter", "Liberation Serif", serif/g, '"Corpus Letter", serif']],
  },
  // A consumer vet booklet: rounded and friendly.
  "pet-vaccination-card.html": {
    faces: [FACE("Corpus Friendly", "Nunito.ttf"), FACE("Corpus Hand", "EBGaramond-Italic.ttf", "100 900", "italic")],
    swap: [[/"FreeSans", "Loma", sans-serif/g, '"Corpus Friendly", sans-serif'], [/"FreeSerif", serif/g, '"Corpus Hand", serif']],
  },
  // A challenger telecoms brand: a geometric display sans.
  "broadband-contract.html": {
    faces: [FACE("Corpus Brand", "SpaceGrotesk.ttf")],
    swap: [[/"Liberation Sans", sans-serif/g, '"Corpus Brand", sans-serif']],
  },

  // ---- the 18 further documents (#986) ----

  // Bulk-printed motor insurance: a workhorse newspaper serif, tables in a
  // neutral grotesque.
  "car-insurance-renewal.html": {
    faces: [FACE("Corpus Bulk", "PT_Serif-Web-Regular.ttf", "400"), FACE("Corpus Bulk", "PT_Serif-Web-Bold.ttf", "700"), FACE("Corpus Bulk Sans", "IBMPlexSans.ttf")],
    swap: [[/"Liberation Serif", serif/g, '"Corpus Bulk", serif'], [/"Liberation Sans", sans-serif/g, '"Corpus Bulk Sans", sans-serif']],
  },
  // A mailmerge letter: a high-contrast book face, as printed correspondence.
  "energy-tariff-end.html": {
    faces: [FACE("Corpus Post", "LibreBaskerville.ttf"), FACE("Corpus Post Sans", "PublicSans.ttf")],
    swap: [[/"Bitstream Charter", serif/g, '"Corpus Post", serif'], [/"Liberation Sans", sans-serif/g, '"Corpus Post Sans", sans-serif']],
  },
  // Municipal bulk print: a humanist sans with its matching mono for the
  // instalment column.
  "council-tax-demand.html": {
    faces: [FACE("Corpus Civic", "FiraSans-Regular.ttf", "400"), FACE("Corpus Civic", "FiraSans-Bold.ttf", "700"), FACE("Corpus Civic Mono", "FiraMono-Regular.ttf", "400")],
    swap: [[/"Liberation Sans", sans-serif/g, '"Corpus Civic", sans-serif'], [/"Liberation Mono", monospace/g, '"Corpus Civic Mono", monospace']],
  },
  // Continuous stationery: a squared-off terminal mono doing the figures.
  "water-bill.html": {
    faces: [FACE("Corpus Line Printer", "ShareTechMono-Regular.ttf", "400"), FACE("Corpus Utility", "WorkSans.ttf")],
    swap: [[/"Liberation Mono", monospace/g, '"Corpus Line Printer", monospace'], [/"Liberation Sans", sans-serif/g, '"Corpus Utility", sans-serif']],
  },
  // A government form: tiny pre-printed labels against a machine-filled mono.
  "vehicle-tax-reminder.html": {
    faces: [FACE("Corpus Official", "Karla.ttf"), FACE("Corpus Official Mono", "JetBrainsMono.ttf")],
    swap: [[/"Liberation Sans", sans-serif/g, '"Corpus Official", sans-serif'], [/"Liberation Mono", monospace/g, '"Corpus Official Mono", monospace']],
  },
  // A saddle-stitched terms booklet: an old-style text face set small in two
  // columns, headings in a grotesque.
  "life-cover-booklet.html": {
    faces: [FACE("Corpus Booklet", "CrimsonPro.ttf"), FACE("Corpus Booklet Sans", "IBMPlexSans.ttf")],
    swap: [[/"Liberation Serif", serif/g, '"Corpus Booklet", serif'], [/"Liberation Sans", sans-serif/g, '"Corpus Booklet Sans", sans-serif']],
  },
};

for (const [file, { faces, swap }] of Object.entries(DOCS)) {
  const path = `${dir}/${file}`;
  // Documents arrive in waves, so the table lists files that may not be
  // written yet. A missing one is not an error; it is simply not built.
  if (!existsSync(path)) { console.log(`${file}: not written yet, skipped`); continue; }
  let s = readFileSync(path, "utf8");
  if (s.includes("@font-face")) { console.log(`${file}: already has @font-face, skipped`); continue; }
  let n = 0;
  for (const [from, to] of swap) {
    const before = s;
    s = s.replace(from, to);
    if (s !== before) n++;
  }
  if (n !== swap.length) { console.log(`${file}: FAILED — ${n}/${swap.length} swaps matched`); continue; }
  s = s.replace(/<style>/, `<style>\n${faces.join("\n")}`);
  writeFileSync(path, s);
  console.log(`${file}: ${faces.length} faces, ${n} swaps`);
}
