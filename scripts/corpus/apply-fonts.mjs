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
import { corpusDir, positional } from "./corpus-dir.mjs";
const dir = corpusDir;
// An optional filename limits the run to one document, so a document being
// written in parallel with another is not touched mid-write.
const only = positional[0];


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

  // ---- the 12 hold-out documents (#986 step 8) ----
  //
  // Twenty new faces, so the hold-out shares no character map with the 24
  // it is scored against: a fault that only shows up in one font encoding
  // would otherwise be tuned away on the 24 and never met again.

  // Bulk-printed pet insurance: a screen-first book serif with a grotesque
  // for the benefit tables.
  "pet-insurance-schedule.html": {
    faces: [FACE("Corpus Pet", "Literata.ttf"), FACE("Corpus Pet Sans", "LibreFranklin.ttf")],
    swap: [[/"Liberation Serif", serif/g, '"Corpus Pet", serif'], [/"Liberation Sans", sans-serif/g, '"Corpus Pet Sans", sans-serif']],
  },
  // A mailmerge letter with a tear-off payment slip: a newspaper serif over
  // a neutral UI sans.
  "boiler-service-plan-letter.html": {
    faces: [FACE("Corpus Boiler", "Faustina.ttf"), FACE("Corpus Boiler Sans", "Inter.ttf")],
    swap: [[/"Liberation Serif", serif/g, '"Corpus Boiler", serif'], [/"Liberation Sans", sans-serif/g, '"Corpus Boiler Sans", sans-serif']],
  },
  // A letting agent's contract: a text serif for the clauses, a typewriter
  // mono for the particulars typed into the schedule.
  "tenancy-agreement.html": {
    faces: [FACE("Corpus Tenancy", "Newsreader.ttf"), FACE("Corpus Tenancy Mono", "SpaceMono-Regular.ttf", "400"), FACE("Corpus Tenancy Mono", "SpaceMono-Bold.ttf", "700")],
    swap: [[/"Liberation Serif", serif/g, '"Corpus Tenancy", serif'], [/"Liberation Mono", monospace/g, '"Corpus Tenancy Mono", monospace']],
  },
  // A regulated credit agreement: a grotesque for the boxed wording, a code
  // mono for the payment figures.
  "car-finance-agreement.html": {
    faces: [FACE("Corpus Finance", "Archivo.ttf"), FACE("Corpus Finance Mono", "SourceCodePro.ttf")],
    swap: [[/"Liberation Sans", sans-serif/g, '"Corpus Finance", sans-serif'], [/"Liberation Mono", monospace/g, '"Corpus Finance Mono", monospace']],
  },
  // A ticket-office print: a wide machine mono on the ticket itself, a sans
  // for the receipt beneath it.
  "rail-season-ticket.html": {
    faces: [FACE("Corpus Ticket", "MartianMono.ttf"), FACE("Corpus Ticket Sans", "LibreFranklin.ttf")],
    swap: [[/"Liberation Mono", monospace/g, '"Corpus Ticket", monospace'], [/"Liberation Sans", sans-serif/g, '"Corpus Ticket Sans", sans-serif']],
  },
  // Council print: a display sans for the permit panel, a mono for the
  // vehicle and permit numbers.
  "residents-parking-permit.html": {
    faces: [FACE("Corpus Permit", "RedHatDisplay.ttf"), FACE("Corpus Permit Mono", "SpaceMono-Regular.ttf", "400"), FACE("Corpus Permit Mono", "SpaceMono-Bold.ttf", "700")],
    swap: [[/"Liberation Sans", sans-serif/g, '"Corpus Permit", sans-serif'], [/"Liberation Mono", monospace/g, '"Corpus Permit Mono", monospace']],
  },
  // A printed e-mail: one screen sans at every size, as the mail client set
  // it.
  "streaming-subscription-invoice.html": {
    faces: [FACE("Corpus Mail", "PlusJakartaSans.ttf")],
    swap: [[/"Liberation Sans", sans-serif/g, '"Corpus Mail", sans-serif']],
  },
  // Nursery stationery: a light geometric display sans over a book serif.
  "nursery-fees-invoice.html": {
    faces: [FACE("Corpus Nursery", "JosefinSans.ttf"), FACE("Corpus Nursery Serif", "Gelasio.ttf")],
    swap: [[/"Liberation Sans", sans-serif/g, '"Corpus Nursery", sans-serif'], [/"Liberation Serif", serif/g, '"Corpus Nursery Serif", serif']],
  },
  // A control panel printed from a browser: a contemporary sans with a code
  // mono for nameservers and record IDs.
  "domain-hosting-renewal.html": {
    faces: [FACE("Corpus Host", "Epilogue.ttf"), FACE("Corpus Host Mono", "SourceCodePro.ttf")],
    swap: [[/"Liberation Sans", sans-serif/g, '"Corpus Host", sans-serif'], [/"Liberation Mono", monospace/g, '"Corpus Host Mono", monospace']],
  },
  // A government-scheme certificate: a plain public-sector sans, ratings and
  // figures in a mono.
  "energy-performance-certificate.html": {
    faces: [FACE("Corpus EPC", "SourceSans3.ttf"), FACE("Corpus EPC Mono", "SpaceMono-Regular.ttf", "400"), FACE("Corpus EPC Mono", "SpaceMono-Bold.ttf", "700")],
    swap: [[/"Liberation Sans", sans-serif/g, '"Corpus EPC", sans-serif'], [/"Liberation Mono", monospace/g, '"Corpus EPC Mono", monospace']],
  },
  // A carbonless pad filled in on a doorstep: a pre-printed serif against a
  // ballpoint hand.
  "alarm-monitoring-agreement.html": {
    faces: [FACE("Corpus Alarm", "Petrona.ttf"), FACE("Corpus Ballpoint", "Kalam-Regular.ttf", "400"), FACE("Corpus Ballpoint", "Kalam-Bold.ttf", "700")],
    swap: [[/"Liberation Serif", serif/g, '"Corpus Alarm", serif'], [/"Bitstream Charter", serif/g, '"Corpus Ballpoint", cursive']],
  },
  // Direct-mail protection selling: a high-contrast display serif for the
  // headlines, a neutral sans for the illustration tables.
  "critical-illness-quote.html": {
    faces: [FACE("Corpus Quote", "DMSerifDisplay-Regular.ttf", "400"), FACE("Corpus Quote Sans", "Inter.ttf")],
    swap: [[/"Liberation Serif", serif/g, '"Corpus Quote", serif'], [/"Liberation Sans", sans-serif/g, '"Corpus Quote Sans", sans-serif']],
  },

  // ---- the SECOND hold-out, 12 further documents (#997) ----
  //
  // Twenty-three more faces, none used by `sources/` or the first `holdout/`:
  // this third corpus shares no character map with either of the other two,
  // for the same reason the first hold-out shared none with the tuning set.

  // A holiday park's own letterhead: a warm display serif over a rounded sans.
  "holiday-lodge-site-licence.html": {
    faces: [FACE("Corpus Park", "PlayfairDisplay.ttf"), FACE("Corpus Park Sans", "NunitoSans.ttf")],
    swap: [[/"Liberation Serif", serif/g, '"Corpus Park", serif'], [/"Liberation Sans", sans-serif/g, '"Corpus Park Sans", sans-serif']],
  },
  // An institutional invoice: a plain book serif over a code mono for the
  // fee table and reference numbers.
  "university-halls-invoice.html": {
    faces: [FACE("Corpus Halls", "NotoSerif.ttf"), FACE("Corpus Halls Mono", "IBMPlexMono-Regular.ttf", "400"), FACE("Corpus Halls Mono", "IBMPlexMono-Bold.ttf", "700")],
    swap: [[/"Liberation Serif", serif/g, '"Corpus Halls", serif'], [/"Liberation Mono", monospace/g, '"Corpus Halls Mono", monospace']],
  },
  // A guarantee certificate: an old-style text serif for the wording, a
  // plain grotesque for the specification table.
  "cavity-wall-insulation-guarantee.html": {
    faces: [FACE("Corpus Guarantee", "Cardo-Regular.ttf", "400"), FACE("Corpus Guarantee", "Cardo-Bold.ttf", "700"), FACE("Corpus Guarantee Sans", "Overpass.ttf")],
    swap: [[/"Bitstream Charter", serif/g, '"Corpus Guarantee", serif'], [/"Liberation Sans", sans-serif/g, '"Corpus Guarantee Sans", sans-serif']],
  },
  // A trade order note: a code mono for the fill-in figures, a bold
  // grotesque for the brand and headings.
  "skip-hire-contract.html": {
    faces: [FACE("Corpus Skip Mono", "OverpassMono.ttf"), FACE("Corpus Skip", "Chivo.ttf")],
    swap: [[/"Liberation Mono", monospace/g, '"Corpus Skip Mono", monospace'], [/"Liberation Sans", sans-serif/g, '"Corpus Skip", sans-serif']],
  },
  // An insurance schedule: a soft book serif for the wording, a neutral sans
  // for the cover table and labels.
  "home-emergency-cover-schedule.html": {
    faces: [FACE("Corpus Emergency", "Neuton-Regular.ttf", "400"), FACE("Corpus Emergency", "Neuton-Bold.ttf", "700"), FACE("Corpus Emergency Sans", "DMSans.ttf")],
    swap: [[/"Liberation Serif", serif/g, '"Corpus Emergency", serif'], [/"Liberation Sans", sans-serif/g, '"Corpus Emergency Sans", sans-serif']],
  },
  // A modern self-storage brand: a geometric display sans over a code mono
  // for unit and access codes.
  "self-storage-agreement.html": {
    faces: [FACE("Corpus Storage", "Poppins-Regular.ttf", "400"), FACE("Corpus Storage", "Poppins-Bold.ttf", "700"), FACE("Corpus Storage Mono", "DMMono-Regular.ttf", "400")],
    swap: [[/"Liberation Sans", sans-serif/g, '"Corpus Storage", sans-serif'], [/"Liberation Mono", monospace/g, '"Corpus Storage Mono", monospace']],
  },
  // A leasing company's statement: a plain sans for the wording, a code mono
  // for the payment schedule.
  "car-lease-statement.html": {
    faces: [FACE("Corpus Lease", "Raleway.ttf"), FACE("Corpus Lease Mono", "Cousine-Regular.ttf", "400"), FACE("Corpus Lease Mono", "Cousine-Bold.ttf", "700")],
    swap: [[/"Liberation Sans", sans-serif/g, '"Corpus Lease", sans-serif'], [/"Liberation Mono", monospace/g, '"Corpus Lease Mono", monospace']],
  },
  // A printed consumer bill: one neutral UI sans doing every job.
  "satellite-tv-subscription-invoice.html": {
    faces: [FACE("Corpus Satellite", "HankenGrotesk.ttf")],
    swap: [[/"Liberation Sans", sans-serif/g, '"Corpus Satellite", sans-serif']],
  },
  // A friendly consumer certificate: a rounded sans for the branding, a
  // display serif for the certificate wording.
  "health-cash-plan-certificate.html": {
    faces: [FACE("Corpus Cashplan", "Quicksand.ttf"), FACE("Corpus Cashplan Serif", "BreeSerif-Regular.ttf", "400")],
    swap: [[/"FreeSans", "Loma", sans-serif/g, '"Corpus Cashplan", sans-serif'], [/"FreeSerif", serif/g, '"Corpus Cashplan Serif", serif']],
  },
  // A sole trader's invoice: a plain sans for the printed template, a
  // handwriting face for the instructor's own signature.
  "driving-lessons-invoice.html": {
    faces: [FACE("Corpus Tuition", "Sora.ttf"), FACE("Corpus Signature", "PatrickHand-Regular.ttf", "400")],
    swap: [[/"Liberation Sans", sans-serif/g, '"Corpus Tuition", sans-serif'], [/"FreeSerif", serif/g, '"Corpus Signature", serif']],
  },
  // A parchment-style certificate: a display serif for the brand, a plainer
  // old-style serif for the body wording.
  "funeral-plan-certificate.html": {
    faces: [FACE("Corpus Evergreen", "Cormorant.ttf"), FACE("Corpus Evergreen Body", "LibreCaslonText.ttf")],
    swap: [[/"Bitstream Charter", serif/g, '"Corpus Evergreen", serif'], [/"Liberation Serif", serif/g, '"Corpus Evergreen Body", serif']],
  },
  // A trade certificate: a code mono doing the measurements and figures, a
  // bold slab for the trader's own three-letter mark.
  "chimney-sweep-certificate.html": {
    faces: [FACE("Corpus Sweep Mono", "FiraCode.ttf"), FACE("Corpus Sweep Brand", "Bevan-Regular.ttf", "400")],
    swap: [[/"Liberation Mono", monospace/g, '"Corpus Sweep Mono", monospace'], [/"Bitstream Charter", serif/g, '"Corpus Sweep Brand", serif']],
  },

  // ---- the THIRD hold-out, 12 further documents (#998) ----
  //
  // Twenty-six more faces, none used by `sources/` (which now includes the
  // first two retired hold-outs) or by either of them alone, so this third
  // hold-out shares no character map with the tuning set.

  // A parent-portal statement: a plain UI sans for the page, a dot-matrix
  // mono for the till-style transaction ledger.
  "school-meals-account-statement.html": {
    faces: [FACE("Corpus Meals", "RedHatText.ttf"), FACE("Corpus Meals Mono", "VT323-Regular.ttf", "400")],
    swap: [[/"Liberation Sans", sans-serif/g, '"Corpus Meals", sans-serif'], [/"Liberation Mono", monospace/g, '"Corpus Meals Mono", monospace']],
  },
  // An old-fashioned association's typed agreement: an old-style serif
  // body, a condensed sans for the labels.
  "allotment-tenancy-agreement.html": {
    faces: [FACE("Corpus Allotment", "OldStandard-Regular.ttf", "400"), FACE("Corpus Allotment", "OldStandard-Bold.ttf", "700"), FACE("Corpus Allotment", "OldStandard-Italic.ttf", "400", "italic"), FACE("Corpus Allotment Sans", "FiraSansCondensed-Regular.ttf", "400"), FACE("Corpus Allotment Sans", "FiraSansCondensed-Bold.ttf", "700")],
    swap: [[/"Bitstream Charter", serif/g, '"Corpus Allotment", serif'], [/"Liberation Sans", sans-serif/g, '"Corpus Allotment Sans", sans-serif']],
  },
  // An insurtech certificate: one humanist sans doing every job.
  "cycle-insurance-certificate.html": {
    faces: [FACE("Corpus Cycle", "AlegreyaSans-Regular.ttf", "400"), FACE("Corpus Cycle", "AlegreyaSans-Bold.ttf", "700")],
    swap: [[/"Liberation Sans", sans-serif/g, '"Corpus Cycle", sans-serif']],
  },
  // A small cleaning firm's contract: a friendly condensed sans throughout.
  "domestic-cleaning-contract.html": {
    faces: [FACE("Corpus Clean", "CabinCondensed-Regular.ttf", "400"), FACE("Corpus Clean", "CabinCondensed-Bold.ttf", "700")],
    swap: [[/"Liberation Sans", sans-serif/g, '"Corpus Clean", sans-serif']],
  },
  // A sole trader's invoice: a condensed sans template, a handwriting face
  // for the personal sign-off.
  "music-tuition-invoice.html": {
    faces: [FACE("Corpus Tuition", "BarlowCondensed-Regular.ttf", "400"), FACE("Corpus Signoff", "ShadowsIntoLight.ttf", "400")],
    swap: [[/"Liberation Sans", sans-serif/g, '"Corpus Tuition", sans-serif'], [/"Bitstream Charter", cursive/g, '"Corpus Signoff", cursive']],
  },
  // A conservation charity's letter: a warm serif for the wording, a plain
  // sans for the account details.
  "charity-giving-confirmation.html": {
    faces: [FACE("Corpus Wild", "Merriweather.ttf"), FACE("Corpus Wild Sans", "RedHatText.ttf")],
    swap: [[/"Bitstream Charter", serif/g, '"Corpus Wild", serif'], [/"Liberation Sans", sans-serif/g, '"Corpus Wild Sans", sans-serif']],
  },
  // A solicitor's receipt: an elegant legal serif, a plain sans for the
  // schedule.
  "will-storage-receipt.html": {
    faces: [FACE("Corpus Deed", "FrankRuhlLibre.ttf"), FACE("Corpus Deed Sans", "AlegreyaSans-Regular.ttf", "400")],
    swap: [[/"Bitstream Charter", serif/g, '"Corpus Deed", serif'], [/"Liberation Sans", sans-serif/g, '"Corpus Deed Sans", sans-serif']],
  },
  // A commercial car park operator: one bold display sans for the brand and
  // the page, a mono for the plate and ticket dates.
  "car-park-season-ticket.html": {
    faces: [FACE("Corpus Park Brand", "BigShouldersText.ttf"), FACE("Corpus Park Mono", "RedHatMono.ttf")],
    swap: [[/"Liberation Sans", sans-serif/g, '"Corpus Park Brand", sans-serif'], [/"Liberation Mono", monospace/g, '"Corpus Park Mono", monospace']],
  },
  // A consumer rental firm: one condensed retail sans throughout.
  "appliance-rental-agreement.html": {
    faces: [FACE("Corpus Rental", "FiraSansCondensed-Regular.ttf", "400"), FACE("Corpus Rental", "FiraSansCondensed-Bold.ttf", "700")],
    swap: [[/"Liberation Sans", sans-serif/g, '"Corpus Rental", sans-serif']],
  },
  // A tradesperson's invoice: a plain functional serif for the body, a
  // condensed sans for labels, a mono for the parts and prices.
  "appliance-repair-invoice.html": {
    faces: [FACE("Corpus Repair", "IBMPlexSerif-Regular.ttf", "400"), FACE("Corpus Repair", "IBMPlexSerif-Bold.ttf", "700"), FACE("Corpus Repair Sans", "CabinCondensed-Regular.ttf", "400"), FACE("Corpus Repair Mono", "ChivoMono.ttf")],
    swap: [[/"Liberation Serif", serif/g, '"Corpus Repair", serif'], [/"Liberation Sans", sans-serif/g, '"Corpus Repair Sans", sans-serif'], [/"Liberation Mono", monospace/g, '"Corpus Repair Mono", monospace']],
  },
  // A traditional members' club letter: a period serif for the wording, a
  // condensed sans for the renewal panel.
  "social-club-subscription-renewal.html": {
    faces: [FACE("Corpus Club", "LibreBodoni.ttf"), FACE("Corpus Club Sans", "BarlowCondensed-Regular.ttf", "400")],
    swap: [[/"Liberation Serif", serif/g, '"Corpus Club", serif'], [/"Liberation Sans", sans-serif/g, '"Corpus Club Sans", sans-serif']],
  },
  // A private clinic's invoice: one bold clinical-brand sans throughout.
  "health-screening-clinic-invoice.html": {
    faces: [FACE("Corpus Clinic Brand", "BigShouldersText.ttf")],
    swap: [[/"Liberation Sans", sans-serif/g, '"Corpus Clinic Brand", sans-serif']],
  },

  // ---- the FOURTH hold-out, 12 further documents (#1007) ----
  //
  // Twenty-three faces, none of them used by `holdout3/`, so the two unseen
  // sets share no character map. Full separation from `sources/` is not
  // possible any more: `fetch-fonts.sh` brings down 108 files, `sources/`
  // and `holdout3/` between them already use all but five, and nothing new
  // is fetched for a hold-out. Three of the five spare faces are used here
  // and the other twenty are faces `sources/` uses exactly once.

  // A broker's welcome pack: a contemporary display serif for the wording,
  // a workhorse grotesque for the summary panels and cover tables.
  "motor-insurance-welcome-pack.html": {
    faces: [FACE("Corpus Larkspur", "Fraunces.ttf"), FACE("Corpus Larkspur Sans", "Karla.ttf")],
    swap: [[/"Liberation Serif", serif/g, '"Corpus Larkspur", serif'], [/"Liberation Sans", sans-serif/g, '"Corpus Larkspur Sans", sans-serif']],
  },
  // A renewal mailing: a high-contrast display caslon over a rounded sans.
  "home-contents-renewal-invitation.html": {
    faces: [FACE("Corpus Nether", "LibreCaslonDisplay-Regular.ttf", "400"), FACE("Corpus Nether Sans", "Mulish.ttf")],
    swap: [[/"Bitstream Charter", serif/g, '"Corpus Nether", serif'], [/"Liberation Sans", sans-serif/g, '"Corpus Nether Sans", sans-serif']],
  },
  // A printed ledger: a screen-first book serif for the wording, a narrow
  // mono for the transaction columns.
  "pet-cover-payment-statement.html": {
    faces: [FACE("Corpus Bramble", "Gelasio.ttf"), FACE("Corpus Bramble Mono", "Inconsolata.ttf")],
    swap: [[/"Liberation Serif", serif/g, '"Corpus Bramble", serif'], [/"Liberation Mono", monospace/g, '"Corpus Bramble Mono", monospace']],
  },
  // Utility bulk print: a neutral grotesque with a code mono for meter
  // numbers, readings and rates.
  "dual-fuel-energy-bill.html": {
    faces: [FACE("Corpus Kestrel", "HankenGrotesk.ttf"), FACE("Corpus Kestrel Mono", "JetBrainsMono.ttf")],
    swap: [[/"Liberation Sans", sans-serif/g, '"Corpus Kestrel", sans-serif'], [/"Liberation Mono", monospace/g, '"Corpus Kestrel Mono", monospace']],
  },
  // A browser print of an account page: one product sans at every size.
  "mobile-plan-account-page.html": {
    faces: [FACE("Corpus Wren", "Sora.ttf")],
    swap: [[/"Liberation Sans", sans-serif/g, '"Corpus Wren", sans-serif']],
  },
  // A printed e-mail: one geometric sans, as the mail client set it.
  "cloud-storage-subscription-email.html": {
    faces: [FACE("Corpus Fenwold", "Rubik.ttf")],
    swap: [[/"Liberation Sans", sans-serif/g, '"Corpus Fenwold", sans-serif']],
  },
  // A workshop job card: a squared trade sans for the printed form, a
  // typewriter mono for the figures typed into it.
  "vehicle-service-record.html": {
    faces: [FACE("Corpus Motorworks", "Saira.ttf"), FACE("Corpus Motorworks Mono", "CutiveMono-Regular.ttf", "400")],
    swap: [[/"Liberation Sans", sans-serif/g, '"Corpus Motorworks", sans-serif'], [/"Liberation Mono", monospace/g, '"Corpus Motorworks Mono", monospace']],
  },
  // A consumer plan schedule: a rounded geometric sans for the tables, an
  // old-style serif for the plan conditions.
  "boiler-cover-plan-schedule.html": {
    faces: [FACE("Corpus Coldbeck", "Quicksand.ttf"), FACE("Corpus Coldbeck Serif", "Vollkorn.ttf")],
    swap: [[/"Liberation Sans", sans-serif/g, '"Corpus Coldbeck", sans-serif'], [/"Liberation Serif", serif/g, '"Corpus Coldbeck Serif", serif']],
  },
  // Municipal recovery print: a condensed display sans for the masthead and
  // the notice panel, a neutral text face for the columns of small print.
  "council-tax-instalment-reminder.html": {
    faces: [FACE("Corpus Ellerby", "Oswald.ttf"), FACE("Corpus Ellerby Text", "Asap.ttf")],
    swap: [[/"Liberation Sans", sans-serif/g, '"Corpus Ellerby", sans-serif'], [/"Liberation Serif", serif/g, '"Corpus Ellerby Text", serif']],
  },
  // Regulated credit print: a newspaper serif for the statutory wording, a
  // plain grotesque for the figures tables.
  "personal-loan-settlement-quotation.html": {
    faces: [FACE("Corpus Ravensgill", "Newsreader.ttf"), FACE("Corpus Ravensgill Sans", "Overpass.ttf")],
    swap: [[/"Liberation Serif", serif/g, '"Corpus Ravensgill", serif'], [/"Liberation Sans", sans-serif/g, '"Corpus Ravensgill Sans", sans-serif']],
  },
  // Legal stationery: an old-style serif for the clauses under the heaviest
  // display sans in the collection for the notice heading.
  "rent-review-notice.html": {
    faces: [FACE("Corpus Quenby", "Cardo-Regular.ttf", "400"), FACE("Corpus Quenby", "Cardo-Bold.ttf", "700"), FACE("Corpus Quenby Display", "ArchivoBlack-Regular.ttf", "400")],
    swap: [[/"Bitstream Charter", serif/g, '"Corpus Quenby", serif'], [/"Liberation Sans", sans-serif/g, '"Corpus Quenby Display", sans-serif']],
  },
  // A till receipt with a leaflet behind it: a condensed bold for the
  // panels, a wide mono for the receipt column.
  "rod-licence-receipt.html": {
    faces: [FACE("Corpus Anglers", "BarlowCondensed-Bold.ttf", "400"), FACE("Corpus Anglers Mono", "OverpassMono.ttf")],
    swap: [[/"Liberation Sans", sans-serif/g, '"Corpus Anglers", sans-serif'], [/"Liberation Mono", monospace/g, '"Corpus Anglers Mono", monospace']],
  },

};

for (const [file, { faces, swap }] of Object.entries(DOCS)) {
  if (only && file !== only) continue;
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
