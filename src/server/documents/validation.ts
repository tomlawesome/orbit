import { basename } from "node:path";
import { AppError } from "@/lib/app-error";

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
const unsafePdfFeature = /\/(?:EmbeddedFile|Filespec|JavaScript|JS|Launch|RichMedia|XFA)\b/u;
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

function validateClassicPdfXref(xrefSection: string, content: string): boolean {
  if (!/^xref(?:\r?\n|\s)/u.test(xrefSection)) return false;
  const trailerIndex = xrefSection.indexOf("trailer");
  if (trailerIndex < 0) return false;
  const lines = xrefSection.slice(4, trailerIndex)
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
  const objectRanges: Array<{ first: number; count: number }> = [];
  const inUseObjects = new Set<number>();
  let cursor = 0;
  let totalEntries = 0;
  let lastObjectEnd = 0;
  while (cursor < lines.length) {
    const subsection = lines[cursor++].match(/^(\d+)\s+(\d+)$/u);
    if (!subsection) return false;
    const first = Number(subsection[1]);
    const count = Number(subsection[2]);
    if (!Number.isSafeInteger(first)
      || !Number.isSafeInteger(count)
      || count < 1
      || first + count > MAX_PDF_XREF_ENTRIES
      || totalEntries + count > MAX_PDF_XREF_ENTRIES
      || first < lastObjectEnd
      || cursor + count > lines.length) return false;
    objectRanges.push({ first, count });
    totalEntries += count;
    lastObjectEnd = first + count;
    for (let entryIndex = 0; entryIndex < count; entryIndex += 1) {
      const entry = lines[cursor++].match(/^(\d{10})\s(\d{5})\s([fn])$/u);
      if (!entry) return false;
      const offset = Number(entry[1]);
      const generation = Number(entry[2]);
      const objectNumber = first + entryIndex;
      if (entry[3] === "n") {
        if (objectNumber === 0 || offset < 1 || offset >= content.length) return false;
        const objectHeader = content.slice(offset, offset + 64).match(/^(\d+)\s+(\d+)\s+obj\b/u);
        if (!objectHeader
          || Number(objectHeader[1]) !== objectNumber
          || Number(objectHeader[2]) !== generation) return false;
        inUseObjects.add(objectNumber);
      }
    }
  }
  if (totalEntries < 2) return false;
  const trailer = xrefSection.slice(trailerIndex);
  const root = trailer.match(/\/Root\s+(\d+)\s+\d+\s+R\b/u);
  const size = Number(trailer.match(/\/Size\s+(\d+)\b/u)?.[1]);
  if (!root
    || !Number.isSafeInteger(size)
    || size < 2
    || size > MAX_PDF_XREF_ENTRIES
    || objectRanges.some(({ first, count }) => first + count > size)) return false;
  const rootObject = Number(root[1]);
  return rootObject < size && inUseObjects.has(rootObject);
}

function validatePdfXrefStream(xrefHeader: string, byteLength: number): boolean {
  const object = xrefHeader.match(
    /^(\d+)\s+(\d+)\s+obj\s*<<([\s\S]*?)>>\s*stream\r?\n/u,
  );
  if (!object) return false;
  const dictionary = object[3];
  const size = Number(dictionary.match(/\/Size\s+(\d+)\b/u)?.[1]);
  const length = Number(dictionary.match(/\/Length\s+(\d+)\b/u)?.[1]);
  const widths = dictionary.match(/\/W\s*\[\s*(\d+)\s+(\d+)\s+(\d+)\s*\]/u);
  if (!/\/Type\s*\/XRef\b/u.test(dictionary)
    || !/\/Root\s+\d+\s+\d+\s+R\b/u.test(dictionary)
    || !Number.isSafeInteger(size)
    || size < 2
    || size > MAX_PDF_XREF_ENTRIES
    || !Number.isSafeInteger(length)
    || length < 1
    || length >= byteLength
    || !widths) return false;
  const widthTotal = Number(widths[1]) + Number(widths[2]) + Number(widths[3]);
  if (!Number.isSafeInteger(widthTotal) || widthTotal < 1 || widthTotal > 24) return false;
  const index = dictionary.match(/\/Index\s*\[([^\]]+)\]/u)?.[1]
    .trim()
    .split(/\s+/u)
    .map(Number);
  if (index && (index.length < 2
    || index.length % 2 !== 0
    || index.some((value) => !Number.isSafeInteger(value) || value < 0)
    || index.some((value, position) => position % 2 === 0 && value >= size)
    || index.some((value, position) => position % 2 === 1 && value < 1))) return false;
  if (/\/Filter\b/u.test(dictionary) && !/\/Filter\s*\/FlateDecode\b/u.test(dictionary)) return false;
  const streamEnd = object[0].length + length;
  return streamEnd < xrefHeader.length
    && /^(?:\r?\n)?endstream\b/u.test(xrefHeader.slice(streamEnd));
}

/** Identifies the deliberately narrow initial document set from magic bytes. */
export function detectDocumentMediaType(bytes: Buffer): SupportedDocumentMediaType {
  if (bytes.length >= 5 && bytes.subarray(0, 5).toString("ascii") === "%PDF-") return "application/pdf";
  if (bytes.length >= 3 && startsWith(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (bytes.length >= 8 && startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  throw new AppError("document_type_unsupported", "Choose a PDF, JPEG, or PNG document", 415);
}

export type DocumentStructureReason = "supported_structure" | "unsupported_structure" | "prohibited_content";

/** Classifies document structure with explicit reason, without widening compatibility. */
export function classifyDocumentStructure(bytes: Buffer, mediaType: SupportedDocumentMediaType): DocumentStructureReason {
  if (mediaType === "application/pdf") {
    const tail = bytes.subarray(Math.max(0, bytes.length - 1_024)).toString("latin1");
    const content = bytes.toString("latin1");
    const startXref = tail.match(/startxref\s+(\d+)\s+%%EOF[\x00\t\n\f\r ]*$/u);
    const xrefOffset = startXref ? Number(startXref[1]) : Number.NaN;
    const xrefSection = Number.isSafeInteger(xrefOffset) && xrefOffset >= 0 && xrefOffset < bytes.length
      ? content.slice(xrefOffset)
      : "";
    const hasClassicXref = validateClassicPdfXref(xrefSection, content);
    const hasXrefStream = validatePdfXrefStream(xrefSection, bytes.length);
    const hasProhibitedFeature = unsafePdfFeature.test(content);
    const isValidStructure = bytes.length >= 24
      && /^%PDF-[12]\.\d/u.test(bytes.subarray(0, 8).toString("ascii"))
      && !bytes.subarray(0, 512).includes(0)
      && Boolean(startXref)
      && /\bobj\b/u.test(content)
      && (hasClassicXref || hasXrefStream);

    if (hasProhibitedFeature) return "prohibited_content";
    if (!isValidStructure) return "unsupported_structure";
    return "supported_structure";
  }
  if (mediaType === "image/jpeg") {
    return validateJpegStructure(bytes) ? "supported_structure" : "unsupported_structure";
  }
  return validatePngStructure(bytes) ? "supported_structure" : "unsupported_structure";
}

/** Performs cheap bounded container checks without rendering or decompressing. */
export function validateSupportedDocumentStructure(bytes: Buffer, mediaType: SupportedDocumentMediaType): boolean {
  return classifyDocumentStructure(bytes, mediaType) === "supported_structure";
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
