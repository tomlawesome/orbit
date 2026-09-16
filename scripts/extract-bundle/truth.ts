// The truth file the owner corrects, and reading it back.
//
// `truth.csv` is their own answers for their own documents: one row a
// document, pre-filled with what the reader made of it, corrected by hand.
// Reading it back turns each row into the same `CorpusExpectation` the
// synthetic corpora declare, so `scoreCorpus` scores these documents exactly
// as it scores those -- same partial credit, same misses, same line.
//
// A blank cell means the page does not support a truth for that field, and
// the scorer simply does not score it. Dates are the one exception the shape
// cannot express: an empty date list is a claim ("no dates on this page")
// and earns a point for finding none, so a page whose dates were never
// checked belongs out of the file rather than in it with a blank.
//
// Everything here is forgiving on the way in, because the file is typed by
// hand in Excel: spaces, pound signs, thousands commas, British dates and
// "annual" all arrive sooner or later.

import { scheduleKinds, type ScheduleKind } from "../../src/lib/domain";
import type { CorpusExpectation } from "../../src/server/documents/extraction-corpus";
import type { ExtractedFields } from "../../src/server/documents/extraction-scoring";
import { documentDateRoles, type DocumentDateRole } from "../../src/server/documents/suggestions";

export const TRUTH_COLUMNS = [
  "file", "provider", "reference", "subtype", "cost", "currency",
  "dates", "dateRoles", "scheduleKind", "recurrenceMonths",
];

export const TRUTH_HELP = [
  "What each column of truth.csv is for.",
  "",
  "The file is your answers for your own documents: what the page really says,",
  "not what the reader guessed. It starts pre-filled with the reader's own",
  "answers, so most of the work is deleting and correcting. Nothing overwrites",
  "it once it exists, and nothing in it leaves this machine.",
  "",
  "A blank cell means the page gives no answer for that field, and the score",
  "passes over it -- which is not the same as the reader being wrong. The words",
  "none, no, n/a, unknown and ? are read as blank too.",
  "",
  "file             The document's file name. Rows whose file is not in the docs",
  "                 folder are ignored, and documents with no row are not scored.",
  "provider         Who the document is from, as the page names them.",
  "reference        The number the page carries for this item -- policy, account,",
  "                 order or contract number.",
  "subtype          What kind of thing the page is about, e.g. \"Broadband",
  "                 contract\". Where more than one word would be right, put them",
  "                 all in, separated by semicolons: any one of them counts.",
  "cost             What the item costs, as a plain number: 34.99. A fixed-term",
  "                 contract costs everything paid over the term. Pound signs,",
  "                 commas and spaces are all fine.",
  "currency         GBP, EUR, USD. Left as it is unless the cost is in something",
  "                 else.",
  "dates            Every date that is about the item, separated by semicolons:",
  "                 2026-03-14;2026-09-01. British dates (14/03/2026) are fine.",
  "                 A blank cell here says the page has no dates at all, so a",
  "                 document whose dates you have not checked is better left out",
  "                 of the file. A date written any other way (\"3rd August\") stops",
  "                 that document being scored rather than losing one date.",
  "dateRoles        What each of those dates is, as date=role pairs separated by",
  "                 semicolons: 2026-03-14=renewal;2026-09-01=service. The roles",
  `                 are ${documentDateRoles.join(", ")}.`,
  `scheduleKind     What Orbit should remind you about: ${scheduleKinds.join(" or ")}, or blank.`,
  "recurrenceMonths How many months until it comes round again, as a number: 12.",
  "                 Monthly, quarterly and annual are understood as well.",
  "",
  "Then run  .\\run.cmd --score  to see how well the reader did.",
];

/** Just enough CSV for a file Excel wrote back: quoted cells, "" for a quote. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let at = 0; at < text.length; at += 1) {
    const character = text[at];
    if (quoted) {
      if (character !== '"') cell += character;
      else if (text[at + 1] === '"') { cell += '"'; at += 1; }
      else quoted = false;
      continue;
    }
    if (character === '"') quoted = true;
    else if (character === ",") { row.push(cell); cell = ""; }
    else if (character === "\n") { row.push(cell); rows.push(row); row = []; cell = ""; }
    else if (character !== "\r") cell += character;
  }
  if (cell !== "" || row.length > 0) { row.push(cell); rows.push(row); }
  return rows;
}

/** Ways of writing "there is nothing here", all read as a blank cell. */
const NOTHING_HERE = new Set(["", "-", "--", "?", "n/a", "na", "none", "no", "unknown"]);

function truthCell(value: string | undefined): string {
  const trimmed = (value ?? "").replace(/\s+/gu, " ").trim();
  return NOTHING_HERE.has(trimmed.toLowerCase()) ? "" : trimmed;
}

const pad = (value: number): string => String(value).padStart(2, "0");

/** A date the owner typed, as ISO. Accepts 2026-03-14, 14/03/2026, 14.3.26. */
function isoDate(value: string): string | undefined {
  const written = value.trim();
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/u.exec(written);
  const british = /^(\d{1,2})[/.\- ](\d{1,2})[/.\- ](\d{2}|\d{4})$/u.exec(written);
  let year: number, month: number, day: number;
  if (iso !== null) [year, month, day] = [Number(iso[1]), Number(iso[2]), Number(iso[3])];
  else if (british !== null) {
    [day, month, year] = [Number(british[1]), Number(british[2]), Number(british[3])];
    if (year < 100) year += 2000;
  } else return undefined;
  const asIso = `${year}-${pad(month)}-${pad(day)}`;
  // A round trip catches 31/02 and the like, which the shapes above do not.
  return new Date(`${asIso}T00:00:00Z`).toISOString().startsWith(asIso) ? asIso : undefined;
}

const CURRENCY_SYMBOLS: Record<string, string> = { "£": "GBP", "€": "EUR", $: "USD" };

/** An amount the owner typed, in minor units: £1,234.56 and 1234.56 alike. */
function minorUnits(value: string): { minor: number; currency?: string } | undefined {
  const digits = value.replace(/[^\d.]/gu, "");
  if (digits === "" || !/^\d+(\.\d*)?$/u.test(digits)) return undefined;
  const code = /\b[A-Z]{3}\b/u.exec(value.toUpperCase())?.[0];
  const symbol = Object.keys(CURRENCY_SYMBOLS).find((mark) => value.includes(mark));
  return { minor: Math.round(Number(digits) * 100), currency: code ?? (symbol && CURRENCY_SYMBOLS[symbol]) };
}

/** How often it comes round, in months: 12, "12 months", "annual". */
const INTERVAL_WORDS: Record<string, number> = {
  monthly: 1, quarterly: 3, "half-yearly": 6, "six-monthly": 6, annual: 12, annually: 12, yearly: 12,
};
function intervalMonths(value: string): number | undefined {
  const word = INTERVAL_WORDS[value.toLowerCase()];
  if (word !== undefined) return word;
  const digits = /\d+/u.exec(value)?.[0];
  return digits === undefined ? undefined : Number(digits);
}

/** One document's truth, and what could not be read while building it. */
interface TruthRow {
  expected: CorpusExpectation;
  problems: string[];
  /** Set where the row cannot be scored at all -- see `dates` below. */
  skip: boolean;
}

function readTruthRow(file: string, cell: (column: string) => string): TruthRow {
  const problems: string[] = [];
  const complain = (column: string, written: string) =>
    problems.push(`${file}: ${column} "${written}" not understood, so it is not scored (see truth-help.txt)`);

  // A date that cannot be read is the one failure the row cannot absorb: an
  // empty date list is itself a claim ("no dates on this page"), so dropping
  // an unreadable one would quietly invent that claim and mark every date
  // found as a false one. The whole row stands down instead.
  const dates: string[] = [];
  let skip = false;
  for (const written of splitList(cell("dates"))) {
    const date = isoDate(written);
    if (date === undefined) {
      problems.push(
        `${file}: date "${written}" not understood, so this document is not scored: write it as 2026-08-03 or 03/08/2026`,
      );
      skip = true;
    } else dates.push(date);
  }

  const dateRoles: Array<{ date: string; role: DocumentDateRole }> = [];
  for (const written of splitList(cell("dateRoles"))) {
    const [left, right] = written.split(/[=:]/u);
    const date = isoDate(left ?? "");
    const role = (right ?? "").trim().toLowerCase();
    if (date === undefined || !(documentDateRoles as readonly string[]).includes(role)) complain("dateRoles", written);
    else dateRoles.push({ date, role: role as DocumentDateRole });
  }

  const expected: CorpusExpectation = { dates };
  if (dateRoles.length > 0) expected.dateRoles = dateRoles;
  if (cell("provider") !== "") expected.provider = cell("provider");
  if (cell("reference") !== "") expected.reference = cell("reference");
  // A page can genuinely be more than one right word, so the cell takes as
  // many as the owner will accept, separated by ; or | (#989/#992).
  const subtypes = cell("subtype").split(/[;|]/u).map((part) => part.trim()).filter((part) => part !== "");
  if (subtypes.length === 1) expected.subtype = subtypes[0];
  else if (subtypes.length > 1) expected.subtype = subtypes;

  const cost = cell("cost");
  if (cost !== "") {
    const amount = minorUnits(cost);
    const currency = cell("currency").toUpperCase() || amount?.currency;
    if (amount === undefined) complain("cost", cost);
    else if (currency === undefined) {
      problems.push(`${file}: cost "${cost}" has no currency, so it is not scored: put GBP in the currency column`);
    } else {
      expected.costMinor = amount.minor;
      expected.currency = currency;
    }
  }

  const schedule = cell("scheduleKind").toLowerCase();
  if (schedule !== "") {
    if (!(scheduleKinds as readonly string[]).includes(schedule)) complain("scheduleKind", schedule);
    else expected.scheduleKind = schedule as ScheduleKind;
  }

  const recurrence = cell("recurrenceMonths");
  if (recurrence !== "") {
    const months = intervalMonths(recurrence);
    if (months === undefined) complain("recurrenceMonths", recurrence);
    else expected.recurrenceMonths = months;
  }

  return { expected, problems, skip };
}

/** Semicolon-separated, but a comma-separated list is read the same way. */
function splitList(value: string): string[] {
  return value.split(/[;,]/u).map((part) => part.trim()).filter((part) => part !== "");
}

/** What the reader made of one document, as the truth file starts it off. */
export interface ReadDocument {
  file: string;
  fields?: ExtractedFields;
}

/** The truth row for each document, pre-filled with what the reader read. */
export function truthCsv(rows: readonly ReadDocument[]): string {
  const quote = (value: string) => `"${value.replaceAll('"', '""')}"`;
  const line = (row: ReadDocument): string => {
    const f = row.fields;
    return [
      row.file,
      f?.provider ?? "",
      f?.reference ?? "",
      f?.subtype ?? "",
      f?.costMinor === undefined ? "" : (f.costMinor / 100).toFixed(2),
      f?.currency ?? "",
      (f?.dates ?? []).join(";"),
      (f?.dateRoles ?? []).map((entry) => `${entry.date}=${entry.role}`).join(";"),
      f?.scheduleKind ?? "",
      f?.recurrenceMonths === undefined ? "" : String(f.recurrenceMonths),
    ].map(quote).join(",");
  };
  return [TRUTH_COLUMNS.map(quote).join(","), ...rows.map(line)].join("\r\n") + "\r\n";
}

/** One document's truth as the file gives it. */
export interface TruthEntry {
  file: string;
  expected: CorpusExpectation;
  /** False where a date could not be read: see `readTruthRow`. */
  scorable: boolean;
}

export interface TruthFile {
  entries: TruthEntry[];
  /** Everything that could not be read, in words to print as they are. */
  problems: string[];
}

/** The whole file, row by row, as far as each row can be understood. */
export function readTruthFile(text: string): TruthFile {
  const table = parseCsv(text);
  const header = (table[0] ?? []).map((name) => truthCell(name).toLowerCase());
  const fileAt = header.indexOf("file");
  if (fileAt === -1) throw new Error('the truth file has no "file" column: delete it and run again for a fresh one');

  const entries: TruthEntry[] = [];
  const problems: string[] = [];
  for (const line of table.slice(1)) {
    const file = truthCell(line[fileAt]);
    if (file === "") continue;
    const row = readTruthRow(file, (name) => truthCell(line[header.indexOf(name.toLowerCase())]));
    problems.push(...row.problems);
    entries.push({ file, expected: row.expected, scorable: !row.skip });
  }
  return { entries, problems };
}
