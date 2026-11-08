import { AppError } from "@/lib/app-error";
import { log, type OperationalReason } from "@/lib/logger";
import {
  type DocumentFileOnDisk,
  renderImageInSandbox,
  renderPdfPageInSandbox,
  type SandboxPool,
} from "@/server/documents/pdf-structure-sandbox";
import { documentPreviewPageInvalid, documentPreviewPageNotFound } from "@/server/documents/preview-page";
import {
  declaredImageDimensionsWithinCap,
  detectDocumentMediaType,
  type SupportedDocumentMediaType,
} from "@/server/documents/validation";

/**
 * Raster page previews (#476; any page since #1300).
 *
 * A PDF page is drawn by poppler's `pdftoppm` (GPL-2.0-or-later, run as a
 * separate program) to a JPEG, in a sandboxed child process
 * (pdf-structure-sandbox.ts, ADR-0038, ADR-0046), never in the server's
 * process. The child reads the file through a descriptor: the caller's
 * quarantine file, or, for plaintext held only in memory, an unlinked file the
 * sandbox writes to the quarantine tmpfs for the draw's length. poppler runs
 * nothing a PDF carries. An image is drawn by `@napi-rs/canvas` (MIT) in the
 * same sandbox, after the pixel cap's header fence (#1572): the decoder never
 * runs in the server. The caller owns zeroing the decrypted buffer it passed in.
 */

/** Longest edge, in pixels, of a rendered preview. */
export const DOCUMENT_PREVIEW_MAX_EDGE = 1_200;
/**
 * Wall-clock budget for a single page draw, from spawn: 15 s (#1436,
 * ADR-0046). The slowest legitimate page measured with pdftoppm takes 1.1 s,
 * so a host five times slower still has about 3x headroom; the old 30 s was
 * sized for pdf.js's JavaScript JPEG decoder. Looser than the upload-time
 * structure check's own 5 s. The child's CPU limit follows from it (this,
 * in whole seconds, + 5 s).
 */
export const DOCUMENT_PREVIEW_RENDER_BUDGET_MS = 15_000;

export type DocumentPreviewMediaType = "image/jpeg" | "image/png";

export interface DocumentPagePreview {
  bytes: Buffer;
  mediaType: DocumentPreviewMediaType;
  width: number;
  height: number;
  /** The document's page count: the stored one, or read by `pdfinfo` beside the draw; 1 for an image (#1300, #1436). */
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

/** Where a preview's plaintext also sits, who is waiting, and what the caller already knows. */
export type DocumentPreviewOptions = {
  /** The same plaintext as a file on disk, read through a descriptor instead of writing the bytes out. */
  file?: DocumentFileOnDisk;
  /** The slot pool the draw waits in: `view` (someone is looking) unless said otherwise. */
  pool?: SandboxPool;
  /** The document's stored page count; without it `pdfinfo` reads it beside the draw. */
  pageCount?: number;
};

let renderBudgetMsOverride: number | undefined;

/** Lets a test force the render budget to expire deterministically, rather than racing the real budget against a real render. */
export function setDocumentPreviewRenderBudgetForTests(ms: number | undefined): void {
  renderBudgetMsOverride = ms;
}

/**
 * Draws a PDF page in the sandbox (#1427, #1436, ADR-0046): one `pdftoppm`
 * child finds the page and draws it, under the render budget and the
 * sandbox's process-memory ceiling. Nothing of the file is read in this
 * process, so a page that decodes to hundreds of megabytes costs one killed
 * child, not the server. Without a known page count, `pdfinfo` reads it in
 * the same slot.
 */
async function renderPdfPage(input: { bytes: Buffer } | DocumentFileOnDisk, pageNumber: number, options: DocumentPreviewOptions): Promise<DocumentPagePreview> {
  const rendered = await renderPdfPageInSandbox(input, {
    page: pageNumber,
    maxEdge: DOCUMENT_PREVIEW_MAX_EDGE,
    wallMs: renderBudgetMsOverride ?? DOCUMENT_PREVIEW_RENDER_BUDGET_MS,
    pool: options.pool ?? "view",
    pageCount: options.pageCount === undefined,
  });
  switch (rendered.outcome) {
    case "drawn": {
      const pageCount = options.pageCount ?? rendered.pageCount;
      if (pageCount === undefined) throw failedPreview();
      return { bytes: rendered.bytes, mediaType: "image/jpeg", width: rendered.width, height: rendered.height, pageCount };
    }
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
async function renderImagePage(bytes: Buffer, mediaType: DocumentPreviewMediaType, pageNumber: number, options: DocumentPreviewOptions): Promise<DocumentPagePreview> {
  const declared = declaredImageDimensionsWithinCap(bytes, mediaType);
  if (!declared) throw unsupportedPreview("unsupported_structure");
  if (pageNumber !== 1) throw documentPreviewPageNotFound();
  const size = boundedCanvasSize(declared.width, declared.height, false);
  const rendered = await renderImageInSandbox(bytes, {
    mediaType,
    declared,
    ...size,
    wallMs: renderBudgetMsOverride ?? DOCUMENT_PREVIEW_RENDER_BUDGET_MS,
    pool: options.pool ?? "view",
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
 * caller from reaching poppler with anything else, and draws nothing.
 * `options.file` is the same plaintext on disk (a quarantine file), which the
 * draw reads instead of writing `bytes` out again; `options.pageCount` is the
 * stored count, when the caller has it.
 */
export async function renderDocumentPagePreview(
  bytes: Buffer,
  storedMediaType: string,
  pageNumber = 1,
  options: DocumentPreviewOptions = {},
): Promise<DocumentPagePreview> {
  if (!Number.isSafeInteger(pageNumber) || pageNumber < 1) throw documentPreviewPageInvalid();
  let detected: SupportedDocumentMediaType;
  try {
    detected = detectDocumentMediaType(bytes);
  } catch {
    throw unsupportedPreview();
  }
  if (detected !== storedMediaType) throw unsupportedPreview();
  if (detected === "application/pdf") return renderPdfPage(options.file ?? { bytes }, pageNumber, options);
  return renderImagePage(bytes, detected, pageNumber, options);
}
