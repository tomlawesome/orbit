import { randomUUID } from "node:crypto";
import { AppError } from "@/lib/app-error";
import { log } from "@/lib/logger";
import { getDocumentConfig } from "@/server/documents/config";
import { scanFileWithClamAv } from "@/server/documents/scanner";
import { LocalDocumentStorage } from "@/server/documents/storage";
import {
  proposalFromText,
  safeDocumentFilenameTitle,
  safeStoredDocumentProposal,
  type DocumentProposal,
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

/**
 * A proposed cost, written the way the item's cost field takes it: major
 * units, two decimals. The currency stays on the proposal rather than
 * appearing here, because `itemDocumentSuggestionFields` has no currency
 * slot and an item takes its currency from its household. Nothing is lost
 * by that: a cost only ever reaches this point WITH the currency its
 * evidence carried, since `safeStoredDocumentProposal` drops an amount that
 * arrived without one (ADR-0025 section 3).
 */
function costSuggestion(proposal: DocumentProposal): string | undefined {
  if (proposal.costMinor === undefined) return undefined;
  return (proposal.costMinor / 100).toFixed(2);
}

/**
 * The Add-item review surface. It offers all eight fields
 * `itemDocumentSuggestionFields` declares (ADR-0025 section 7), and offers
 * each one only when the proposal actually carried it — so where the model
 * path is absent, the four model-owned slots are simply empty and the form
 * shows what it always showed.
 *
 * The proposal is re-validated through `safeStoredDocumentProposal` rather
 * than field by field here, so this surface can never show a reviewer a
 * value the storage boundary would have refused.
 */
export function buildDocumentSuggestions(filename: string, proposal: unknown): ItemDocumentSuggestion[] {
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

  const safe = safeStoredDocumentProposal(proposal, filename);
  add("title", safeDocumentFilenameTitle(filename), "filename", "high");
  add("subtype", safe.subtype, "document_text", "medium");
  add("provider", safe.provider, "document_text", "medium");
  add("reference", safe.reference, "document_text", "medium");
  add("cost", costSuggestion(safe), "document_text", "medium");
  // The scheduled date when the roles named one, and otherwise the first
  // date the document offered, exactly as this surface has always behaved.
  add("dueDate", safe.scheduleDate ?? safe.dates[0], "document_text", "medium");
  add("scheduleKind", safe.scheduleKind, "document_text", "medium");
  add(
    "recurrenceMonths",
    safe.recurrenceMonths === undefined ? undefined : String(safe.recurrenceMonths),
    "document_text",
    "medium",
  );
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
        log.info({
          event: "document.inspection",
          state: "exhausted",
          reason: structureReason,
          action: "check_parser",
          impact: "document_processing_blocked",
        });
        return {
          extracted: false,
          message: structureReason === "prohibited_content" ? prohibitedContentMessage : unsupportedStructureMessage,
          suggestions: [],
          attachmentDisposition: "rejected",
          reason: structureReason,
        };
      }
      log.info({ event: "document.inspection", state: "ready", reason: "supported_structure", action: "none" });
      if (config.scanMode !== "required") {
        return {
          extracted: false,
          message: parserRecoveryMessage,
          suggestions: buildDocumentSuggestions(input.filename, undefined),
          attachmentDisposition: "attachable",
          reason: structureReason,
        };
      }
      log.info({ event: "document.scan", state: "starting", action: "check_scanner" });
      const scanStartedAt = Date.now();
      const scan = await scanFileWithClamAv(received.quarantinePath, config.clamAv);
      const scanMs = Math.max(0, Date.now() - scanStartedAt);
      if (scan.status !== "clean") {
        const infected = scan.status === "infected";
        // `scan.reason` is a fixed enumeration from the scanner adapter, never
        // provider text or the scanner's virus signature, so it is safe to record.
        const scannerReason = infected
          ? "malware_detected"
          : scan.reason === "unavailable"
            ? "scanner_unavailable"
            : scan.reason === "timeout"
              ? "scanner_timeout"
              : scan.reason === "protocol"
                ? "scanner_protocol"
                : "scanner_failed";
        log.warn({
          event: "document.scan",
          state: infected ? "exhausted" : "degraded",
          reason: scannerReason,
          action: "check_scanner",
          impact: "document_upload_blocked",
          durationMs: scanMs,
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
      log.info({ event: "document.scan", state: "ready", action: "none", durationMs: scanMs });
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
        suggestions: buildDocumentSuggestions(input.filename, proposal),
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
