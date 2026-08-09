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
const MAX_PNG_CHUNKS = 4_096;
const MAX_PDF_XREF_ENTRIES = 1_250_000;
export const PDF_STRUCTURE_MAX_PAGES = 1_000;
export const PDF_STRUCTURE_INSPECTION_BUDGET_MS = 5_000;
type PdfStructureParserOptions = NonNullable<Parameters<typeof getDocument>[0]> & { isEvalSupported: false };
export const PDF_STRUCTURE_PARSER_OPTIONS = Object.freeze({
  disableAutoFetch: true,
  disableFontFace: true,
  disableRange: true,
  disableStream: true,
  enableScripting: false,
  enableXfa: true,
  isEvalSupported: false,
  isImageDecoderSupported: false,
  isOffscreenCanvasSupported: false,
  stopAtErrors: true,
  useSystemFonts: false,
  useWasm: false,
  useWorkerFetch: false,
  verbosity: VerbosityLevel.ERRORS,
}) as Readonly<PdfStructureParserOptions>;
const unsafePdfFeatures = new Set([
  "EmbeddedFile",
  "EmbeddedFiles",
  "Filespec",
  "JavaScript",
  "JS",
  "Launch",
  "RichMedia",
  "XFA",
]);
const unsafePdfActionValues = new Set(["JavaScript", "Launch", "RichMedia"]);
const crcTable = Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  for (let bit = 0; bit < 8; bit += 1) {
    crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return crc >>> 0;
});

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

function validateJpegStructure(bytes: Buffer): boolean {
  if (bytes.length < 10 || !startsWith(bytes, [0xff, 0xd8])) return false;
  let offset = 2;
  let sawFrame = false;
  let sawScan = false;
  let inScan = false;
  let frameMarker: number | undefined;
  const frameComponentIds = new Set<number>();

  while (offset < bytes.length) {
    if (inScan) {
      while (offset < bytes.length && bytes[offset] !== 0xff) offset += 1;
      if (offset >= bytes.length) return false;
      while (offset < bytes.length && bytes[offset] === 0xff) offset += 1;
      if (offset >= bytes.length) return false;
      const marker = bytes[offset];
      if (marker === 0x00 || (marker >= 0xd0 && marker <= 0xd7)) {
        offset += 1;
        continue;
      }
      offset -= 1;
      inScan = false;
    }

    if (bytes[offset] !== 0xff) return false;
    while (offset < bytes.length && bytes[offset] === 0xff) offset += 1;
    if (offset >= bytes.length) return false;
    const marker = bytes[offset++];
    if (marker === 0xd9) return sawFrame && sawScan && offset === bytes.length;
    if (marker === 0x01) continue;
    if (marker === 0xd8 || marker === 0x00 || (marker >= 0xd0 && marker <= 0xd7)) return false;
    if (offset + 2 > bytes.length) return false;
    const segmentLength = bytes.readUInt16BE(offset);
    if (segmentLength < 2 || offset + segmentLength > bytes.length) return false;
    const segmentStart = offset + 2;
    const segmentEnd = offset + segmentLength;
    const startOfFrameMarkers = [
      0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7,
      0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
    ];
    const isStartOfFrame = marker === 0xc0 || marker === 0xc2;
    if (startOfFrameMarkers.includes(marker) && !isStartOfFrame) return false;
    if (isStartOfFrame) {
      if (sawFrame || segmentLength < 11) return false;
      const precision = bytes[segmentStart];
      const height = bytes.readUInt16BE(segmentStart + 1);
      const width = bytes.readUInt16BE(segmentStart + 3);
      const components = bytes[segmentStart + 5];
      if (precision !== 8
        || !safeImageDimensions(width, height)
        || components < 1
        || components > 4
        || segmentLength !== 8 + (3 * components)) return false;
      let samplingBlocks = 0;
      for (let componentIndex = 0; componentIndex < components; componentIndex += 1) {
        const componentOffset = segmentStart + 6 + (componentIndex * 3);
        const componentId = bytes[componentOffset];
        const sampling = bytes[componentOffset + 1];
        const horizontalSampling = sampling >>> 4;
        const verticalSampling = sampling & 0x0f;
        if (componentId === 0
          || frameComponentIds.has(componentId)
          || horizontalSampling < 1
          || horizontalSampling > 4
          || verticalSampling < 1
          || verticalSampling > 4
          || bytes[componentOffset + 2] > 3) return false;
        frameComponentIds.add(componentId);
        samplingBlocks += horizontalSampling * verticalSampling;
      }
      if (samplingBlocks > 10) return false;
      frameMarker = marker;
      sawFrame = true;
    }
    if (marker === 0xda) {
      if (!sawFrame || segmentLength < 6) return false;
      const components = bytes[segmentStart];
      if (components < 1 || components > 4 || segmentLength !== 6 + (2 * components)) return false;
      const scanComponentIds = new Set<number>();
      for (let componentIndex = 0; componentIndex < components; componentIndex += 1) {
        const componentOffset = segmentStart + 1 + (componentIndex * 2);
        const componentId = bytes[componentOffset];
        const tables = bytes[componentOffset + 1];
        if (!frameComponentIds.has(componentId)
          || scanComponentIds.has(componentId)
          || (tables >>> 4) > 3
          || (tables & 0x0f) > 3) return false;
        scanComponentIds.add(componentId);
      }
      const spectralStart = bytes[segmentEnd - 3];
      const spectralEnd = bytes[segmentEnd - 2];
      const approximation = bytes[segmentEnd - 1];
      const approximationHigh = approximation >>> 4;
      const approximationLow = approximation & 0x0f;
      if (frameMarker === 0xc0) {
        if (spectralStart !== 0 || spectralEnd !== 63 || approximation !== 0) return false;
      } else if (spectralStart > spectralEnd
        || spectralEnd > 63
        || approximationHigh > 13
        || approximationLow > 13
        || (spectralStart > 0 && components !== 1)
        || (approximationHigh !== 0 && approximationHigh !== approximationLow + 1)) return false;
      sawScan = true;
      inScan = true;
    }
    offset = segmentEnd;
  }
  return false;
}

function crc32(bytes: Buffer, start: number, end: number): number {
  let crc = 0xffffffff;
  for (let index = start; index < end; index += 1) {
    crc = crcTable[(crc ^ bytes[index]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function validatePngStructure(bytes: Buffer): boolean {
  if (bytes.length < 45 || !startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return false;
  let offset = 8;
  let chunkCount = 0;
  let sawHeader = false;
  let sawImageData = false;
  let imageDataBytes = 0;
  let imageDataEnded = false;
  let paletteRequired = false;
  let sawPalette = false;
  let colourType = -1;
  let bitDepth = -1;
  while (offset + 12 <= bytes.length && chunkCount < MAX_PNG_CHUNKS) {
    const length = bytes.readUInt32BE(offset);
    const typeStart = offset + 4;
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    const chunkEnd = dataEnd + 4;
    if (dataEnd < dataStart || chunkEnd > bytes.length) return false;
    const type = bytes.subarray(typeStart, dataStart).toString("ascii");
    if (!/^[A-Za-z]{4}$/u.test(type)) return false;
    if (bytes.readUInt32BE(dataEnd) !== crc32(bytes, typeStart, dataEnd)) return false;
    if (!sawHeader) {
      if (type !== "IHDR" || length !== 13) return false;
      const width = bytes.readUInt32BE(dataStart);
      const height = bytes.readUInt32BE(dataStart + 4);
      bitDepth = bytes[dataStart + 8];
      colourType = bytes[dataStart + 9];
      const validBitDepths: Record<number, number[]> = {
        0: [1, 2, 4, 8, 16],
        2: [8, 16],
        3: [1, 2, 4, 8],
        4: [8, 16],
        6: [8, 16],
      };
      if (!safeImageDimensions(width, height)
        || !validBitDepths[colourType]?.includes(bitDepth)
        || bytes[dataStart + 10] !== 0
        || bytes[dataStart + 11] !== 0
        || ![0, 1].includes(bytes[dataStart + 12])) return false;
      paletteRequired = colourType === 3;
      sawHeader = true;
    } else if (type === "IHDR") {
      return false;
    }
    if (type === "PLTE") {
      if (sawPalette
        || sawImageData
        || [0, 4].includes(colourType)
        || length === 0
        || length % 3 !== 0
        || length > 768
        || (colourType === 3 && length / 3 > 2 ** bitDepth)) return false;
      sawPalette = true;
    }
    if (type === "IDAT") {
      if ((paletteRequired && !sawPalette) || imageDataEnded) return false;
      sawImageData = true;
      imageDataBytes += length;
    } else if (sawImageData && type !== "IEND") {
      imageDataEnded = true;
    }
    if (type === "IEND") return length === 0 && imageDataBytes > 0 && chunkEnd === bytes.length;
    if (type[0] === type[0]?.toUpperCase() && !["IHDR", "PLTE", "IDAT"].includes(type)) return false;
    offset = chunkEnd;
    chunkCount += 1;
  }
  return false;
}

function pdfNameValue(value: string): string {
  return value.replace(/#([0-9a-f]{2})/giu, (_, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)));
}

function isPdfDelimiter(value: number | undefined): boolean {
  return value === undefined || value === 0x00 || value === 0x09 || value === 0x0a
    || value === 0x0c || value === 0x0d || value === 0x20 || value === 0x28
    || value === 0x29 || value === 0x3c || value === 0x3e || value === 0x5b
    || value === 0x5d || value === 0x7b || value === 0x7d || value === 0x2f
    || value === 0x25;
}

function isPdfTokenAt(bytes: Buffer, offset: number, token: string): boolean {
  if (offset < 0 || offset + token.length > bytes.length) return false;
  if (bytes.subarray(offset, offset + token.length).toString("latin1") !== token) return false;
  return isPdfDelimiter(bytes[offset - 1]) && isPdfDelimiter(bytes[offset + token.length]);
}

function nextPdfToken(bytes: Buffer, offset: number, token: string): number {
  let candidate = bytes.indexOf(Buffer.from(token, "latin1"), offset);
  while (candidate >= 0 && !isPdfTokenAt(bytes, candidate, token)) {
    candidate = bytes.indexOf(Buffer.from(token, "latin1"), candidate + token.length);
  }
  return candidate;
}

/** Removes comments, literal/hex strings and stream payloads before inspecting PDF names. */
function structuralPdfText(bytes: Buffer): string {
  let output = "";
  let offset = 0;
  while (offset < bytes.length) {
    const value = bytes[offset];
    if (value === 0x25) {
      while (offset < bytes.length && bytes[offset] !== 0x0a && bytes[offset] !== 0x0d) offset += 1;
      continue;
    }
    if (value === 0x28) {
      offset += 1;
      let depth = 1;
      while (offset < bytes.length && depth > 0) {
        if (bytes[offset] === 0x5c) offset += 2;
        else if (bytes[offset] === 0x28) { depth += 1; offset += 1; }
        else if (bytes[offset] === 0x29) { depth -= 1; offset += 1; }
        else offset += 1;
      }
      continue;
    }
    if (value === 0x3c && bytes[offset + 1] === 0x3c) {
      output += "<<";
      offset += 2;
      continue;
    }
    if (value === 0x3c) {
      offset += 1;
      while (offset < bytes.length && bytes[offset] !== 0x3e) offset += 1;
      if (offset < bytes.length) offset += 1;
      continue;
    }
    if (isPdfTokenAt(bytes, offset, "stream")) {
      offset += 6;
      if (bytes[offset] === 0x0d && bytes[offset + 1] === 0x0a) offset += 2;
      else if (bytes[offset] === 0x0a || bytes[offset] === 0x0d) offset += 1;
      const endstream = nextPdfToken(bytes, offset, "endstream");
      if (endstream < 0) break;
      offset = endstream + 9;
      continue;
    }
    output += String.fromCharCode(value);
    offset += 1;
  }
  return output;
}

function hasUnsafePdfName(content: string): boolean {
  const names = content.match(/\/([!#$%&'*+\-./0-9:;<=>?@A-Z\\^_`a-z{|}~#]+)/gu) ?? [];
  return names.some((name) => unsafePdfFeatures.has(pdfNameValue(name.slice(1))));
}

function hasTooManyPdfObjects(content: string): boolean {
  const objectHeaders = content.match(/(?:^|[\r\n])\s*\d+\s+\d+\s+obj\b/gu)?.length ?? 0;
  return objectHeaders > MAX_PDF_XREF_ENTRIES;
}

function hasValidPdfStartxref(bytes: Buffer): boolean {
  const tail = bytes.subarray(Math.max(0, bytes.length - 1_024)).toString("latin1");
  const match = tail.match(/startxref\s+(\d+)\s+%%EOF[\x00\t\n\f\r ]*$/u);
  if (!match) return false;
  const offset = Number(match[1]);
  if (!Number.isSafeInteger(offset) || offset < 0 || offset >= bytes.length) return false;
  const target = bytes.subarray(offset, Math.min(bytes.length, offset + 512)).toString("latin1");
  return /^xref(?:\s|$)/u.test(target)
    || /^\d+\s+\d+\s+obj\s*<<[\s\S]*?\/Type\s*\/XRef\b/u.test(target);
}

function hasPdfIndexBudget(bytes: Buffer): boolean {
  const tail = bytes.subarray(Math.max(0, bytes.length - 1_024)).toString("latin1");
  const match = tail.match(/startxref\s+(\d+)\s+%%EOF[\x00\t\n\f\r ]*$/u);
  const offset = Number(match?.[1]);
  if (!Number.isSafeInteger(offset) || offset < 0 || offset >= bytes.length) return false;
  const target = bytes.subarray(offset).toString("latin1");
  if (/^xref(?:\s|$)/u.test(target)) {
    const trailerOffset = target.indexOf("trailer");
    if (trailerOffset < 0) return true;
    const subsectionCounts = target.slice(4, trailerOffset).match(/^\s*\d+\s+(\d+)\s*$/gmu) ?? [];
    const total = subsectionCounts.reduce((sum, line) => sum + Number(line.match(/\d+\s*$/u)?.[0] ?? 0), 0);
    return total <= MAX_PDF_XREF_ENTRIES;
  }
  const dictionary = target.match(/^\d+\s+\d+\s+obj\s*<<([\s\S]*?)>>/u)?.[1] ?? "";
  const size = Number(dictionary.match(/\/Size\s+(\d+)\b/u)?.[1]);
  const index = dictionary.match(/\/Index\s*\[([^\]]+)\]/u)?.[1]
    ?.trim()
    .split(/\s+/u)
    .map(Number);
  const total = index && index.length > 0 && index.length % 2 === 0
    ? index.reduce((sum, value, position) => sum + (position % 2 === 1 ? value : 0), 0)
    : size;
  return Number.isSafeInteger(total) && total >= 1 && total <= MAX_PDF_XREF_ENTRIES;
}

function hasEntries(value: unknown): boolean {
  if (value instanceof Map) return value.size > 0;
  return value !== null && typeof value === "object" && Object.keys(value).length > 0;
}

function hasUnsafePdfValue(value: unknown): boolean {
  if (typeof value === "string") return unsafePdfActionValues.has(value);
  if (Array.isArray(value)) return value.some((entry) => hasUnsafePdfValue(entry));
  if (value instanceof Map) {
    return Array.from(value.entries()).some(([key, entry]) => hasUnsafePdfValue(key) || hasUnsafePdfValue(entry));
  }
  if (value === null || typeof value !== "object") return false;
  return Object.entries(value).some(([key, entry]) => {
    const lowerKey = key.toLowerCase();
    return ((lowerKey === "actiontype" || lowerKey === "subtype" || lowerKey === "s" || lowerKey === "type")
      && typeof entry === "string" && unsafePdfActionValues.has(entry)) || hasUnsafePdfValue(entry);
  });
}

async function inspectParsedPdfFeatures(pdf: { numPages: number; getJSActions: () => Promise<unknown>; getAttachments: () => Promise<unknown>; getOpenAction: () => Promise<unknown>; getPage: (pageNumber: number) => Promise<{ getJSActions: () => Promise<unknown>; getAnnotations: (options: { intent: string }) => Promise<unknown>; getXfa: () => Promise<unknown> }> }): Promise<"unsupported_structure" | "prohibited_content" | undefined> {
  if (pdf.numPages < 1 || pdf.numPages > PDF_STRUCTURE_MAX_PAGES) return "unsupported_structure";
  if (hasEntries(await pdf.getJSActions()) || hasEntries(await pdf.getAttachments())) return "prohibited_content";
  if (hasUnsafePdfValue(await pdf.getOpenAction())) return "prohibited_content";
  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
    const page = await pdf.getPage(pageNumber);
    const xfa = await page.getXfa();
    if (hasEntries(await page.getJSActions())
      || hasUnsafePdfValue(await page.getAnnotations({ intent: "any" }))
      || (xfa !== null && xfa !== undefined)) return "prohibited_content";
  }
  return undefined;
}

/** Identifies the deliberately narrow initial document set from magic bytes. */
export function detectDocumentMediaType(bytes: Buffer): SupportedDocumentMediaType {
  if (bytes.length >= 5 && bytes.subarray(0, 5).toString("ascii") === "%PDF-") return "application/pdf";
  if (bytes.length >= 3 && startsWith(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (bytes.length >= 8 && startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  throw new AppError("document_type_unsupported", "Choose a PDF, JPEG, or PNG document", 415);
}

export type DocumentStructureReason = "supported_structure" | "unsupported_structure" | "prohibited_content";

/** Classifies document structure with a maintained bounded in-process parser. */
async function classifyPdfStructure(bytes: Buffer): Promise<DocumentStructureReason> {
  if (bytes.length < 24
    || !/^%PDF-[12]\.\d/u.test(bytes.subarray(0, 8).toString("ascii"))
    || !hasValidPdfStartxref(bytes)
    || !hasPdfIndexBudget(bytes)
    || hasTooManyPdfObjects(bytes.toString("latin1"))) return "unsupported_structure";

  const structuralContent = structuralPdfText(bytes);
  if (hasUnsafePdfName(structuralContent)) return "prohibited_content";

  let loadingTask: ReturnType<typeof getDocument> | undefined;
  let budgetTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    loadingTask = getDocument({
      ...PDF_STRUCTURE_PARSER_OPTIONS,
      data: new Uint8Array(bytes),
    });
    const inspection = (async (): Promise<DocumentStructureReason> => {
      const pdf = await loadingTask!.promise;
      return (await inspectParsedPdfFeatures(pdf)) ?? "supported_structure";
    })();
    const budget = new Promise<never>((_, reject) => {
      budgetTimer = setTimeout(() => reject(new Error("pdf_inspection_budget_exceeded")), PDF_STRUCTURE_INSPECTION_BUDGET_MS);
    });
    return await Promise.race([inspection, budget]);
  } catch {
    return "unsupported_structure";
  } finally {
    if (budgetTimer) clearTimeout(budgetTimer);
    if (loadingTask) await loadingTask.destroy().catch(() => undefined);
  }
}

/** Classifies document structure with explicit reason and a bounded in-process parser. */
export async function classifyDocumentStructure(bytes: Buffer, mediaType: SupportedDocumentMediaType): Promise<DocumentStructureReason> {
  if (mediaType === "application/pdf") {
    return classifyPdfStructure(bytes);
  }
  if (mediaType === "image/jpeg") {
    return validateJpegStructure(bytes) ? "supported_structure" : "unsupported_structure";
  }
  return validatePngStructure(bytes) ? "supported_structure" : "unsupported_structure";
}

/** Performs bounded container checks without rendering or executing document content. */
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
