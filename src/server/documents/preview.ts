import { createCanvas, loadImage } from "@napi-rs/canvas";
import { AppError } from "@/lib/app-error";
import { log, type OperationalReason } from "@/lib/logger";
import { renderPdfPageInSandbox } from "@/server/documents/pdf-structure-sandbox";
import { documentPreviewPageInvalid, documentPreviewPageNotFound } from "@/server/documents/preview-page";
import {
  classifyDocumentStructure,
  detectDocumentMediaType,
  hasPdfIndexBudget,
  type SupportedDocumentMediaType,
} from "@/server/documents/validation";

/**
 * Raster page previews (#476; any page since #1300).
 *
 * Rendering happens entirely in memory with the two runtime packages Orbit
 * already ships — PDF.js (Apache-2.0) and `@napi-rs/canvas` (MIT), which is
 * PDF.js's own Node canvas backend. Nothing here writes plaintext to disk, so
 * there is no temporary file to leak or forget to unlink; the caller owns
 * zeroing the decrypted buffer it passed in.
 *
 * A PDF page is drawn in the sandbox worker (pdf-structure-sandbox.ts,
 * ADR-0038), never on this thread, with `validation.ts`'s parser options
 * (ADR-0033): no XFA, no network, no pdf.js worker, and no annotation layer,
 * so nothing a PDF carries runs. Images are drawn here: the pixel cap and
 * the structure check bound them before any decode.
 */

/** Longest edge, in pixels, of a rendered preview. */
export const DOCUMENT_PREVIEW_MAX_EDGE = 1_200;
/** Wall-clock budget for a single page render, mirroring the inspection budget. */
export const DOCUMENT_PREVIEW_RENDER_BUDGET_MS = 10_000;

const JPEG_QUALITY = 82;

export type DocumentPreviewMediaType = "image/jpeg" | "image/png";

export interface DocumentPagePreview {
  bytes: Buffer;
  mediaType: DocumentPreviewMediaType;
  width: number;
  height: number;
  /** pdf.js's `numPages`, read by the sandbox that drew the page; 1 for an image (#1300). */
  pageCount: number;
}

/**
 * Records a preview refusal or failure (#494).
 *
 * Before this, a preview 422 wrote nothing to the log: the render error was
 * swallowed here and `docker logs` carried zero preview records across a
 * full reproduction of #476's container bug. Only ids-shaped, bounded values
 * are ever recorded — no filename, no document bytes, no parser or Skia
 * error text — so this stays inside the closed vocabulary's contract and
 * never becomes a second place content can leak. `document.preview` reuses
 * existing reasons/actions rather than inventing preview-specific ones: the
 * refusal categories here (unsupported structure, a password needed, parser
 * output invalid, processing interrupted) are exactly the categories
 * `document.inspection` and `document.parse` already log at upload time.
 */
function logPreviewRefusal(level: "info" | "warn", reason: OperationalReason): void {
  log[level]({
    event: "document.preview",
    state: "blocked",
    reason,
    action: reason === "processing_interrupted" ? "none" : "check_parser",
    impact: "none",
  });
}

function unsupportedPreview(reason: OperationalReason = "unsupported_structure"): AppError {
  logPreviewRefusal("info", reason);
  return new AppError(
    "document_preview_unsupported",
    "Orbit cannot show a picture of this document",
    415,
  );
}

function failedPreview(reason: OperationalReason = "parser_output_invalid"): AppError {
  logPreviewRefusal("warn", reason);
  return new AppError(
    "document_preview_failed",
    "Orbit could not draw a picture of this document",
    422,
  );
}

function boundedCanvasSize(width: number, height: number, allowUpscale: boolean): { width: number; height: number } {
  const longest = Math.max(width, height);
  if (!Number.isFinite(longest) || longest <= 0) throw failedPreview();
  const ratio = DOCUMENT_PREVIEW_MAX_EDGE / longest;
  const scale = allowUpscale ? ratio : Math.min(1, ratio);
  return {
    width: Math.min(DOCUMENT_PREVIEW_MAX_EDGE, Math.max(1, Math.round(width * scale))),
    height: Math.min(DOCUMENT_PREVIEW_MAX_EDGE, Math.max(1, Math.round(height * scale))),
  };
}

let renderBudgetMsOverride: number | undefined;

/** Lets a test force the render budget to expire deterministically, rather than racing 10 real seconds against a real render. */
export function setDocumentPreviewRenderBudgetForTests(ms: number | undefined): void {
  renderBudgetMsOverride = ms;
}

async function withRenderBudget<T>(work: () => Promise<T>): Promise<T> {
  let budgetTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    const budget = new Promise<never>((_, reject) => {
      budgetTimer = setTimeout(
        () => reject(failedPreview("processing_interrupted")),
        renderBudgetMsOverride ?? DOCUMENT_PREVIEW_RENDER_BUDGET_MS,
      );
    });
    return await Promise.race([work(), budget]);
  } finally {
    if (budgetTimer) clearTimeout(budgetTimer);
  }
}

/**
 * Draws a PDF page in the sandbox (#1427, ADR-0038): the structure check's
 * cheap first fence here, then one worker run that applies the check's gate,
 * finds the page and draws it, under the render budget and the sandbox's
 * memory cap. Nothing of the file is read on this thread, so a page that
 * decodes to hundreds of megabytes costs one killed worker, not the server.
 */
async function renderPdfPage(bytes: Buffer, pageNumber: number): Promise<DocumentPagePreview> {
  if (!hasPdfIndexBudget(bytes)) throw unsupportedPreview();
  const rendered = await renderPdfPageInSandbox(bytes, {
    page: pageNumber,
    maxEdge: DOCUMENT_PREVIEW_MAX_EDGE,
    wallMs: renderBudgetMsOverride ?? DOCUMENT_PREVIEW_RENDER_BUDGET_MS,
  });
  switch (rendered.outcome) {
    case "drawn":
      return { bytes: rendered.png, mediaType: "image/png", width: rendered.width, height: rendered.height, pageCount: rendered.pageCount };
    case "refused":
      throw unsupportedPreview(rendered.reason);
    case "page_not_found":
      throw documentPreviewPageNotFound();
    case "failed":
      throw failedPreview(rendered.stop === "timeout" ? "processing_interrupted" : undefined);
  }
}

async function renderRasterPage(bytes: Buffer, mediaType: "image/jpeg" | "image/png"): Promise<DocumentPagePreview> {
  const image = await loadImage(bytes);
  const size = boundedCanvasSize(image.width, image.height, false);
  const canvas = createCanvas(size.width, size.height);
  const context = canvas.getContext("2d");
  if (mediaType === "image/jpeg") {
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, size.width, size.height);
  }
  context.drawImage(image, 0, 0, size.width, size.height);
  return mediaType === "image/jpeg"
    ? { bytes: canvas.toBuffer("image/jpeg", JPEG_QUALITY), mediaType, width: size.width, height: size.height, pageCount: 1 }
    : { bytes: canvas.toBuffer("image/png"), mediaType, width: size.width, height: size.height, pageCount: 1 };
}

/**
 * Renders one page of already-decrypted document bytes: page one unless the
 * caller asks for another (#1300), with the document's page count.
 *
 * The bytes are re-identified and re-inspected here rather than trusted from
 * the stored media type: a preview applies the same gate upload applies,
 * under the render budget (looser than upload's, so a file at the margin may
 * preview and still be refused on upload), and both failure modes are
 * bounded codes a screen can word rather than a 500. A render stopped on
 * memory, the canvas allowance included, is a failed preview (422). The page
 * number changes none of that: identification and the
 * structure check's gate run first and unchanged (for a PDF, inside the same
 * sandboxed run that draws), and only then is the requested page looked for,
 * within the render budget. A page past the end is a 404 in its own words;
 * an image has exactly one page. `pageNumber` arrives already bounded by
 * `parseDocumentPreviewPage`; the integer check here only keeps a direct
 * caller from reaching pdf.js with anything else, and draws nothing.
 */
export async function renderDocumentPagePreview(
  bytes: Buffer,
  storedMediaType: string,
  pageNumber = 1,
): Promise<DocumentPagePreview> {
  if (!Number.isSafeInteger(pageNumber) || pageNumber < 1) throw documentPreviewPageInvalid();
  let detected: SupportedDocumentMediaType;
  try {
    detected = detectDocumentMediaType(bytes);
  } catch {
    throw unsupportedPreview();
  }
  if (detected !== storedMediaType) throw unsupportedPreview();
  if (detected === "application/pdf") return renderPdfPage(bytes, pageNumber);
  const structureReason = await classifyDocumentStructure(bytes, detected);
  if (structureReason !== "supported_structure") throw unsupportedPreview(structureReason);

  return withRenderBudget(async () => {
    try {
      if (pageNumber !== 1) throw documentPreviewPageNotFound();
      return await renderRasterPage(bytes, detected);
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw failedPreview();
    }
  });
}
