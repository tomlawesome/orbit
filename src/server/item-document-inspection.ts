import { randomUUID } from "node:crypto";
import { AppError } from "@/lib/app-error";
import { getDocumentConfig } from "@/server/documents/config";
import { scanFileWithClamAv } from "@/server/documents/scanner";
import { LocalDocumentStorage } from "@/server/documents/storage";
import { detectDocumentMediaType } from "@/server/documents/validation";
import { extractTextWithTika } from "@/server/documents/tika";
import { proposalFromText } from "@/server/document-drafts";
import { requireHouseholdAccess } from "@/server/workspace-access";

const MAX_EXTRACTED_CHARACTERS = 250_000;
const parserRecoveryMessage = "Suggestions are unavailable right now. Review the fields manually; the document can still be attached.";

export const itemDocumentSuggestionFields = [
  "title",
  "subtype",
  "provider",
  "reference",
  "cost",
  "dueDate",
  "scheduleKind",
  "recurrenceMonths",
] as const;

export type ItemDocumentSuggestionField = typeof itemDocumentSuggestionFields[number];
export type ItemDocumentSuggestionSource = "filename" | "document_text";
export type ItemDocumentSuggestionConfidence = "high" | "medium" | "low";

export interface ItemDocumentSuggestion {
  field: ItemDocumentSuggestionField;
  value: string;
  source: ItemDocumentSuggestionSource;
  confidence: ItemDocumentSuggestionConfidence;
}

export interface ItemDocumentInspectionResult {
  extracted: boolean;
  suggestions: ItemDocumentSuggestion[];
  message?: string;
}

const allowedSuggestionFields = new Set<ItemDocumentSuggestionField>(itemDocumentSuggestionFields);

function boundedPlainText(value: unknown, maximum: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value
    .normalize("NFKC")
    .replace(/[\u0000-\u001f\u007f\u2028\u2029]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized || normalized.length > maximum || /[<>]/u.test(normalized)) return undefined;
  return normalized;
}

function validCalendarDate(value: unknown): string | undefined {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) return undefined;
  const date = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return undefined;
  return date.toISOString().slice(0, 10) === value ? value : undefined;
}

function filenameTitle(filename: string): string | undefined {
  const leaf = filename.replaceAll("\\", "/").split("/").pop() ?? filename;
  return boundedPlainText(leaf.replace(/\.[^.]+$/u, ""), 100);
}

function buildSuggestions(filename: string, proposal: unknown): ItemDocumentSuggestion[] {
  const suggestions: ItemDocumentSuggestion[] = [];
  const add = (
    field: ItemDocumentSuggestionField,
    value: string | undefined,
    source: ItemDocumentSuggestionSource,
    confidence: ItemDocumentSuggestionConfidence,
  ) => {
    if (!allowedSuggestionFields.has(field) || !value || suggestions.some((suggestion) => suggestion.field === field)) return;
    suggestions.push({ field, value, source, confidence });
  };

  const candidate = proposal && typeof proposal === "object" ? proposal as Record<string, unknown> : {};
  add("title", filenameTitle(filename), "filename", "high");
  add("provider", boundedPlainText(candidate.provider, 100), "document_text", "medium");
  add("reference", boundedPlainText(candidate.reference, 80), "document_text", "medium");
  const dates = Array.isArray(candidate.dates) ? candidate.dates : [];
  add("dueDate", validCalendarDate(dates.find((date) => validCalendarDate(date))), "document_text", "medium");
  return suggestions;
}

/**
 * Scans and extracts a temporary upload for the Add item form. Nothing is
 * retained here: the browser uploads the chosen file again only after the
 * user confirms the editable item fields.
 */
export async function inspectItemDocument(input: {
  userId: string;
  householdId: string;
  filename: string;
  body: ReadableStream<Uint8Array> | null;
  declaredBytes?: number;
}): Promise<ItemDocumentInspectionResult> {
  await requireHouseholdAccess(input.userId, input.householdId);
  const config = getDocumentConfig();
  const storage = new LocalDocumentStorage(config.storageRoot, config.quarantineRoot);
  const received = await storage.receive(input.body, randomUUID(), config.maxBytes, input.declaredBytes);
  try {
    const mediaType = detectDocumentMediaType(received.leadingBytes);
    if (config.scanMode === "required") {
      const scan = await scanFileWithClamAv(received.quarantinePath, config.clamAv);
      if (scan.status !== "clean") {
        const infected = scan.status === "infected";
        throw new AppError(
          infected ? "document_malware_detected" : "document_scanner_unavailable",
          infected ? "Orbit rejected that document because malware was detected" : "Document scanning is temporarily unavailable",
          infected ? 422 : 503,
        );
      }
    }
    const bytes = await storage.readQuarantine(received.quarantinePath, config.maxBytes);
    try {
      let text = "";
      let extracted = false;
      let message: string | undefined;
      let proposal: unknown;
      try {
        const parsedText = await extractTextWithTika(bytes, mediaType);
        if (typeof parsedText !== "string" || parsedText.length > MAX_EXTRACTED_CHARACTERS) throw new Error("parser_output_invalid");
        text = parsedText;
        extracted = true;
        proposal = proposalFromText(text, input.filename);
      } catch {
        extracted = false;
        message = parserRecoveryMessage;
      }
      text = "";
      return {
        extracted,
        suggestions: buildSuggestions(input.filename, proposal),
        ...(message ? { message } : {}),
      };
    } finally {
      bytes.fill(0);
    }
  } finally {
    await storage.discardQuarantine(received.quarantinePath).catch(() => undefined);
  }
}
