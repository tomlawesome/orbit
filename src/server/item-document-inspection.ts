import { randomUUID } from "node:crypto";
import { AppError } from "@/lib/app-error";
import { log } from "@/lib/logger";
import { getDocumentConfig } from "@/server/documents/config";
import { scanFileWithClamAv } from "@/server/documents/scanner";
import { LocalDocumentStorage } from "@/server/documents/storage";
import {
  proposalFromText,
  safeDocumentFilenameTitle,
  safeDocumentPlainText,
} from "@/server/documents/suggestions";
import { classifyDocumentStructure, detectDocumentMediaType, type DocumentStructureReason } from "@/server/documents/validation";
import { extractTextWithTika } from "@/server/documents/tika";
import { requireHouseholdAccess } from "@/server/workspace-access";

const MAX_EXTRACTED_CHARACTERS = 250_000;
const parserRecoveryMessage = "Suggestions are unavailable right now. Review the fields manually; the document can still be attached.";
const processorDisabledMessage = "Automatic suggestions require the optional document processor. You can still attach this file.";
const unsupportedStructureMessage = "Orbit could not safely inspect this document structure. Choose another PDF, JPEG, or PNG before adding the item.";
const prohibitedContentMessage = "Orbit rejected this document because it contains prohibited active or embedded content. Choose another document.";

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
  attachmentDisposition: "attachable" | "rejected";
  reason: DocumentStructureReason;
}

const allowedSuggestionFields = new Set<ItemDocumentSuggestionField>(itemDocumentSuggestionFields);

function validCalendarDate(value: unknown): string | undefined {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) return undefined;
  const date = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return undefined;
  return date.toISOString().slice(0, 10) === value ? value : undefined;
}

function filenameTitle(filename: string): string | undefined {
  return safeDocumentFilenameTitle(filename);
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
  add("provider", safeDocumentPlainText(candidate.provider, 100), "document_text", "medium");
  add("reference", safeDocumentPlainText(candidate.reference, 80), "document_text", "medium");
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
  // Ephemeral opaque reference for this pre-attachment inspection only; never persisted.
  const operationId = randomUUID();
  const received = await storage.receive(input.body, operationId, config.maxBytes, input.declaredBytes);
  try {
    const mediaType = detectDocumentMediaType(received.leadingBytes);
    const bytes = await storage.readQuarantine(received.quarantinePath, config.maxBytes);
    try {
      const structureReason = await classifyDocumentStructure(bytes, mediaType);
      if (structureReason !== "supported_structure") {
        log.info("document.inspection", { outcome: "rejected", reason: structureReason });
        return {
          extracted: false,
          message: structureReason === "prohibited_content" ? prohibitedContentMessage : unsupportedStructureMessage,
          suggestions: [],
          attachmentDisposition: "rejected",
          reason: structureReason,
        };
      }
      log.info("document.inspection", { outcome: "attachable", reason: structureReason });
      if (config.scanMode !== "required") {
        return {
          extracted: false,
          message: parserRecoveryMessage,
          suggestions: buildSuggestions(input.filename, undefined),
          attachmentDisposition: "attachable",
          reason: structureReason,
        };
      }
      log.info("document.scan", { document: operationId, outcome: "attempt" });
      const scanStartedAt = Date.now();
      const scan = await scanFileWithClamAv(received.quarantinePath, config.clamAv);
      const scanMs = Math.max(0, Date.now() - scanStartedAt);
      if (scan.status !== "clean") {
        const infected = scan.status === "infected";
        // `scan.reason` is a fixed enumeration from the scanner adapter, never
        // provider text or the scanner's virus signature, so it is safe to record.
        log.warn("document.scan", {
          document: operationId,
          outcome: infected ? "infected" : "error",
          reason: infected ? "malware_detected" : scan.reason,
          ms: scanMs,
        });
        if (infected) {
          throw new AppError(
            "document_malware_detected",
            "Orbit rejected that document because malware was detected",
            422,
          );
        }
        // Attribute the failure exactly as the upload path does, so both
        // scanner-dependent journeys report the same actionable cause.
        const unreachable = scan.reason === "unavailable" || scan.reason === "timeout";
        throw new AppError(
          unreachable ? "document_scanner_unreachable" : "document_scanner_failed",
          unreachable
            ? "Document inspection is not possible because the malware scanner cannot be reached. It stays blocked until the scanner is running."
            : "Document inspection is not possible because the malware scanner reported a failure. It stays blocked until the scanner is healthy.",
          503,
        );
      }
      log.info("document.scan", { document: operationId, outcome: "clean", ms: scanMs });
      let text = "";
      let extracted = false;
      let message: string | undefined;
      let proposal: unknown;
      try {
        const parsedText = await extractTextWithTika(bytes, mediaType, operationId);
        if (typeof parsedText !== "string" || parsedText.length > MAX_EXTRACTED_CHARACTERS) throw new Error("parser_output_invalid");
        text = parsedText;
        extracted = true;
        proposal = proposalFromText(text, input.filename);
      } catch (error) {
        extracted = false;
        message = error instanceof AppError && error.code === "parser_disabled"
          ? processorDisabledMessage
          : parserRecoveryMessage;
      }
      text = "";
      return {
        extracted,
        suggestions: buildSuggestions(input.filename, proposal),
        attachmentDisposition: "attachable",
        reason: structureReason,
        ...(message ? { message } : {}),
      };
    } finally {
      bytes.fill(0);
    }
  } finally {
    await storage.discardQuarantine(received.quarantinePath).catch(() => undefined);
  }
}
