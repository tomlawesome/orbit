import { basename } from "node:path";
import type { ScheduleKind } from "@/lib/domain";

const MAX_EXTRACTED_CHARACTERS = 250_000;
const unsafeFormatting = /[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/gu;
const MAX_DATES = 12;

/**
 * The closed vocabulary of date roles (ADR-0025 section 3). A model labels
 * every date it reports with one of these, and the application maps the
 * roles onto the item's date slots. A role string outside the list is
 * DROPPED with its date rather than coerced to `other`: "I do not recognise
 * this label" is not the same statement as "this date is uninteresting",
 * and silently turning one into the other invents a fact.
 */
export const documentDateRoles = [
  "renewal",
  "expiry",
  "due",
  "service",
  "issued",
  "start",
  "other",
] as const;
export type DocumentDateRole = (typeof documentDateRoles)[number];

export interface DocumentDateRoleLabel {
  date: string;
  role: DocumentDateRole;
}

/**
 * Only a renewal or a service date is a scheduled event in Orbit's model
 * (`scheduleKinds`, src/lib/domain.ts). Every other role labels a date the
 * reviewer may still want, but produces no schedule kind.
 */
const SCHEDULE_KIND_BY_ROLE: Partial<Record<DocumentDateRole, ScheduleKind>> = {
  renewal: "renewal",
  service: "service",
};

/**
 * ADR-0025 section 3: the four model-owned fields are validated to the
 * bounds `src/lib/workspace.ts` already enforces on an item, so a proposal
 * can never offer a reviewer a value the item schema would then refuse.
 */
export const MAX_SUBTYPE_CHARACTERS = 80;
export const MAX_COST_MINOR = 100_000_000;
export const MIN_RECURRENCE_MONTHS = 1;
export const MAX_RECURRENCE_MONTHS = 120;

/**
 * What one document proposes, whatever produced it: the heuristics, a
 * stored draft, or the model path. The first four fields are the ones the
 * heuristics attempt. The rest are the model path's (ADR-0025 section 7,
 * owner decision on #319): the heuristics never try them, so where the
 * model is absent those slots are simply empty.
 *
 * `scheduleKind` and `scheduleDate` are DERIVED, never accepted from
 * input — see `safeStoredDocumentProposal`.
 */
export interface DocumentProposal {
  title: string;
  provider?: string;
  reference?: string;
  dates: string[];
  subtype?: string;
  /** In minor units, and only ever present together with `currency`. */
  costMinor?: number;
  currency?: string;
  recurrenceMonths?: number;
  scheduleKind?: ScheduleKind;
  scheduleDate?: string;
  /**
   * Absent, not empty, when nothing labelled a date (#967). Roles are
   * model-only like the four fields above, so they follow the same rule:
   * a slot no extractor filled is a key the proposal does not carry.
   * An empty array would put a key into stored evidence that no reviewer
   * ever saw, and it states nothing the missing key does not —
   * `safeStoredDocumentProposal` reads an absent `dateRoles` back as no
   * roles, so the two are indistinguishable everywhere downstream.
   */
  dateRoles?: DocumentDateRoleLabel[];
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
    const leading = Number(match[1]);
    const following = Number(match[3]);
    // Day-first is the house reading, and stays the reading whenever both
    // numbers could be a month: 06/05/24 is 6 May. Only when the second
    // number cannot be a month and the first can — 03/15/2026 — is the date
    // unambiguously month-first, so the swap never guesses.
    const monthLeads = following > 12 && leading <= 12;
    push(
      index,
      monthLeads
        ? isoFromParts(fullYear(match[4]), leading, match[3])
        : isoFromParts(fullYear(match[4]), following, match[1]),
    );
  }
  for (const match of bounded.matchAll(YEAR_FIRST_NUMERIC)) {
    const index = match.index ?? 0;
    if (match[2] === "." && looksLikeVersion(bounded, index, index + match[0].length)) continue;
    push(index, isoFromParts(match[1], Number(match[3]), match[4]));
  }
  // "the 1st of October 2026" is one date, so the optional "of" belongs to the
  // written-date patterns.
  // A written date may abbreviate its year the way a numeric one does, so a
  // plan year reads as "01 Jul 26 - 30 Jun 27". The month name must end at a
  // word boundary, or a two-digit year would let ordinary prose through.
  const dayFirst = new RegExp(
    `\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?(${MONTH_PATTERN})\\b\\.?\\s+(20\\d{2}|\\d{2})(?!\\d)`,
    "giu",
  );
  for (const match of bounded.matchAll(dayFirst)) {
    const month = MONTH_NAMES[match[2].slice(0, 4).toLowerCase()] ??
      MONTH_NAMES[match[2].slice(0, 3).toLowerCase()];
    push(match.index ?? 0, month ? isoFromParts(fullYear(match[3]), month, match[1]) : undefined);
  }
  const monthFirst = new RegExp(
    `\\b(${MONTH_PATTERN})\\b\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(20\\d{2})\\b`,
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

// How a label says "the value after me is the identifier".
const REFERENCE_QUALIFIER = "(?:number|no\\.?|reference|ref\\.?|#)";
// Some documents put the reference beside a rival identifier: an MOT test
// number beside a registration mark and an odometer, a certificate number
// beside a serial. Those words name the identifier ONLY when the label spells
// it out — "Test number", "Certificate no.", "Registration ref" — so the
// heading "MOT TEST CERTIFICATE" and the field "Registration mark" are not
// labels at all, and cannot hand back the token that happens to follow them.
const REFERENCE_LABEL = new RegExp(
  "(?:" +
    "\\b(?:policy|plan|account|invoice|licence|license|customer|membership|reference)\\b" +
    `\\s*${REFERENCE_QUALIFIER}?` +
    "|" +
    `\\b(?:certificate|test|registration)\\b\\s*${REFERENCE_QUALIFIER}` +
  ")\\s*[:#]?\\s*",
  "giu",
);
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
// "If you pay by Direct Debit we will collect..." names a way of paying, not
// the company being paid. A confidently wrong provider is worse than none, so
// these are refused outright rather than ranked below something better.
const PAYMENT_METHOD =
  /^(?:direct debit|standing order|bank transfer|credit card|debit card|card payment|cheque|cash)$/iu;
// A title describes the paper; a letterhead names who sent it. "COUNCIL TAX
// DEMAND NOTICE" and "QUICK START CARD" are titles.
const DOCUMENT_WORD =
  /\b(?:statement|certificate|invoice|demand|notice|bill|schedule|agreement|reminder|receipt|card|guide|summary|renewal|invitation|licence|license|policy|plan)\b/iu;
// A letter opens by addressing its reader. "Dear Mr Lawson," names the
// recipient, so it is never the sender's letterhead.
const ADDRESSED_TO_A_PERSON = /^(?:dear|hello|hi)\b|\b(?:mr|mrs|ms|miss|dr)\b/iu;
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

// A name is written as a name: every word capitalised or shouted, with
// ampersands and small joining words allowed between them. "Received with
// thanks" is a sentence about the document, so it is not one.
function looksLikeName(words: string[]): boolean {
  return words.every((word, index) => {
    if (/^[&+/-]+$/u.test(word)) return true;
    if (index > 0 && MINOR_WORDS.has(word.toLowerCase())) return true;
    const initial = word.charAt(0);
    return initial === initial.toUpperCase() && initial !== initial.toLowerCase();
  });
}

// The sender's name at the top of the page. Most household documents put it
// there and nowhere else, so it is read before prose is guessed at: a
// letterhead is the sender by position, while "by" in a sentence can introduce
// a payment method, an administrator or a date. The whole first line is tested
// for a document word, so "SMART THERMOSTAT - QUICK START CARD" is refused as
// a title even though its opening words read like a name.
function providerFromLetterhead(bounded: string): string | undefined {
  const first = bounded.split(/[\r\n]/u).map((line) => line.trim()).find((line) => line.length > 0);
  if (!first || DOCUMENT_WORD.test(first) || ADDRESSED_TO_A_PERSON.test(first)) return undefined;
  const head = (first.split(/\s[—–-]\s/u)[0] ?? "").trim().replace(/[,;.]+$/u, "");
  const words = head.split(/\s+/u).filter((word) => word.length > 0);
  if (words.length < 2 || words.length > 6 || head.length > 60) return undefined;
  if (/\d/u.test(head) || !looksLikeName(words)) return undefined;
  return titleCased(head);
}

// A trailing aside names the administrator, not the provider: "Kestrel Mutual
// (administered by Faircross Broking Ltd)".
function withoutAside(value: string): string {
  return value.split("(")[0].trim().replace(/[,;.]+$/u, "");
}

// A name never runs on past the end of a sentence: "Issued by Vanterra
// Appliances. Warranty service is carried out by..." names Vanterra
// Appliances. An initial is not a sentence end, so only a word of real length
// closes one — "J. Marsh & Son" stays whole.
function untilSentenceEnd(value: string): string {
  const kept: string[] = [];
  for (const word of value.split(" ")) {
    const bare = word.replace(/\.$/u, "");
    const sentenceEnd = bare !== word && bare.replace(/[^A-Za-z]/gu, "").length > 2;
    kept.push(sentenceEnd ? bare : word);
    if (sentenceEnd) break;
  }
  return kept.join(" ");
}

function providerFromProse(bounded: string): string | undefined {
  const named = withoutAside(untilSentenceEnd(bounded.match(PROVIDER_IN_PROSE)?.[1] ?? ""));
  return PAYMENT_METHOD.test(named) ? undefined : named;
}

function extractProvider(bounded: string): string | undefined {
  const labelled = bounded.match(PROVIDER_LABEL)?.[1];
  const candidates = labelled === undefined
    ? [providerFromLetterhead(bounded), providerFromProse(bounded)]
    : [withoutAside(labelled)];
  for (const candidate of candidates) {
    const provider = safeDocumentPlainText(candidate, 100);
    if (provider) return provider;
  }
  return undefined;
}

/**
 * The heuristics, unchanged: they attempt title, provider, reference and
 * dates and nothing else. The four model-owned fields and the date roles
 * stay ABSENT here by decision, not by omission (#319, owner 2026-08-13):
 * the heuristics never attempt them, so there is no finding to record.
 */
export function proposalFromText(text: string, filename: string): DocumentProposal {
  const bounded = text.slice(0, MAX_EXTRACTED_CHARACTERS);
  return {
    title: safeDocumentFilenameTitle(filename),
    provider: extractProvider(bounded),
    reference: safeDocumentPlainText(extractReference(bounded), 80),
    dates: extractDates(bounded),
  };
}

const CURRENCY_CODE = /^[A-Z]{3}$/u;

function boundedInteger(value: unknown, minimum: number, maximum: number): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= minimum && value <= maximum
    ? value
    : undefined;
}

function knownDateRole(value: unknown): DocumentDateRole | undefined {
  return typeof value === "string" && (documentDateRoles as readonly string[]).includes(value)
    ? value as DocumentDateRole
    : undefined;
}

/**
 * A role survives only when its date did: roles are labels ON the proposed
 * dates, so a role for a date that failed calendar validation, or for one
 * the proposal does not carry at all, has nothing to label. One role per
 * date, the first label winning, in the order they were proposed.
 */
function safeDateRoles(value: unknown, dates: string[]): DocumentDateRoleLabel[] {
  if (!Array.isArray(value)) return [];
  const labels: DocumentDateRoleLabel[] = [];
  for (const entry of value.slice(0, MAX_DATES)) {
    const record = entry && typeof entry === "object" ? entry as Record<string, unknown> : undefined;
    if (!record) continue;
    const date = validCalendarDate(record.date);
    const role = knownDateRole(record.role);
    if (!date || !role || !dates.includes(date)) continue;
    if (labels.some((label) => label.date === date)) continue;
    labels.push({ date, role });
  }
  return labels;
}

/**
 * A cost is an amount AND the currency its evidence carried (ADR-0025
 * section 3). The model never guesses a currency, so neither half is kept
 * without the other: an amount with no currency is a number nobody can
 * spend, and a currency with no amount says nothing at all.
 */
function safeCost(candidate: Record<string, unknown>): { costMinor: number; currency: string } | undefined {
  const costMinor = boundedInteger(candidate.costMinor, 0, MAX_COST_MINOR);
  const currency = typeof candidate.currency === "string" && CURRENCY_CODE.test(candidate.currency.trim())
    ? candidate.currency.trim()
    : undefined;
  return costMinor !== undefined && currency !== undefined ? { costMinor, currency } : undefined;
}

/**
 * The storage boundary every proposal passes, whatever produced it. It
 * rebuilds a fresh object from an allowlist — so no key an extractor
 * invented survives — and re-applies every bound `src/lib/workspace.ts`
 * enforces on the item the reviewer will eventually save.
 */
export function safeStoredDocumentProposal(value: unknown, filename: string): DocumentProposal {
  const candidate = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const dates = Array.isArray(candidate.dates)
    ? candidate.dates
      .map(validCalendarDate)
      .filter((date): date is string => Boolean(date))
      .filter((date, index, values) => values.indexOf(date) === index)
      .slice(0, MAX_DATES)
    : [];
  const dateRoles = safeDateRoles(candidate.dateRoles, dates);
  // Derived, never emitted and never read back from the input: the schedule
  // kind follows the first date whose role is a scheduled event, exactly as
  // `src/lib/workspace.ts` reads an item — a schedule kind exists precisely
  // when a scheduled date does. A `scheduleKind` in the input is ignored.
  const scheduled = dateRoles.find((label) => SCHEDULE_KIND_BY_ROLE[label.role]);
  const scheduleKind = scheduled ? SCHEDULE_KIND_BY_ROLE[scheduled.role] : undefined;
  const cost = safeCost(candidate);
  return {
    title: safeDocumentPlainText(candidate.title, 100) ?? safeDocumentFilenameTitle(filename),
    provider: safeDocumentPlainText(candidate.provider, 100),
    reference: safeDocumentPlainText(candidate.reference, 80),
    dates,
    subtype: safeDocumentPlainText(candidate.subtype, MAX_SUBTYPE_CHARACTERS),
    costMinor: cost?.costMinor,
    currency: cost?.currency,
    // `workspaceItemSchema` refuses a recurrence without a schedule kind, so
    // a recurrence with no scheduled date to repeat is dropped here too.
    recurrenceMonths: scheduleKind
      ? boundedInteger(candidate.recurrenceMonths, MIN_RECURRENCE_MONTHS, MAX_RECURRENCE_MONTHS)
      : undefined,
    scheduleKind,
    scheduleDate: scheduled?.date,
    // Only when a role survived. `undefined` here is dropped by JSON
    // serialisation exactly as the optional fields above are, so no key a
    // reviewer never saw reaches the stored proposal (#967).
    dateRoles: dateRoles.length > 0 ? dateRoles : undefined,
  };
}
