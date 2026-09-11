// Stage 1 of the three-stage extraction shape (ADR-0026): find every place
// on the page an answer could be, before anything tries to choose one.
//
// The sieve is judged on recall alone. Keeping ten candidates is cheap;
// losing the right one is fatal, because nothing downstream can recover a
// value that was never collected. Precision is the job of the later stages
// -- tagging each candidate with the label beside it, then choosing per
// field -- so nothing here decides anything.
//
// Each candidate keeps `line`, the Tika block it was found in, because the
// block is the short excerpt the later stages read instead of the page.

import { locateDates } from "./suggestions";

export type CandidateKind = "date" | "amount" | "identifier" | "organisation" | "heading";

export interface Candidate {
  kind: CandidateKind;
  /** The value as the scorer compares it: ISO date, minor units, or the
   * literal text with whitespace runs collapsed. */
  value: string;
  /** For `amount` only: the ISO 4217 code the symbol or code implied. */
  currency?: string;
  /** Character offset of the match in the page text. */
  index: number;
  /** The Tika block the candidate sits in, whitespace collapsed. */
  line: string;
}

/** Tika separates layout blocks with blank lines; a block is the natural
 * excerpt, so it is the unit every candidate is attached to. */
export function pageBlocks(text: string): Array<{ index: number; line: string }> {
  const blocks: Array<{ index: number; line: string }> = [];
  const pattern = /[^\n]+/gu;
  for (const match of text.matchAll(pattern)) {
    const line = match[0].replace(/\s+/gu, " ").trim();
    if (line) blocks.push({ index: match.index ?? 0, line });
  }
  return blocks;
}

function blockAt(blocks: Array<{ index: number; line: string }>, index: number): string {
  let found = "";
  for (const block of blocks) {
    if (block.index > index) break;
    found = block.line;
  }
  return found;
}

const CURRENCY_BY_SYMBOL: Record<string, string> = { "£": "GBP", "€": "EUR", "$": "USD" };
// "£1,234.56", "£9.50", "GBP 84.99", "1,234.56" (bare, two decimals) -- the
// bare form is kept because totals in tables often drop the symbol that the
// column header carried.
const AMOUNT = /(?:(£|€|\$)\s?|\b(GBP|EUR|USD)\s?)?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{2}))?\b/gu;

function amounts(text: string, blocks: Array<{ index: number; line: string }>): Candidate[] {
  const found: Candidate[] = [];
  for (const match of text.matchAll(AMOUNT)) {
    const symbol = match[1];
    const code = match[2];
    const pence = match[4];
    // A bare integer is a page number or a year, not money: money needs a
    // symbol, a code, or a decimal part.
    if (!symbol && !code && pence === undefined) continue;
    const whole = match[3].replace(/,/gu, "");
    const minor = Number(whole) * 100 + (pence === undefined ? 0 : Number(pence));
    const index = match.index ?? 0;
    found.push({
      kind: "amount",
      value: String(minor),
      currency: symbol ? CURRENCY_BY_SYMBOL[symbol] : code ?? undefined,
      index,
      line: blockAt(blocks, index),
    });
  }
  return found;
}

// An identifier is a token with at least one digit, drawn from the
// characters references are printed with, long enough not to be a house
// number or a year on its own. Spaced digit groups ("8845 6120 33") are one
// identifier, compared without the spaces.
const IDENTIFIER = /\b(?=[A-Z0-9/-]*\d)[A-Z0-9][A-Z0-9/-]{4,}\b(?:\s\d{2,4}\b)*|\b\d{2,4}(?:\s\d{2,4}){1,4}\b/gu;

function identifiers(text: string, blocks: Array<{ index: number; line: string }>): Candidate[] {
  const found: Candidate[] = [];
  for (const match of text.matchAll(IDENTIFIER)) {
    const index = match.index ?? 0;
    // The printed form is the value -- "7738 2204 91" is the reference as the
    // page and the ground truth write it. Compare with spaces stripped.
    found.push({ kind: "identifier", value: match[0].replace(/\s+/gu, " "), index, line: blockAt(blocks, index) });
  }
  return found;
}

// Words that end an organisation's name, or mark a phrase as one. Recall
// wants this list generous; the later stages pay for the false positives.
const ORGANISATION_TAIL =
  "Ltd|Ltd\\.|Limited|plc|PLC|Plc|LLP|CIC|Council|Authority|Insurance|Assurance|Society|Bank|Group|" +
  "Trust|Services|Association|Club|Water|Energy|Power|Gas|Practice|Administration|Administrators|" +
  "Company|Partners|Partnership|Solutions|Networks|Mobile|Broadband|Telecom|Warranty|Cover|Direct|" +
  "Mutual|Pensions|Dental|Motoring|Installations|Windows|Electrical|Solar|Finance|Financial|" +
  "Building Society|Health|Healthcare|Fitness|Leisure|Licensing|Agency|Office|Department|Foundation";
/** Whether a phrase carries one of the words above -- a company form, a
 * public body, a trade. A name with none of them is a phrase the page set
 * in capitals, which is most of what a letterhead rule finds. */
export function hasOrganisationForm(value: string): boolean {
  return new RegExp(`\\b(?:${ORGANISATION_TAIL})\\b`, "u").test(value);
}

const ORGANISATION_WORD = "(?:[A-Z][A-Za-z'’.-]*|&|of|and|for|the|de)";
const ORGANISATION = new RegExp(
  `\\b((?:${ORGANISATION_WORD}\\s+){0,7}(?:${ORGANISATION_TAIL})(?:\\s+(?:${ORGANISATION_TAIL}))*)(?![A-Za-z])`,
  "gu",
);
// Prose that names the organisation without a company-form word: "by Kestrel
// Broadband", "from Milldown Motoring Club", "with Wexley Water".
const NAMED_IN_PROSE = /\b(?:by|from|with|to|of)\s+((?:[A-Z][A-Za-z'’&.-]*)(?:\s+(?:[A-Z][A-Za-z'’&.-]*|&|of|and))*)/gu;

function organisations(blocks: Array<{ index: number; line: string }>): Candidate[] {
  const found: Candidate[] = [];
  const seen = new Set<string>();
  const push = (index: number, raw: string) => {
    const value = raw.replace(/\s+/gu, " ").trim();
    const key = `${index}:${value.toLowerCase()}`;
    if (value.split(" ").length < 2 || seen.has(key)) return;
    seen.add(key);
    found.push({ kind: "organisation", value, index, line: blockAt(blocks, index) });
  };
  // Names are read block by block, so a title-case line above the
  // letterhead cannot run into it and shift the name's start.
  for (const block of blocks) {
    for (const match of block.line.matchAll(ORGANISATION)) push(block.index + (match.index ?? 0), match[1]);
    for (const match of block.line.matchAll(NAMED_IN_PROSE)) {
      push(block.index + (match.index ?? 0) + match[0].length - match[1].length, match[1]);
    }
  }
  // A letterhead or footer line that is all capitals, or every word
  // capitalised, is the organisation's own name more often than not.
  for (const block of blocks) {
    const words = block.line.split(" ");
    if (words.length < 2 || words.length > 8) continue;
    const titled = words.every((word) => /^(?:[A-Z][A-Za-z'’&.-]*|&|of|and|for|the)$/u.test(word));
    if (titled) push(block.index, block.line);
  }
  return found;
}

// A heading is a short block with no sentence punctuation: the document's
// own title is one, and so is every section header. The subtype ground
// truth is a phrase the page prints, usually inside such a block.
function headings(blocks: Array<{ index: number; line: string }>): Candidate[] {
  const found: Candidate[] = [];
  for (const block of blocks) {
    const { line } = block;
    if (line.length < 3 || line.length > 80) continue;
    if (line.split(" ").length > 10) continue;
    if (/[.;!?]$/u.test(line)) continue;
    found.push({ kind: "heading", value: line, index: block.index, line });
  }
  return found;
}

function dates(text: string, blocks: Array<{ index: number; line: string }>): Candidate[] {
  return locateDates(text).map((entry) => ({
    kind: "date" as const,
    value: entry.value,
    index: entry.index,
    line: blockAt(blocks, entry.index),
  }));
}

/** Every candidate of every kind, in page order. */
export function sieve(text: string): Candidate[] {
  const blocks = pageBlocks(text);
  return [
    ...dates(text, blocks),
    ...amounts(text, blocks),
    ...identifiers(text, blocks),
    ...organisations(blocks),
    ...headings(blocks),
  ].sort((a, b) => a.index - b.index);
}
