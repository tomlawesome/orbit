import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, sep } from "node:path";
import { createCanvas, loadImage, DOMMatrix, Path2D, type Canvas, type SKRSContext2D } from "@napi-rs/canvas";
import { getDocument, VerbosityLevel } from "pdfjs-dist/legacy/build/pdf.mjs";
import { AppError } from "@/lib/app-error";
import { log, type OperationalReason } from "@/lib/logger";
import {
  classifyDocumentStructure,
  detectDocumentMediaType,
  type SupportedDocumentMediaType,
} from "@/server/documents/validation";

/**
 * Page-one raster previews (#476).
 *
 * Rendering happens entirely in memory with the two runtime packages Orbit
 * already ships — PDF.js (Apache-2.0) and `@napi-rs/canvas` (MIT), which is
 * PDF.js's own Node canvas backend. Nothing here writes plaintext to disk, so
 * there is no temporary file to leak or forget to unlink; the caller owns
 * zeroing the decrypted buffer it passed in.
 *
 * The parser options mirror `validation.ts`: no scripting, no eval, no XFA, no
 * network, no worker. A preview must not become a wider execution surface than
 * the structure check the same bytes already passed.
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
}

type PdfPreviewParserOptions = NonNullable<Parameters<typeof getDocument>[0]> & { isEvalSupported: false };

const PDF_PREVIEW_PARSER_OPTIONS = Object.freeze({
  disableAutoFetch: true,
  disableFontFace: true,
  disableRange: true,
  disableStream: true,
  enableScripting: false,
  enableXfa: false,
  isEvalSupported: false,
  isImageDecoderSupported: false,
  isOffscreenCanvasSupported: false,
  stopAtErrors: true,
  useSystemFonts: false,
  useWasm: false,
  useWorkerFetch: false,
  verbosity: VerbosityLevel.ERRORS,
}) as Readonly<PdfPreviewParserOptions>;

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
 * refusal categories here (unsupported structure, prohibited content, parser
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

let cachedStandardFontDirectory: string | null | undefined;

/** Every place the shipped font data can sit, most specific first. */
function standardFontCandidates(): string[] {
  const candidates: string[] = [];
  const nodeRequire = createRequire(import.meta.url);
  // The traced entry point, not `pdfjs-dist/package.json`: the standalone
  // output copies only the traced files into `node_modules/pdfjs-dist`, so
  // that folder has no package.json to resolve through.
  const packageRoots: Array<[specifier: string, depth: number]> = [
    ["pdfjs-dist/legacy/build/pdf.mjs", 3],
    ["pdfjs-dist/package.json", 1],
  ];
  for (const [specifier, depth] of packageRoots) {
    try {
      let root = nodeRequire.resolve(specifier);
      for (let step = 0; step < depth; step += 1) root = dirname(root);
      candidates.push(join(root, "standard_fonts"));
    } catch {
      // A specifier that does not resolve simply is not a candidate.
    }
  }
  candidates.push(join(process.cwd(), "node_modules", "pdfjs-dist", "standard_fonts"));
  return candidates;
}

/**
 * The Liberation/Foxit substitutes PDF.js ships for the standard 14 fonts.
 *
 * PDF.js reads these through Node's filesystem, so the value is a directory
 * path with a trailing separator rather than a URL. Resolution is deliberately
 * fallible: when the directory is absent a page with non-embedded standard
 * fonts still renders, just without its text, which is a better preview than
 * no preview at all. `nodeRequire` avoids the bundler rewriting a bare
 * `require.resolve`; both packages are declared `serverExternalPackages`.
 */
function standardFontDirectory(): string | undefined {
  if (cachedStandardFontDirectory !== undefined) return cachedStandardFontDirectory ?? undefined;
  cachedStandardFontDirectory = null;
  try {
    const found = standardFontCandidates().find((candidate) => existsSync(candidate));
    if (found) cachedStandardFontDirectory = found + sep;
  } catch {
    cachedStandardFontDirectory = null;
  }
  return cachedStandardFontDirectory ?? undefined;
}

/**
 * The canvas backend PDF.js is told to use for its own scratch surfaces.
 *
 * PDF.js otherwise builds transparency groups, soft masks and tiling patterns
 * on canvases from whichever copy of `@napi-rs/canvas` its own module URL
 * resolves to, then draws them onto ours. Skia rejects a surface that belongs
 * to a different instance of the addon, so the factory is pinned to the same
 * import this module draws with. The shape mirrors PDF.js's own
 * `BaseCanvasFactory` rather than extending it, because that class is internal.
 */
class PinnedCanvasFactory {
  create(width: number, height: number): { canvas: Canvas; context: SKRSContext2D } {
    if (width <= 0 || height <= 0) throw failedPreview();
    const canvas = createCanvas(width, height);
    return { canvas, context: canvas.getContext("2d") };
  }

  reset(canvasAndContext: { canvas: Canvas | null }, width: number, height: number): void {
    if (!canvasAndContext.canvas || width <= 0 || height <= 0) throw failedPreview();
    canvasAndContext.canvas.width = width;
    canvasAndContext.canvas.height = height;
  }

  destroy(canvasAndContext: { canvas: Canvas | null; context: SKRSContext2D | null }): void {
    if (!canvasAndContext.canvas) return;
    canvasAndContext.canvas.width = 0;
    canvasAndContext.canvas.height = 0;
    canvasAndContext.canvas = null;
    canvasAndContext.context = null;
  }
}

/**
 * Makes PDF.js draw with this module's canvas backend and no other.
 *
 * PDF.js reads `Path2D` and `DOMMatrix` off `globalThis`, polyfilling them at
 * import time from the copy of `@napi-rs/canvas` its own module URL resolves
 * to. That is not always the copy this module imports: the standalone
 * container image materialises pnpm's symlinked duplicates as separate
 * directories, so PDF.js loads a second native Skia addon and every glyph
 * outline it hands to our context is a foreign object Skia refuses with "Value
 * is none of these types `String`, `Path`" — a whole-page render failure for
 * any document with text. Reassigning the globals is safe when both copies are
 * already the same object, and is the only way to be certain they are.
 */
function pinRenderingGlobals(): void {
  const globals = globalThis as unknown as Record<string, unknown>;
  if (globals.Path2D !== Path2D) globals.Path2D = Path2D;
  if (globals.DOMMatrix !== DOMMatrix) globals.DOMMatrix = DOMMatrix;
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

async function renderPdfPageOne(bytes: Buffer): Promise<DocumentPagePreview> {
  let loadingTask: ReturnType<typeof getDocument> | undefined;
  try {
    pinRenderingGlobals();
    loadingTask = getDocument({
      ...PDF_PREVIEW_PARSER_OPTIONS,
      CanvasFactory: PinnedCanvasFactory,
      data: new Uint8Array(bytes),
      standardFontDataUrl: standardFontDirectory(),
    });
    const pdf = await loadingTask.promise;
    if (pdf.numPages < 1) throw failedPreview();
    const page = await pdf.getPage(1);
    const unscaled = page.getViewport({ scale: 1 });
    const size = boundedCanvasSize(unscaled.width, unscaled.height, true);
    const viewport = page.getViewport({ scale: size.width / unscaled.width });
    const canvas = createCanvas(size.width, size.height);
    const context = canvas.getContext("2d");
    // Pages are transparent by default; a preview is shown against unknown
    // chrome, so the page's own paper is painted first.
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, size.width, size.height);
    await page.render({
      // Skia's canvas is API-compatible with the DOM types PDF.js declares but
      // is not structurally identical to them; PDF.js itself constructs this
      // exact backend when it runs under Node.
      canvas: canvas as unknown as HTMLCanvasElement,
      canvasContext: context as unknown as CanvasRenderingContext2D,
      viewport,
    }).promise;
    page.cleanup();
    return { bytes: canvas.toBuffer("image/png"), mediaType: "image/png", width: size.width, height: size.height };
  } finally {
    if (loadingTask) await loadingTask.destroy().catch(() => undefined);
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
    ? { bytes: canvas.toBuffer("image/jpeg", JPEG_QUALITY), mediaType, width: size.width, height: size.height }
    : { bytes: canvas.toBuffer("image/png"), mediaType, width: size.width, height: size.height };
}

/**
 * Renders page one of already-decrypted document bytes.
 *
 * The bytes are re-identified and re-inspected here rather than trusted from
 * the stored media type: a preview must refuse exactly what upload refused,
 * and both failure modes are bounded codes a screen can word rather than a
 * 500.
 */
export async function renderDocumentPagePreview(
  bytes: Buffer,
  storedMediaType: string,
): Promise<DocumentPagePreview> {
  let detected: SupportedDocumentMediaType;
  try {
    detected = detectDocumentMediaType(bytes);
  } catch {
    throw unsupportedPreview();
  }
  if (detected !== storedMediaType) throw unsupportedPreview();
  const structureReason = await classifyDocumentStructure(bytes, detected);
  if (structureReason !== "supported_structure") throw unsupportedPreview(structureReason);

  return withRenderBudget(async () => {
    try {
      return detected === "application/pdf"
        ? await renderPdfPageOne(bytes)
        : await renderRasterPage(bytes, detected);
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw failedPreview();
    }
  });
}
