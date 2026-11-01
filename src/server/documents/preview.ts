import { AppError } from "@/lib/app-error";
import { log, type OperationalReason } from "@/lib/logger";
import { renderImageInSandbox, renderPdfPageInSandbox } from "@/server/documents/pdf-structure-sandbox";
import { documentPreviewPageInvalid, documentPreviewPageNotFound } from "@/server/documents/preview-page";
import {
  declaredImageDimensionsWithinCap,
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
 * A PDF page is drawn in a sandbox child process (pdf-structure-sandbox.ts,
 * ADR-0038), never in the server's process, with `validation.ts`'s parser options
 * (ADR-0033): no XFA, no network, no pdf.js worker, and no annotation layer,
 * so nothing a PDF carries runs. An image is drawn in the same sandbox, after
 * the pixel cap's header fence (#1572): the decoder never runs in the server.
 */

/** Longest edge, in pixels, of a rendered preview. */
export const DOCUMENT_PREVIEW_MAX_EDGE = 1_200;
/**
 * Wall-clock budget for a single page render: 30 s (ADR-0038 amendment,
 * 2026-10-29). A 300 dpi A4 scan costs about 7 s in pdf.js's JavaScript JPEG
 * decoder, so 10 s left too little headroom on a busy home server. Looser than
 * the upload-time structure check's own 5 s. The child's CPU limit follows from
 * it (start-up + this + 5 s).
 */
export const DOCUMENT_PREVIEW_RENDER_BUDGET_MS = 30_000;

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

/** Lets a test force the render budget to expire deterministically, rather than racing the real budget against a real render. */
export function setDocumentPreviewRenderBudgetForTests(ms: number | undefined): void {
  renderBudgetMsOverride = ms;
}

/**
 * Draws a PDF page in the sandbox (#1427, ADR-0038): the structure check's
 * cheap first fence here, then one child process that applies the check's
 * gate, finds the page and draws it, under the render budget and the
 * sandbox's process-memory ceiling. Nothing of the file is read in this
 * process, so a page that decodes to hundreds of megabytes costs one killed
 * child, not the server.
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
      throw failedPreview(rendered.stop === "timeout" || rendered.stop === "memory" ? "processing_interrupted" : undefined);
  }
}

/**
 * Draws an image in the sandbox (#1572, ADR-0038): the header fence first, then
 * one child process that decodes it, applies the upload check's gate and draws
 * the bounded picture, under the render budget and the sandbox's memory
 * ceiling. An image has exactly one page.
 */
async function renderImagePage(bytes: Buffer, mediaType: DocumentPreviewMediaType, pageNumber: number): Promise<DocumentPagePreview> {
  const declared = declaredImageDimensionsWithinCap(bytes, mediaType);
  if (!declared) throw unsupportedPreview("unsupported_structure");
  if (pageNumber !== 1) throw documentPreviewPageNotFound();
  const size = boundedCanvasSize(declared.width, declared.height, false);
  const rendered = await renderImageInSandbox(bytes, {
    mediaType,
    declared,
    ...size,
    wallMs: renderBudgetMsOverride ?? DOCUMENT_PREVIEW_RENDER_BUDGET_MS,
  });
  switch (rendered.outcome) {
    case "drawn":
      return { bytes: rendered.bytes, mediaType, width: rendered.width, height: rendered.height, pageCount: 1 };
    case "refused":
      throw unsupportedPreview(rendered.reason);
    case "failed":
      throw failedPreview(rendered.stop === "timeout" || rendered.stop === "memory" ? "processing_interrupted" : undefined);
  }
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
 * memory is a failed preview (422) logged as interrupted; the sandbox's own
 * record names memory. The page
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
  return renderImagePage(bytes, detected, pageNumber);
}
