import { basename } from "node:path";
import { AppError } from "@/lib/app-error";
import type { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { inspectPdfStructureInSandbox } from "@/server/documents/pdf-structure-sandbox";

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
 * and the page renderer alike, both in the sandbox worker (ADR-0033 pattern
 * C, ADR-0038): no XFA, no pdf.js worker, no network or range fetching, no
 * system or browser fonts, no WebAssembly or platform image decoders, and
 * errors stop the parse. Nothing a PDF carries can run: pdf.js runs document
 * scripts only through the viewer's annotation layer and scripting manager,
 * which Orbit never builds.
 */
export const PDF_STRUCTURE_PARSER_OPTIONS = Object.freeze({
  disableAutoFetch: true,
  disableFontFace: true,
  disableRange: true,
  disableStream: true,
  enableXfa: false,
  isImageDecoderSupported: false,
  isOffscreenCanvasSupported: false,
  // The same pixel cap image uploads already hold, applied to images a PDF
  // carries; with stopAtErrors an over-cap image fails the page instead of
  // being decoded.
  maxImageSize: MAX_IMAGE_PIXELS,
  stopAtErrors: true,
  useSystemFonts: false,
  useWasm: false,
  useWorkerFetch: false,
  // pdf.js's VerbosityLevel.ERRORS, written as its value: this module only
  // names pdf.js's types, so the server never loads the reader (#1427).
  verbosity: 0,
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

const PDF_DELIMITERS = new Set([..."()<>[]{}/%"]);
const PDF_WHITESPACE = new Set([..."\0\t\n\f\r "]);
const PDF_NUMBER = /^[+-]?(?:\d+\.?\d*|\.\d+)$/u;
const MAX_PDF_XREF_SECTIONS = 32;
const MAX_PDF_NESTING = 64;

type PdfValue = number | string | PdfValue[] | Map<string, PdfValue> | { ref: number } | null;

/** Thrown for any syntax the budget check cannot read; the caller refuses the file. */
class PdfSyntaxError extends Error {}

/**
 * Just enough of pdf.js's lexer to read a cross-reference dictionary: names
 * (with #xx escapes), numbers, delimiters and words, with strings and
 * comments skipped so a `<<` inside them does not count.
 */
class PdfLexer {
  constructor(private readonly text: string, public position: number) {}

  next(): string | undefined {
    const { text } = this;
    while (this.position < text.length) {
      const char = text[this.position]!;
      if (PDF_WHITESPACE.has(char)) this.position += 1;
      else if (char === "%") while (this.position < text.length && text[this.position] !== "\n" && text[this.position] !== "\r") this.position += 1;
      else break;
    }
    if (this.position >= text.length) return undefined;
    const start = this.position;
    const char = text[start]!;
    if ((char === "<" || char === ">") && text[start + 1] === char) {
      this.position += 2;
      return char + char;
    }
    if (char === "<") {
      const end = text.indexOf(">", start);
      if (end < 0) throw new PdfSyntaxError("unterminated hex string");
      this.position = end + 1;
      return "<>";
    }
    if (char === "(") {
      let depth = 0;
      for (; this.position < text.length; this.position += 1) {
        const current = text[this.position];
        if (current === "\\") this.position += 1;
        else if (current === "(") depth += 1;
        else if (current === ")" && --depth === 0) {
          this.position += 1;
          return "()";
        }
      }
      throw new PdfSyntaxError("unterminated string");
    }
    this.position += 1;
    if (char !== "/" && PDF_DELIMITERS.has(char)) return char;
    while (this.position < text.length && !PDF_WHITESPACE.has(text[this.position]!) && !PDF_DELIMITERS.has(text[this.position]!)) this.position += 1;
    const word = text.slice(start, this.position);
    return char === "/" ? word.replace(/#([0-9A-Fa-f]{2})/gu, (_, hex: string) => String.fromCharCode(Number.parseInt(hex, 16))) : word;
  }
}

function readPdfValue(lexer: PdfLexer, token: string | undefined, depth: number): PdfValue {
  if (token === undefined || depth > MAX_PDF_NESTING) throw new PdfSyntaxError("unreadable value");
  if (token === "<<") return readPdfDictionary(lexer, depth + 1);
  if (token === "[") {
    const items: PdfValue[] = [];
    for (let item = lexer.next(); item !== "]"; item = lexer.next()) items.push(readPdfValue(lexer, item, depth + 1));
    return items;
  }
  if (token === ">>" || token === "]") throw new PdfSyntaxError("unbalanced delimiter");
  if (token.startsWith("/")) return token;
  return PDF_NUMBER.test(token) ? Number(token) : null;
}

/** A dictionary's own entries; nested dictionaries are values, so their keys never reach the top level. */
function readPdfDictionary(lexer: PdfLexer, depth: number): Map<string, PdfValue> {
  const entries = new Map<string, PdfValue>();
  for (let key = lexer.next(); key !== ">>"; key = lexer.next()) {
    if (key === undefined || !key.startsWith("/")) throw new PdfSyntaxError("dictionary key is not a name");
    let value = readPdfValue(lexer, lexer.next(), depth);
    if (typeof value === "number") {
      const position = lexer.position;
      const generation = lexer.next();
      if (generation !== undefined && PDF_NUMBER.test(generation) && lexer.next() === "R") value = { ref: value };
      else lexer.position = position;
    }
    entries.set(key, value);
  }
  return entries;
}

function isPdfCount(value: PdfValue | undefined): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isPdfInteger(token: string | undefined): boolean {
  return token !== undefined && PDF_NUMBER.test(token) && Number.isInteger(Number(token));
}

/**
 * Where pdf.js starts reading a file it takes as linearized, which it does
 * when the first object is a dictionary with a positive /Linearized and an /L
 * equal to the file length (its Linearization.create). It then ignores
 * startxref and starts after the first endobj in the first 1,024 bytes,
 * skipping whitespace, or at 0 if there is none. The hint and page entries
 * pdf.js also requires are not checked: they only narrow its rule. Anything
 * this cannot read means no extra root, so the check never refuses by itself.
 */
function linearizedXrefOffset(bytes: Buffer, text: string): number | undefined {
  try {
    const lexer = new PdfLexer(text, 0);
    if (!PDF_NUMBER.test(lexer.next() ?? "") || !PDF_NUMBER.test(lexer.next() ?? "") || lexer.next() !== "obj" || lexer.next() !== "<<") return undefined;
    const dictionary = readPdfDictionary(lexer, 1);
    const linearized = dictionary.get("/Linearized");
    if (typeof linearized !== "number" || linearized <= 0 || dictionary.get("/L") !== bytes.length) return undefined;
  } catch (error) {
    if (error instanceof PdfSyntaxError) return undefined;
    throw error;
  }
  const endobj = bytes.subarray(0, 1024).indexOf("endobj");
  if (endobj < 0) return 0;
  let offset = endobj + "endobj".length;
  while (offset < text.length && " \t\n\r".includes(text[offset]!)) offset += 1;
  return offset;
}

/**
 * Where pdf.js's recovery scan (its XRef.indexObjects) reads a
 * cross-reference stream: the start of every object whose text, up to the
 * next endobj, object header, xref or trailer, holds `/XRef` followed by a
 * byte below 64. pdf.js scans the whole file this way whenever it cannot use
 * the sections it was pointed at, and reads each one found, with its /Prev
 * chain, as a fresh walk. This steps through the file token by token exactly
 * as that scan does, once and in order, so it stays linear in the file's
 * length. More starts than the section cap is null: the caller refuses.
 */
function recoveryXrefOffsets(bytes: Buffer, text: string): number[] | null {
  const offsets: number[] = [];
  // pdf.js's own patterns for where an object's text, or a trailer's, ends.
  const objectEnd = /\b(?:endobj|\d+\s+\d+\s+obj|xref|trailer\s*<<)\b/gu;
  const trailerEnd = /\b(?:startxref|\d+\s+\d+\s+obj)\b/gu;
  const isLineEnd = (byte: number | undefined): boolean => byte === 0x0a || byte === 0x0d;
  let position = 0;
  let tag = -1;
  while (position < bytes.length) {
    const byte = bytes[position]!;
    if (byte === 0x09 || byte === 0x20 || isLineEnd(byte)) {
      position += 1;
      continue;
    }
    if (byte === 0x25) {
      while (position < bytes.length && !isLineEnd(bytes[position])) position += 1;
      continue;
    }
    // A token runs to a line end or "<"; pdf.js's readToken never takes the file's last byte.
    let end = position;
    while (end < bytes.length - 1 && !isLineEnd(bytes[end]) && bytes[end] !== 0x3c) end += 1;
    // Only a token starting x, t or a digit can be one the scan acts on.
    const token = byte === 0x78 || byte === 0x74 || (byte >= 0x30 && byte <= 0x39) ? text.slice(position, end) : "";
    if (!token) {
      position = end + 1;
    } else if (/^xref(?:\s|$)/u.test(token)) {
      const trailer = bytes.indexOf("trailer", position);
      position = trailer < 0 ? bytes.length : trailer;
      const startxref = bytes.indexOf("startxref", position);
      position = startxref < 0 ? bytes.length : startxref;
    } else if (/^\d+\s+\d+\s+obj\b/u.test(token)) {
      objectEnd.lastIndex = end;
      const match = objectEnd.exec(text);
      const contentEnd = Math.min(bytes.length, !match ? bytes.length : match[0] === "endobj" ? objectEnd.lastIndex + 1 : match.index);
      // Positions only grow, so the next "/XRef" is searched for again only once passed.
      if (tag < position) {
        tag = bytes.indexOf("/XRef", position);
        if (tag < 0) tag = bytes.length;
      }
      if (tag + 5 < contentEnd && bytes[tag + 5]! < 64) {
        offsets.push(position);
        if (offsets.length > MAX_PDF_XREF_SECTIONS) return null;
      }
      position = Math.max(contentEnd, end + 1);
    } else if (/^trailer(?:\s|$)/u.test(token)) {
      trailerEnd.lastIndex = end;
      const match = trailerEnd.exec(text);
      position = !match ? bytes.length : match[0] === "startxref" ? trailerEnd.lastIndex + 1 : match.index;
    } else {
      position = end + 1;
    }
  }
  return offsets;
}

interface PdfXrefSection {
  /** Entries pdf.js loops over reading it; a /Size over the cap counts as over the cap. */
  entries: number;
  previous?: number;
  stream?: number;
}

/**
 * One cross-reference section as pdf.js's readXRef reads it: a classic table,
 * whose subsection headers are read with the lexer (so a comment cannot hide
 * one) and whose entries must each be two integers and f or n, then its
 * trailer; or an `N G obj` cross-reference stream, counted from /Index or,
 * without one, /Size. pdf.js reads a section only where the first token is
 * xref or a number; anywhere else it reads nothing and this returns
 * undefined. Past that first token, anything this cannot read throws, and the
 * caller refuses the file.
 */
function readPdfXrefSection(text: string, offset: number): PdfXrefSection | undefined {
  const lexer = new PdfLexer(text, offset);
  let first: string | undefined;
  try {
    first = lexer.next();
  } catch {
    return undefined;
  }
  if (first !== "xref" && !/^[\d+.-]/u.test(first ?? "")) return undefined;
  let entries = 0;
  let dictionary: Map<string, PdfValue>;
  if (first === "xref") {
    for (let start = lexer.next(); start !== "trailer"; start = lexer.next()) {
      const countToken = lexer.next();
      const count = Number(countToken);
      if (!isPdfInteger(start) || !isPdfInteger(countToken) || !isPdfCount(count)) throw new PdfSyntaxError("unreadable subsection header");
      entries += count;
      if (entries > MAX_PDF_XREF_ENTRIES) return { entries };
      for (let entry = 0; entry < count; entry += 1) {
        const fields = [lexer.next(), lexer.next(), lexer.next()];
        if (!isPdfInteger(fields[0]) || !isPdfInteger(fields[1]) || (fields[2] !== "f" && fields[2] !== "n")) throw new PdfSyntaxError("unreadable entry");
      }
    }
    if (lexer.next() !== "<<") throw new PdfSyntaxError("no trailer dictionary");
    dictionary = readPdfDictionary(lexer, 1);
  } else {
    if (!PDF_NUMBER.test(first!) || !PDF_NUMBER.test(lexer.next() ?? "") || lexer.next() !== "obj" || lexer.next() !== "<<") throw new PdfSyntaxError("not a cross-reference section");
    dictionary = readPdfDictionary(lexer, 1);
    const index = dictionary.get("/Index");
    if (index === undefined) {
      const size = dictionary.get("/Size");
      if (!isPdfCount(size)) throw new PdfSyntaxError("unreadable /Size");
      entries = size;
    } else {
      if (!Array.isArray(index) || index.length % 2 !== 0 || !index.every(isPdfCount)) throw new PdfSyntaxError("unreadable /Index");
      entries = index.reduce<number>((sum, value, position) => sum + (position % 2 === 1 ? value as number : 0), 0);
    }
  }
  const section: PdfXrefSection = { entries };
  // /Size is checked on its own even where /Index governs the loop.
  const size = dictionary.get("/Size");
  if (size !== undefined && !(isPdfCount(size) && size <= MAX_PDF_XREF_ENTRIES)) section.entries = Number.POSITIVE_INFINITY;
  const previous = dictionary.get("/Prev");
  if (typeof previous === "number") section.previous = previous;
  // pdf.js follows a /Prev reference to the offset of its object number.
  else if (previous && typeof previous === "object" && "ref" in previous) section.previous = previous.ref;
  const stream = dictionary.get("/XRefStm");
  if (first === "xref" && typeof stream === "number") section.stream = stream;
  return section;
}

/**
 * Whether every cross-reference section pdf.js could read declares, in all,
 * no more entries than the cap. pdf.js loops over every declared entry on
 * this thread, where the time budget cannot interrupt it, and an xref
 * stream's entries can take no bytes at all, so a tiny file can declare
 * billions. pdf.js reaches sections from three places, and the check walks
 * all three as its readXRef walks them: the last startxref; for a file it
 * takes as linearized, the section after the first endobj; and, when it
 * cannot use those (a startxref that is missing, past the end or pointing at
 * something unreadable, or a table that does not lead to the pages), its
 * recovery scan, which reads every cross-reference stream in the file, each
 * as a fresh walk, the first together with the root again. From each it follows /Prev and a classic trailer's
 * /XRefStm, from the top-level dictionary only, and a section a walk has
 * already read is skipped, as pdf.js skips it. Entries count every time a
 * section is read, because pdf.js loops over them every time. The file is
 * refused when the total passes the cap, a count is not a non-negative
 * integer, there are more distinct places to read than the section cap, or a
 * section any of these points at cannot be read: what this check cannot read
 * it cannot bound. Only an offset outside the file, or one whose first token
 * is neither xref nor a number, is skipped: pdf.js reads nothing there and
 * falls back to the scan, which is modelled.
 */
export function hasPdfIndexBudget(bytes: Buffer): boolean {
  const text = bytes.toString("latin1");
  const recovery = recoveryXrefOffsets(bytes, text);
  if (recovery === null) return false;
  const roots: number[] = [];
  const linearized = linearizedXrefOffset(bytes, text);
  if (linearized !== undefined) roots.push(linearized);
  // Otherwise pdf.js takes the last startxref anywhere in the file, %%EOF or
  // not; it is walked for a linearized file too, which costs one more section.
  const keyword = bytes.lastIndexOf("startxref");
  if (keyword >= 0) roots.push(Number(text.slice(keyword + 9, keyword + 64).match(/^\s*(\d+)/u)?.[1]));
  // Each place is read once, however many walks reach it; null is nothing to read.
  const sections = new Map<number, PdfXrefSection | null>();
  // pdf.js follows a given /XRefStm once per document, never one its scan found.
  const followedStreams = new Set<number>();
  let total = 0;
  const walk = (queue: number[]): boolean => {
    const visited = new Set<number>();
    for (let offset = queue.shift(); offset !== undefined; offset = queue.shift()) {
      if (!Number.isSafeInteger(offset) || offset < 0 || offset >= bytes.length || visited.has(offset)) continue;
      visited.add(offset);
      let section = sections.get(offset);
      if (section === undefined) {
        if (sections.size >= MAX_PDF_XREF_SECTIONS) return false;
        section = readPdfXrefSection(text, offset) ?? null;
        sections.set(offset, section);
      }
      if (!section) continue;
      total += section.entries;
      if (total > MAX_PDF_XREF_ENTRIES) return false;
      if (section.stream !== undefined && !followedStreams.has(section.stream)) {
        followedStreams.add(section.stream);
        queue.push(section.stream);
      }
      if (section.previous !== undefined) queue.push(section.previous);
    }
    return true;
  };
  try {
    if (!walk([...roots])) return false;
    for (const offset of recovery) followedStreams.add(offset);
    // Before scanning, pdf.js queues its root again, so the first walk reads it twice.
    return recovery.every((offset, position) => walk(position === 0 ? [...roots, offset] : [offset]));
  } catch (error) {
    if (error instanceof PdfSyntaxError) return false;
    throw error;
  }
}

/**
 * Pattern E for PDFs (ADR-0033): pdf.js, the library that draws the file,
 * opens it with no password, within the page cap and the time budget, and
 * finds page one. Owner-password-only files open (pdf.js decrypts them
 * itself); a file that needs a password to open is refused, because nothing
 * in Orbit could show, read or scan it. Nothing is refused for what the file
 * contains: the renderer runs none of it. The open runs in a memory-capped,
 * killable worker (ADR-0038, pdf-structure-sandbox.ts), never on this thread.
 */
async function classifyPdfStructure(bytes: Buffer): Promise<DocumentStructureReason> {
  // A cheap first fence: a declared entry count pdf.js would loop over,
  // refused before any worker starts (ADR-0033 item 3, as amended by ADR-0038).
  if (!hasPdfIndexBudget(bytes)) return "unsupported_structure";
  return inspectPdfStructureInSandbox(bytes);
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
