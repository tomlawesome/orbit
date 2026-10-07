import { randomUUID } from "node:crypto";
import { AppError } from "@/lib/app-error";
import { log } from "@/lib/logger";
import { getDocumentConfig } from "@/server/documents/config";
import { readEffectiveUploadLimit } from "@/server/upload-limit";
import { renderDocumentPagePreview, type DocumentPagePreview } from "@/server/documents/preview";
import { scanFileWithClamAv } from "@/server/documents/scanner";
import { LocalDocumentStorage } from "@/server/documents/storage";
import { detectDocumentMediaType } from "@/server/documents/validation";
import { requireHouseholdAccess } from "@/server/workspace-access";

export interface ItemDocumentPagePreview extends DocumentPagePreview {
  /** False only where the instance has scanning switched off (`scanMode`
      "disabled"): the page was drawn, but nothing checked the file. */
  scanned: boolean;
}

/**
 * Page one of a file the Add item form has just been given, before any item
 * exists for it to be attached to (#1245; the render is #476's).
 *
 * The create form's reading lane shows the page as soon as it is drawn,
 * while `inspectItemDocument` scans and reads the same bytes alongside —
 * the §14 walk (design/owner-decisions.md): the lanes split, "Focusing on
 * the anomaly" breathes, the top sheet lands. So this takes the same
 * temporary-upload shape the inspection does and retains nothing: received
 * into quarantine, identified, scanned where the instance scans, rendered
 * in memory through the one renderer, then zeroed and discarded. The
 * browser uploads the file a third time only when the entry is saved.
 *
 * The scan comes first for the same reason it does on the inspection path:
 * the renderer parses with the structure check's own parser posture (no
 * scripting, no eval, no network), but a file ClamAV would refuse is still
 * refused before it is drawn, in the upload path's own words.
 */
export async function previewItemDocument(input: {
  userId: string;
  householdId: string;
  body: ReadableStream<Uint8Array> | null;
  declaredBytes?: number;
  /** Called once the scan has passed (`true`), or at once where scanning is
      off (`false`), before anything opens the file: the reading card's cue
      that Orbit has moved on from the virus check to the preview. */
  onScanned?: (scanned: boolean) => void;
}): Promise<ItemDocumentPagePreview> {
  await requireHouseholdAccess(input.userId, input.householdId);
  const config = getDocumentConfig();
  // The administrator's limit, read now so a change needs no restart (#1285).
  const maxBytes = await readEffectiveUploadLimit(config);
  const storage = new LocalDocumentStorage(config.storageRoot, config.quarantineRoot);
  // Ephemeral opaque reference for this pre-attachment render only; never persisted.
  const operationId = randomUUID();
  const received = await storage.receive(input.body, operationId, maxBytes, input.declaredBytes);
  try {
    const mediaType = detectDocumentMediaType(received.leadingBytes);
    let scanned = false;
    // ADR-0033: nothing opens the file before the scan passes. ClamAV reads
    // the quarantine copy over its own socket; the bytes are read for the
    // renderer only afterwards.
    if (config.scanMode === "required") {
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
          impact: "document_processing_blocked",
          durationMs: scanMs,
        });
        if (infected) {
          throw new AppError(
            "document_malware_detected",
            "Orbit rejected that document because malware was detected",
            422,
          );
        }
        // Attributed exactly as the inspection and upload paths attribute it,
        // so all three scanner-dependent journeys report the same cause.
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
      scanned = true;
    }
    input.onScanned?.(scanned);
    const bytes = await storage.readQuarantine(received.quarantinePath, maxBytes);
    try {
      const page = await renderDocumentPagePreview(bytes, mediaType);
      return { ...page, scanned };
    } finally {
      bytes.fill(0);
    }
  } finally {
    await storage.discardQuarantine(received.quarantinePath).catch(() => undefined);
  }
}
