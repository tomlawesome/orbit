import { basename } from "node:path";
import { AppError } from "@/lib/app-error";
import { getDocument, VerbosityLevel } from "pdfjs-dist/legacy/build/pdf.mjs";

export type SupportedDocumentMediaType =
  | "application/pdf"
  | "image/jpeg"
  | "image/png";

const mediaExtensions: Record<SupportedDocumentMediaType, string> = {
  "application/pdf": ".pdf",
  "image/jpeg": ".jpg",
  "image/png": ".png",
};

const MAX_IMAGE_DIMENSION = 20_000;
const MAX_IMAGE_PIXELS = 40_000_000;
export const PDF_STRUCTURE_MAX_PAGES = 1_000;
export const PDF_STRUCTURE_INSPECTION_BUDGET_MS = 5_000;
const MAX_PDF_XREF_ENTRIES = 1_250_000;
/**
 * The parameters the installed pdf.js's own `getDocument` declares. Options
 * are checked against this with `satisfies`, so an option the pinned version
 * does not know fails the type check instead of silently doing nothing, as
 * `isEvalSupported` and `enableScripting` did (#1294).
 */
export type PdfDocumentParameters = NonNullable<Parameters<typeof getDocument>[0]>;

/**
 * How Orbit's one PDF parser opens untrusted bytes, for the structure check
 * and the page-one renderer alike (ADR-0033 pattern C): no XFA, no worker,
 * no network or range fetching, no system or browser fonts, no WebAssembly
 * or platform image decoders, and errors stop the parse. Nothing a PDF
 * carries can run: pdf.js runs document scripts only through the viewer's
 * annotation layer and scripting manager, which Orbit never builds.
 */
export const PDF_STRUCTURE_PARSER_OPTIONS = Object.freeze({
  disableAutoFetch: true,
  disableFontFace: true,
  disableRange: true,
  disableStream: true,
  enableXfa: false,
  isImageDecoderSupported: false,
  isOffscreenCanvasSupported: false,
  stopAtErrors: true,
  useSystemFonts: false,
  useWasm: false,
  useWorkerFetch: false,
  verbosity: VerbosityLevel.ERRORS,
} satisfies PdfDocumentParameters);

function startsWith(bytes: Buffer, signature: number[]): boolean {
  return signature.every((value, index) => bytes[index] === value);
}

function safeImageDimensions(width: number, height: number): boolean {
  return width > 0
    && height > 0
    && width <= MAX_IMAGE_DIMENSION
    && height <= MAX_IMAGE_DIMENSION
    && width * height <= MAX_IMAGE_PIXELS;
}

/**
 * The dimensions an image's header declares, read before anything decodes
 * it, so the pixel cap bounds the decoder rather than following it (ADR-0033
 * pattern D). Only the header is read: the PNG IHDR at its fixed place, or
 * the JPEG frame header found by stepping over the segments ahead of it.
 */
function declaredImageDimensions(bytes: Buffer, mediaType: "image/jpeg" | "image/png"): { width: number; height: number } | undefined {
  if (mediaType === "image/png") {
    if (bytes.length < 24 || bytes.subarray(12, 16).toString("latin1") !== "IHDR") return undefined;
    return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  }
  let offset = 2;
  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff) return undefined;
    while (offset < bytes.length && bytes[offset] === 0xff) offset += 1;
    const marker = bytes[offset];
    offset += 1;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (marker === undefined || marker === 0xd9 || marker === 0xda || offset + 2 > bytes.length) return undefined;
    const length = bytes.readUInt16BE(offset);
    const isFrame = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isFrame) {
      if (length < 7 || offset + 7 > bytes.length) return undefined;
      return { height: bytes.readUInt16BE(offset + 3), width: bytes.readUInt16BE(offset + 5) };
    }
    offset += length;
  }
  return undefined;
}

/** Pattern E for images: the header is within the cap and the preview renderer's own decoder reads the image. */
async function classifyImageStructure(bytes: Buffer, mediaType: "image/jpeg" | "image/png"): Promise<DocumentStructureReason> {
  const declared = declaredImageDimensions(bytes, mediaType);
  if (!declared || !safeImageDimensions(declared.width, declared.height)) return "unsupported_structure";
  try {
    // Loaded here rather than at the top: the native canvas backend stays off
    // every module that imports this one until an image actually arrives.
    const { loadImage } = await import("@napi-rs/canvas");
    const image = await loadImage(bytes);
    return image.width === declared.width && image.height === declared.height ? "supported_structure" : "unsupported_structure";
  } catch {
    return "unsupported_structure";
  }
}

/** Whether pdf.js refused because the file needs a password it was not given. */
function isPasswordRequired(error: unknown): boolean {
  return (error as { name?: unknown } | null)?.name === "PasswordException";
}

/**
 * Whether the cross-reference section startxref points at declares no more
 * entries than the cap. pdf.js loops over every declared entry on this
 * thread, where the time budget cannot interrupt it, and an xref stream's
 * entries can take no bytes at all, so a tiny file can declare billions. Only
 * a declared count over the cap refuses the file: with no readable startxref
 * pdf.js rebuilds the table by scanning the file, which its size bounds.
 */
function hasPdfIndexBudget(bytes: Buffer): boolean {
  // pdf.js takes the last startxref anywhere in the file, %%EOF or not.
  const keyword = bytes.lastIndexOf("startxref");
  if (keyword < 0) return true;
  const offset = Number(bytes.subarray(keyword + 9, keyword + 64).toString("latin1").match(/^\s*(\d+)/u)?.[1]);
  if (!Number.isSafeInteger(offset) || offset >= bytes.length) return true;
  const head = bytes.subarray(offset, offset + 64).toString("latin1");
  if (/^\s*xref(?:\s|$)/u.test(head)) {
    const trailer = bytes.indexOf("trailer", offset);
    const table = bytes.subarray(offset, trailer < 0 ? bytes.length : trailer).toString("latin1");
    const subsectionCounts = table.match(/^\s*\d+\s+(\d+)\s*$/gmu) ?? [];
    const total = subsectionCounts.reduce((sum, line) => sum + Number(line.match(/\d+\s*$/u)?.[0] ?? 0), 0);
    return total <= MAX_PDF_XREF_ENTRIES;
  }
  if (!/^\s*\d+\s+\d+\s+obj\b/u.test(head)) return true;
  // The dictionary runs to the stream keyword, so a nested << >> such as
  // /DecodeParms cannot end it early; #xx escapes are decoded as pdf.js does.
  const streamKeyword = bytes.indexOf("stream", offset);
  const dictionary = bytes.subarray(offset, streamKeyword < 0 ? bytes.length : streamKeyword).toString("latin1")
    .replace(/#([0-9A-Fa-f]{2})/gu, (_, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)));
  const index = dictionary.match(/\/Index\s*\[([^\]]*)\]/u)?.[1]?.trim().split(/\s+/u).map(Number);
  const total = index
    ? index.reduce((sum, value, position) => sum + (position % 2 === 1 ? value : 0), 0)
    : Number(dictionary.match(/\/Size\s+([+-]?\d+)/u)?.[1]);
  return !(total > MAX_PDF_XREF_ENTRIES);
}

/**
 * Pattern E for PDFs (ADR-0033): pdf.js, the library that draws the file,
 * opens it with no password, within the page cap and the time budget, and
 * finds page one. Owner-password-only files open (pdf.js decrypts them
 * itself); a file that needs a password to open is refused, because nothing
 * in Orbit could show, read or scan it. Nothing is refused for what the file
 * contains: the renderer runs none of it.
 */
async function classifyPdfStructure(bytes: Buffer): Promise<DocumentStructureReason> {
  // A declared entry count pdf.js would loop over on this thread, bounded
  // before it is opened (ADR-0033 item 3 resource limit).
  if (!hasPdfIndexBudget(bytes)) return "unsupported_structure";
  let loadingTask: ReturnType<typeof getDocument> | undefined;
  let budgetTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    loadingTask = getDocument({
      ...PDF_STRUCTURE_PARSER_OPTIONS,
      data: new Uint8Array(bytes),
    });
    const opening = (async (): Promise<DocumentStructureReason> => {
      const pdf = await loadingTask!.promise;
      if (pdf.numPages < 1 || pdf.numPages > PDF_STRUCTURE_MAX_PAGES) return "unsupported_structure";
      await pdf.getPage(1);
      return "supported_structure";
    })();
    const budget = new Promise<never>((_, reject) => {
      budgetTimer = setTimeout(() => reject(new Error("pdf_inspection_budget_exceeded")), PDF_STRUCTURE_INSPECTION_BUDGET_MS);
    });
    return await Promise.race([opening, budget]);
  } catch (error) {
    return isPasswordRequired(error) ? "password_required" : "unsupported_structure";
  } finally {
    if (budgetTimer) clearTimeout(budgetTimer);
    if (loadingTask) await loadingTask.destroy().catch(() => undefined);
  }
}

/** Identifies the deliberately narrow initial document set from magic bytes. */
export function detectDocumentMediaType(bytes: Buffer): SupportedDocumentMediaType {
  if (bytes.length >= 5 && bytes.subarray(0, 5).toString("ascii") === "%PDF-") return "application/pdf";
  if (bytes.length >= 3 && startsWith(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (bytes.length >= 8 && startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  throw new AppError("document_type_unsupported", "Choose a PDF, JPEG, or PNG document", 415);
}

export type DocumentStructureReason = "supported_structure" | "unsupported_structure" | "password_required";

/** Whether the file is one Orbit can open and show: the renderer opens it and finds a page (ADR-0033). Call only after the malware scan has passed. */
export async function classifyDocumentStructure(bytes: Buffer, mediaType: SupportedDocumentMediaType): Promise<DocumentStructureReason> {
  if (mediaType === "application/pdf") return classifyPdfStructure(bytes);
  return classifyImageStructure(bytes, mediaType);
}

/** True when `classifyDocumentStructure` finds a file Orbit can open and show. */
export async function validateSupportedDocumentStructure(bytes: Buffer, mediaType: SupportedDocumentMediaType): Promise<boolean> {
  return (await classifyDocumentStructure(bytes, mediaType)) === "supported_structure";
}

export function normalizedDocumentFilename(input: string, mediaType: SupportedDocumentMediaType): string {
  const leaf = basename(input.replaceAll("\\", "/"))
    .normalize("NFKC")
    .replace(/[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff<>]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
  const fallback = `document${mediaExtensions[mediaType]}`;
  const candidate = leaf || fallback;
  const characters = Array.from(candidate);
  let result = "";
  for (const character of characters) {
    if (Buffer.byteLength(result + character, "utf8") > 180) break;
    result += character;
  }
  return result || fallback;
}
