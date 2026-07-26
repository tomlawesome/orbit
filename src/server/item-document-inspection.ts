import { randomUUID } from "node:crypto";
import { AppError } from "@/lib/app-error";
import { getDocumentConfig } from "@/server/documents/config";
import { scanFileWithClamAv } from "@/server/documents/scanner";
import { LocalDocumentStorage } from "@/server/documents/storage";
import { detectDocumentMediaType } from "@/server/documents/validation";
import { extractTextWithTika } from "@/server/documents/tika";
import { proposalFromText } from "@/server/document-drafts";
import { requireHouseholdAccess } from "@/server/workspace-access";

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
}) {
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
      try {
        text = await extractTextWithTika(bytes, mediaType);
        extracted = true;
      } catch (error) {
        if (!(error instanceof AppError) || !["parser_disabled", "parser_unavailable"].includes(error.code)) throw error;
      }
      return { proposal: proposalFromText(text, input.filename), extracted };
    } finally {
      bytes.fill(0);
    }
  } finally {
    await storage.discardQuarantine(received.quarantinePath).catch(() => undefined);
  }
}
