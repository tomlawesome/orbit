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

  // Retail bank print: a neutral geometric sans with a narrow mono for the
  // figure columns.
  "mortgage-annual-statement.html": {
    faces: [FACE("Corpus Retail", "Rubik.ttf"), FACE("Corpus Retail Mono", "Inconsolata.ttf")],
    swap: [[/"Liberation Sans", sans-serif/g, '"Corpus Retail", sans-serif'], [/"Liberation Mono", monospace/g, '"Corpus Retail Mono", monospace']],
  },
  // A trade certification pad: plain grotesque labels, a plain fixed-width
  // fill. Nothing about a test certificate is designed.
  "electrical-condition-report.html": {
    faces: [FACE("Corpus Trade", "Barlow-Regular.ttf", "400"), FACE("Corpus Trade Mono", "AnonymousPro-Regular.ttf", "400")],
    swap: [[/"Liberation Sans", sans-serif/g, '"Corpus Trade", sans-serif'], [/"Liberation Mono", monospace/g, '"Corpus Trade Mono", monospace']],
  },
  // Direct mail: a warm humanist sans, testimonial in a slab.
  "breakdown-cover-renewal.html": {
    faces: [FACE("Corpus Motor", "Cabin.ttf"), FACE("Corpus Motor Slab", "ZillaSlab-Regular.ttf", "400")],
    swap: [[/"Liberation Sans", sans-serif/g, '"Corpus Motor", sans-serif'], [/"Liberation Serif", serif/g, '"Corpus Motor Slab", serif']],
  },
  // A near-empty confirmation: a book serif set large, the licence panel in a
  // condensed sans that looks municipal.
  "tv-licence-confirmation.html": {
    faces: [FACE("Corpus Licence", "Lora.ttf"), FACE("Corpus Licence Sans", "Oswald.ttf")],
    swap: [[/"Liberation Serif", serif/g, '"Corpus Licence", serif'], [/"Liberation Sans", sans-serif/g, '"Corpus Licence Sans", sans-serif']],
  },
  // A form filled in at a desk: printed contract in a plain sans, the blanks
  // in a marker hand. The mismatch is the whole look.
  "gym-membership-agreement.html": {
    faces: [FACE("Corpus Club", "Mulish.ttf"), FACE("Corpus Hand Fill", "Caveat.ttf")],
    swap: [[/"Liberation Sans", sans-serif/g, '"Corpus Club", sans-serif'], [/"Liberation Serif", serif/g, '"Corpus Hand Fill", serif']],
  },
  // Generation data: an old-style serif against a typewriter mono, a pairing
  // nothing else in the corpus uses.
  "solar-export-statement.html": {
    faces: [FACE("Corpus Export", "Alegreya.ttf"), FACE("Corpus Export Mono", "CutiveMono-Regular.ttf", "400")],
    swap: [[/"Liberation Serif", serif/g, '"Corpus Export", serif'], [/"Liberation Mono", monospace/g, '"Corpus Export Mono", monospace']],
  },

  // A printed web page: one neutral UI sans doing every job at every size.
  "mobile-airtime-plan.html": {
    faces: [FACE("Corpus Screen", "Manrope.ttf")],
    swap: [[/"Liberation Sans", sans-serif/g, '"Corpus Screen", sans-serif']],
  },
  // A certificate pretending to be valuable: a high-contrast display garalde
  // over the plain sans of the terms bolted to its foot.
  "appliance-warranty-certificate.html": {
    faces: [FACE("Corpus Ceremony", "CormorantGaramond.ttf"), FACE("Corpus Ceremony Sans", "Asap.ttf")],
    swap: [[/"Liberation Serif", serif/g, '"Corpus Ceremony", serif'], [/"Liberation Sans", sans-serif/g, '"Corpus Ceremony Sans", sans-serif']],
  },
  // Clinical and cheap: a plain grotesque, with the pasted-in direct debit
  // guarantee in a book serif that does not match it.
  "dental-plan-statement.html": {
    faces: [FACE("Corpus Clinic", "Saira.ttf"), FACE("Corpus Guarantee", "Tinos-Regular.ttf", "400")],
    swap: [[/"Liberation Sans", sans-serif/g, '"Corpus Clinic", sans-serif'], [/"Liberation Serif", serif/g, '"Corpus Guarantee", serif']],
  },
  // Institutional actuarial print: an old-style serif for the wording, a
  // neutral sans for the projection tables.
  "pension-benefit-statement.html": {
    faces: [FACE("Corpus Actuary", "Vollkorn.ttf"), FACE("Corpus Actuary Sans", "Bitter.ttf")],
    swap: [[/"Liberation Serif", serif/g, '"Corpus Actuary", serif'], [/"Liberation Sans", sans-serif/g, '"Corpus Actuary Sans", sans-serif']],
  },
  // Made to be carried and read in a hurry: a wide slab against a book serif.
  "travel-insurance-certificate.html": {
    faces: [FACE("Corpus Travel", "Arvo-Regular.ttf", "400"), FACE("Corpus Travel Serif", "Spectral-Regular.ttf", "400")],
    swap: [[/"Liberation Sans", sans-serif/g, '"Corpus Travel", sans-serif'], [/"Liberation Serif", serif/g, '"Corpus Travel Serif", serif']],
  },
  // Generated by a database and posted out: a workmanlike slab serif for the
  // justified wording, a plain sans for the registration strip.
  "window-installation-guarantee.html": {
    faces: [FACE("Corpus Scheme", "Domine.ttf"), FACE("Corpus Scheme Sans", "PublicSans.ttf")],
    swap: [[/"Liberation Serif", serif/g, '"Corpus Scheme", serif'], [/"Liberation Sans", sans-serif/g, '"Corpus Scheme Sans", sans-serif']],
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
