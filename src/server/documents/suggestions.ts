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

export function proposalFromText(text: string, filename: string): DocumentProposal {
  const bounded = text.slice(0, MAX_EXTRACTED_CHARACTERS);
  const referenceMatch = bounded.match(
    /(?:policy|account|reference)\s*(?:no\.?|number|#)?\s*[:#]?\s*([A-Z0-9-]{5,80})/iu,
  )?.[1];
  const providerMatch = bounded.match(
    /(?:provider|insurer|supplier)\s*[:\-]\s*([^\r\n]{2,160})/iu,
  )?.[1];
  const dates = [...bounded.matchAll(/\b(20\d{2}-\d{2}-\d{2})\b/gu)]
    .map((match) => validCalendarDate(match[1]))
    .filter((value): value is string => Boolean(value))
    .filter((value, index, values) => values.indexOf(value) === index)
    .slice(0, 12);
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
