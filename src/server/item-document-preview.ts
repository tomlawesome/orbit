import { randomUUID } from "node:crypto";
import { log } from "@/lib/logger";
import { getDocumentConfig } from "@/server/documents/config";
import { readEffectiveUploadLimit } from "@/server/upload-limit";
import { renderDocumentPagePreview, type DocumentPagePreview } from "@/server/documents/preview";
import { scanFileWithClamAv } from "@/server/documents/scanner";
import { classifyScan, documentScanCodes, scanRefusal } from "@/server/documents/scan-outcome";
import { openDocumentStorage } from "@/server/documents/storage";
import { detectDocumentMediaType } from "@/server/documents/validation";
import { requireHouseholdAccess } from "@/server/workspace-access";

export interface ItemDocumentPagePreview extends DocumentPagePreview {
  /** False only where the instance has scanning switched off (`scanMode`
      "disabled"): the page was drawn, but nothing checked the file. */
  scanned: boolean;
}

/**
 * One page of a file the Add item form has just been given (page one unless
 * `page` asks for another, #1300), before any item
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
  /** The page to draw, already bounded by `parseDocumentPreviewPage`; 1 when absent (#1300). */
  page?: number;
  /** Called once the scan has passed (`true`), or at once where scanning is
      off (`false`), before anything opens the file: the reading card's cue
      that Orbit has moved on from the virus check to the preview. */
  onScanned?: (scanned: boolean) => void;
}): Promise<ItemDocumentPagePreview> {
  await requireHouseholdAccess(input.userId, input.householdId);
  const config = getDocumentConfig();
  // The administrator's limit, read now so a change needs no restart (#1285).
  const maxBytes = await readEffectiveUploadLimit(config);
  const storage = openDocumentStorage(config);
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
      const outcome = classifyScan(scan, documentScanCodes);
      if (outcome.status !== "clean") {
        log.warn({
          event: "document.scan",
          state: outcome.status === "infected" ? "exhausted" : "degraded",
          // A fixed enumeration, never provider text or the scanner's virus
          // signature, so it is safe to record.
          reason: outcome.logReason,
          action: "check_scanner",
          impact: "document_processing_blocked",
          durationMs: scanMs,
        });
        throw scanRefusal(outcome, "preview");
      }
      log.info({ event: "document.scan", state: "ready", action: "none", durationMs: scanMs });
      scanned = true;
    }
    input.onScanned?.(scanned);
    const bytes = await storage.readQuarantine(received.quarantinePath, maxBytes);
    try {
      const drawn = await renderDocumentPagePreview(bytes, mediaType, input.page ?? 1);
      return { ...drawn, scanned };
    } finally {
      bytes.fill(0);
    }
  } finally {
    await storage.discardQuarantine(received.quarantinePath).catch(() => undefined);
  }
}
