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

// Documents write dates the way people do, not the way machines do. Numeric
// dates are read day-first, matching the product's UK deployment reality.
function extractDates(bounded: string): string[] {
  const found: Array<{ index: number; value: string }> = [];
  const push = (index: number, value: string | undefined) => {
    if (value) found.push({ index, value });
  };
  for (const match of bounded.matchAll(/\b(20\d{2}-\d{2}-\d{2})\b/gu)) {
    push(match.index ?? 0, validCalendarDate(match[1]));
  }
  for (const match of bounded.matchAll(/\b(\d{1,2})[/.](\d{1,2})[/.](20\d{2})\b/gu)) {
    push(match.index ?? 0, isoFromParts(match[3], Number(match[2]), match[1]));
  }
  const dayFirst = new RegExp(
    `\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(${MONTH_PATTERN})\\.?\\s+(20\\d{2})\\b`,
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

export function proposalFromText(text: string, filename: string): DocumentProposal {
  const bounded = text.slice(0, MAX_EXTRACTED_CHARACTERS);
  const referenceMatch = bounded.match(
    /(?:policy|account|reference)\s*(?:no\.?|number|#)?\s*[:#]?\s*([A-Z0-9-]{5,80})/iu,
  )?.[1];
  const providerMatch = bounded.match(
    /(?:provider|insurer|supplier)\s*[:\-]\s*([^\r\n]{2,160})/iu,
  )?.[1];
  const dates = extractDates(bounded);
  return {
    title: safeDocumentFilenameTitle(filename),
    provider: safeDocumentPlainText(providerMatch, 100),
    reference: safeDocumentPlainText(referenceMatch, 80),
    dates,
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
