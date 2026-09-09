import { basename } from "node:path";

const MAX_EXTRACTED_CHARACTERS = 250_000;
const unsafeFormatting = /[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/gu;

export interface DocumentProposal {
  title: string;
  provider?: string;
  reference?: string;
  dates: string[];
}

export function safeDocumentPlainText(value: unknown, maximum: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value
    .normalize("NFKC")
    .replace(unsafeFormatting, " ")
    .replace(/\s+/gu, " ")
    .trim();
  if (!normalized || normalized.length > maximum || /[<>]/u.test(normalized)) return undefined;
  return normalized;
}

export function safeDocumentEvidence(text: unknown, maximum = 2_000): string {
  if (typeof text !== "string") return "";
  return text
    .slice(0, MAX_EXTRACTED_CHARACTERS)
    .normalize("NFKC")
    .replace(unsafeFormatting, " ")
    .replace(/[<>]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, maximum);
}

export function safeDocumentFilenameTitle(filename: string): string {
  const leaf = basename(filename.replaceAll("\\", "/")).replace(/\.[^.]+$/u, "");
  return safeDocumentPlainText(leaf, 100) ?? "Document";
}

function validCalendarDate(value: unknown): string | undefined {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) return undefined;
  const date = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return undefined;
  return date.toISOString().slice(0, 10) === value ? value : undefined;
}

const MONTH_NAMES: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
};
const MONTH_PATTERN =
  "jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun[e]?|jul[y]?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?";

function isoFromParts(year: string, month: number, day: string): string | undefined {
  const padded = `${year}-${String(month).padStart(2, "0")}-${day.padStart(2, "0")}`;
  return validCalendarDate(padded);
}

// A two-digit year on a household document is this century: 06/05/24 is 2024.
function fullYear(year: string): string {
  return year.length === 2 ? `20${year}` : year;
}

// The text before a match on its own line, so local context can be read
// without rescanning the document.
function linePrefix(text: string, index: number): string {
  const window = text.slice(Math.max(0, index - 120), index);
  const lines = window.split(/[\r\n]/u);
  return lines[lines.length - 1] ?? "";
}

// Firmware and software versions are written exactly like dotted dates
// ("2.4.2026"), so a dotted candidate is dropped when its line announces a
// version, or when it is one link of a longer dotted chain such as 1.2.3.4.
const VERSION_CONTEXT = /\b(?:firmware|version|build|release|revision|software|driver|patch|app)\b/iu;

function looksLikeVersion(text: string, start: number, end: number): boolean {
  if (VERSION_CONTEXT.test(linePrefix(text, start))) return true;
  return /^\.\d/u.test(text.slice(end, end + 2)) ||
    /\d\.$/u.test(text.slice(Math.max(0, start - 2), start));
}

const ISO_DATE = /\b(20\d{2}-\d{2}-\d{2})\b/gu;
// Numeric dates are one parser: the same separator throughout ("/", "." or
// "-"), day-first when the year comes last, year-first when it leads.
const DAY_FIRST_NUMERIC = /\b(\d{1,2})([/.-])(\d{1,2})\2(20\d{2}|\d{2})(?!\d)/gu;
const YEAR_FIRST_NUMERIC = /\b(20\d{2})([/.-])(\d{1,2})\2(\d{1,2})(?!\d)/gu;

// Documents write dates the way people do, not the way machines do. Numeric
// dates are read day-first, matching the product's UK deployment reality; a
// date whose parts cannot be told apart is dropped rather than guessed.
function extractDates(bounded: string): string[] {
  const found: Array<{ index: number; value: string }> = [];
  const push = (index: number, value: string | undefined) => {
    if (value) found.push({ index, value });
  };
  for (const match of bounded.matchAll(ISO_DATE)) {
    push(match.index ?? 0, validCalendarDate(match[1]));
  }
  for (const match of bounded.matchAll(DAY_FIRST_NUMERIC)) {
    const index = match.index ?? 0;
    if (match[2] === "." && looksLikeVersion(bounded, index, index + match[0].length)) continue;
    push(index, isoFromParts(fullYear(match[4]), Number(match[3]), match[1]));
  }
  for (const match of bounded.matchAll(YEAR_FIRST_NUMERIC)) {
    const index = match.index ?? 0;
    if (match[2] === "." && looksLikeVersion(bounded, index, index + match[0].length)) continue;
    push(index, isoFromParts(match[1], Number(match[3]), match[4]));
  }
  // "the 1st of October 2026" is one date, so the optional "of" belongs to the
  // written-date patterns.
  const dayFirst = new RegExp(
    `\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?(${MONTH_PATTERN})\\.?\\s+(20\\d{2})\\b`,
    "giu",
  );
  for (const match of bounded.matchAll(dayFirst)) {
    const month = MONTH_NAMES[match[2].slice(0, 4).toLowerCase()] ??
      MONTH_NAMES[match[2].slice(0, 3).toLowerCase()];
    push(match.index ?? 0, month ? isoFromParts(match[3], month, match[1]) : undefined);
  }
  const monthFirst = new RegExp(
    `\\b(${MONTH_PATTERN})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(20\\d{2})\\b`,
    "giu",
  );
  for (const match of bounded.matchAll(monthFirst)) {
    const month = MONTH_NAMES[match[1].slice(0, 4).toLowerCase()] ??
      MONTH_NAMES[match[1].slice(0, 3).toLowerCase()];
    push(match.index ?? 0, month ? isoFromParts(match[3], month, match[2]) : undefined);
  }
  return found
    .sort((a, b) => a.index - b.index)
    .map((entry) => entry.value)
    .filter((value, index, values) => values.indexOf(value) === index)
    .slice(0, 12);
}

const REFERENCE_LABEL =
  /\b(?:policy|plan|account|invoice|licence|license|customer|membership|reference)\b\s*(?:number|no\.?|reference|ref\.?|#)?\s*[:#]?\s*/giu;
// References run across spaces ("8802 5514 9", "NSM 44/22910"), so the value is
// read token by token rather than stopping at the first space. Only a
// reference-shaped token continues the run, which keeps ordinary prose
// ("HS-77120 when you call") out of it.
const REFERENCE_TOKEN = /^[A-Z0-9][A-Z0-9/-]*$/u;
// The opening token may be lower case, as it always could, provided it carries
// a digit — that is what stops a label word being read as its own reference.
const REFERENCE_HEAD = /^[A-Za-z-]*\d[A-Za-z0-9/-]*$/u;
const MAX_REFERENCE_TOKENS = 6;

function referenceFromLine(rest: string): string | undefined {
  const line = rest.split(/[\r\n]/u)[0] ?? "";
  const tokens: string[] = [];
  for (const raw of line.trim().split(/ +/u)) {
    if (tokens.length >= MAX_REFERENCE_TOKENS) break;
    const token = raw.replace(/[.,;:]+$/u, "");
    if (!token) break;
    const accepted = tokens.length === 0
      ? REFERENCE_TOKEN.test(token) || REFERENCE_HEAD.test(token)
      : REFERENCE_TOKEN.test(token);
    if (!accepted) break;
    tokens.push(token);
    // Punctuation ends the reference, it never runs through it.
    if (token !== raw) break;
  }
  while (tokens.length > 0 && !/\d/u.test(tokens[tokens.length - 1])) tokens.pop();
  const reference = tokens.join(" ");
  return reference.length >= 5 && reference.length <= 80 ? reference : undefined;
}

function extractReference(bounded: string): string | undefined {
  for (const label of bounded.matchAll(REFERENCE_LABEL)) {
    const end = (label.index ?? 0) + label[0].length;
    const reference = referenceFromLine(bounded.slice(end, end + 120));
    if (reference) return reference;
  }
  return undefined;
}

const PROVIDER_LABEL = /(?:provider|insurer|supplier)\s*[:\-]\s*([^\r\n]{2,160})/iu;
// A provider is often named in prose instead of after a label: "Sent 12 August
// 2026 by Hartswood Garage Services, Westhaven".
const PROVIDER_IN_PROSE = /\bby\s+([A-Z][A-Za-z&'.-]*(?:\s+[A-Z][A-Za-z&'.-]*){1,4})/u;
// A letterhead names the sender only when it names a kind of organisation and
// is not itself the document's title: "BOROUGH OF WESTHAVEN" counts, "COUNCIL
// TAX DEMAND NOTICE" does not.
const ORGANISATION_WORD =
  /\b(?:borough|council|authority|ltd|limited|plc|llp|mutual|society|association|company|bank|trust|cooperative|co-operative)\b/iu;
const DOCUMENT_WORD =
  /\b(?:statement|certificate|invoice|demand|notice|bill|schedule|agreement|reminder|receipt|card|guide|summary|renewal|invitation|licence|license|policy|plan)\b/iu;
const MINOR_WORDS = new Set(["of", "the", "and", "for", "at", "in", "on", "upon"]);

// An all-capitals letterhead is shouting; it is read back as a name.
function titleCased(line: string): string {
  if (line !== line.toUpperCase()) return line;
  return line
    .toLowerCase()
    .split(" ")
    .map((word, index) =>
      index > 0 && MINOR_WORDS.has(word) ? word : word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

function providerFromLetterhead(bounded: string): string | undefined {
  const first = bounded.split(/[\r\n]/u).map((line) => line.trim()).find((line) => line.length > 0);
  if (!first) return undefined;
  const head = (first.split(/\s[—–-]\s/u)[0] ?? "").trim();
  const words = head.split(/\s+/u).filter((word) => word.length > 0);
  if (words.length < 2 || words.length > 6 || head.length > 60) return undefined;
  if (/\d/u.test(head) || !ORGANISATION_WORD.test(head) || DOCUMENT_WORD.test(head)) return undefined;
  return titleCased(head);
}

// A trailing aside names the administrator, not the provider: "Kestrel Mutual
// (administered by Faircross Broking Ltd)".
function withoutAside(value: string): string {
  return value.split("(")[0].trim().replace(/[,;.]+$/u, "");
}

function extractProvider(bounded: string): string | undefined {
  const labelled = bounded.match(PROVIDER_LABEL)?.[1];
  const candidates = labelled === undefined
    ? [withoutAside(bounded.match(PROVIDER_IN_PROSE)?.[1] ?? ""), providerFromLetterhead(bounded)]
    : [withoutAside(labelled)];
  for (const candidate of candidates) {
    const provider = safeDocumentPlainText(candidate, 100);
    if (provider) return provider;
  }
  return undefined;
}

export function proposalFromText(text: string, filename: string): DocumentProposal {
  const bounded = text.slice(0, MAX_EXTRACTED_CHARACTERS);
  return {
    title: safeDocumentFilenameTitle(filename),
    provider: extractProvider(bounded),
    reference: safeDocumentPlainText(extractReference(bounded), 80),
    dates: extractDates(bounded),
  };
}

export function safeStoredDocumentProposal(value: unknown, filename: string): DocumentProposal {
  const candidate = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const dates = Array.isArray(candidate.dates)
    ? candidate.dates
      .map(validCalendarDate)
      .filter((date): date is string => Boolean(date))
      .filter((date, index, values) => values.indexOf(date) === index)
      .slice(0, 12)
    : [];
  return {
    title: safeDocumentPlainText(candidate.title, 100) ?? safeDocumentFilenameTitle(filename),
    provider: safeDocumentPlainText(candidate.provider, 100),
    reference: safeDocumentPlainText(candidate.reference, 80),
    dates,
  };
}
