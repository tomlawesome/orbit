import { basename } from "node:path";
import { AppError } from "@/lib/app-error";
import { type DocumentFileOnDisk, inspectImageInSandbox, inspectPdfStructureInSandbox } from "@/server/documents/pdf-structure-sandbox";

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
/**
 * The most pages a PDF may have (#1436, owner 2026-11-07): poppler opens a
 * thousand pages in 19 MiB, so the cap bounds kept previews and the
 * background drawer's work per document (#1433), not memory.
 */
export const PDF_STRUCTURE_MAX_PAGES = 100;

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
export function declaredImageDimensions(bytes: Buffer, mediaType: "image/jpeg" | "image/png"): { width: number; height: number } | undefined {
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

/** The header's dimensions when they are within the pixel and edge caps, else undefined: the cheap first fence, and the size the child must find (pattern D). */
export function declaredImageDimensionsWithinCap(bytes: Buffer, mediaType: "image/jpeg" | "image/png"): { width: number; height: number } | undefined {
  const declared = declaredImageDimensions(bytes, mediaType);
  return declared && safeImageDimensions(declared.width, declared.height) ? declared : undefined;
}

/** Pattern E for images: the header is within the cap and the decoder, in the sandbox child, reads the image at that size (#1572). */
async function classifyImageStructure(bytes: Buffer, mediaType: "image/jpeg" | "image/png", file?: DocumentFileOnDisk): Promise<DocumentStructureReason> {
  const declared = declaredImageDimensionsWithinCap(bytes, mediaType);
  if (!declared) return "unsupported_structure";
  return inspectImageInSandbox(bytes, mediaType, declared, file);
}

/**
 * Pattern E for PDFs (ADR-0033): poppler, the library that draws the file
 * (#1436, ADR-0046), opens it with no password, within the page cap and the
 * time budget, and finds page one (`pdfinfo -f 1 -l 1`). Owner-password-only
 * files open (poppler decrypts them itself); a file that needs a password to
 * open is refused, because nothing in Orbit could show, read or scan it.
 * Nothing is refused for what the file contains: the renderer runs none of
 * it. The open runs in a memory-capped, killable child process (ADR-0038,
 * pdf-structure-sandbox.ts), never in the server's process. A PDF held only
 * in memory is handed to the child through an unlinked file in the
 * quarantine (the sandbox writes it).
 */
async function classifyPdfStructure(bytes: Buffer, file?: DocumentFileOnDisk): Promise<DocumentStructureVerdict> {
  return inspectPdfStructureInSandbox(file ?? { bytes });
}

/** Identifies the deliberately narrow initial document set from magic bytes. */
export function detectDocumentMediaType(bytes: Buffer): SupportedDocumentMediaType {
  if (bytes.length >= 5 && bytes.subarray(0, 5).toString("ascii") === "%PDF-") return "application/pdf";
  if (bytes.length >= 3 && startsWith(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (bytes.length >= 8 && startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  throw new AppError("document_type_unsupported", "Choose a PDF, JPEG, or PNG document", 415);
}

export type DocumentStructureReason =
  | "supported_structure"
  | "unsupported_structure"
  | "password_required"
  /** The check reached no verdict: the sandbox stopped its child, could not start it, or could not open the file; the file is neither accepted nor refused. */
  | "structure_check_unavailable";

/**
 * The check's verdict (#1436, design D3): the reason, and for a supported
 * file its page count (1 for an image), which the document row keeps.
 */
export type DocumentStructureVerdict = { reason: DocumentStructureReason; pageCount?: number };

/** Whether the file is one Orbit can open and show: the renderer opens it and finds a page (ADR-0033). Call only after the malware scan has passed. */
export async function classifyDocumentStructure(bytes: Buffer, mediaType: SupportedDocumentMediaType, file?: DocumentFileOnDisk): Promise<DocumentStructureVerdict> {
  if (mediaType === "application/pdf") return classifyPdfStructure(bytes, file);
  const reason = await classifyImageStructure(bytes, mediaType, file);
  return reason === "supported_structure" ? { reason, pageCount: 1 } : { reason };
}

/** True when `classifyDocumentStructure` finds a file Orbit can open and show. */
export async function validateSupportedDocumentStructure(bytes: Buffer, mediaType: SupportedDocumentMediaType, file?: DocumentFileOnDisk): Promise<boolean> {
  return (await classifyDocumentStructure(bytes, mediaType, file)).reason === "supported_structure";
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
