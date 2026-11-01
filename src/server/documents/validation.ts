import { basename } from "node:path";
import { AppError } from "@/lib/app-error";
import type { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
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
 * and the page renderer alike, both in a sandbox child process (ADR-0033 pattern
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

/* The check reads the file as bytes: a latin1 string maps byte for byte, so
   every rule below is the byte the string's character stood for. */
const isPdfWhitespace = (byte: number): boolean => byte === 0x00 || byte === 0x09 || byte === 0x0a || byte === 0x0c || byte === 0x0d || byte === 0x20;
const isPdfDelimiter = (byte: number): boolean =>
  byte === 0x28 || byte === 0x29 || byte === 0x3c || byte === 0x3e || byte === 0x5b || byte === 0x5d || byte === 0x7b || byte === 0x7d || byte === 0x2f || byte === 0x25;
const PDF_NUMBER = /^[+-]?(?:\d+\.?\d*|\.\d+)$/u;
/* #1397: each incremental save (a form filled in, a signature added) appends
   one cross-reference section, and 32 refused real household PDFs that pdf.js
   opens. MAX_PDF_XREF_ENTRIES already bounds the work of checking a file, so
   this only stops a pathological chain: 256 is eight times the old limit and
   well past what repeated filling and signing produces. */
const MAX_PDF_XREF_SECTIONS = 256;
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
  constructor(private readonly bytes: Buffer, public position: number) {}

  next(): string | undefined {
    const { bytes } = this;
    while (this.position < bytes.length) {
      const byte = bytes[this.position]!;
      if (isPdfWhitespace(byte)) this.position += 1;
      else if (byte === 0x25) while (this.position < bytes.length && bytes[this.position] !== 0x0a && bytes[this.position] !== 0x0d) this.position += 1;
      else break;
    }
    if (this.position >= bytes.length) return undefined;
    const start = this.position;
    const byte = bytes[start]!;
    if ((byte === 0x3c || byte === 0x3e) && bytes[start + 1] === byte) {
      this.position += 2;
      return String.fromCharCode(byte, byte);
    }
    if (byte === 0x3c) {
      const end = bytes.indexOf(0x3e, start);
      if (end < 0) throw new PdfSyntaxError("unterminated hex string");
      this.position = end + 1;
      return "<>";
    }
    if (byte === 0x28) {
      let depth = 0;
      for (; this.position < bytes.length; this.position += 1) {
        const current = bytes[this.position];
        if (current === 0x5c) this.position += 1;
        else if (current === 0x28) depth += 1;
        else if (current === 0x29 && --depth === 0) {
          this.position += 1;
          return "()";
        }
      }
      throw new PdfSyntaxError("unterminated string");
    }
    this.position += 1;
    if (byte !== 0x2f && isPdfDelimiter(byte)) return String.fromCharCode(byte);
    while (this.position < bytes.length && !isPdfWhitespace(bytes[this.position]!) && !isPdfDelimiter(bytes[this.position]!)) this.position += 1;
    // Only this one token is decoded; the file never is.
    const word = bytes.toString("latin1", start, this.position);
    return byte === 0x2f ? word.replace(/#([0-9A-Fa-f]{2})/gu, (_, hex: string) => String.fromCharCode(Number.parseInt(hex, 16))) : word;
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
function linearizedXrefOffset(bytes: Buffer): number | undefined {
  try {
    const lexer = new PdfLexer(bytes, 0);
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
  while (offset < bytes.length && (bytes[offset] === 0x20 || bytes[offset] === 0x09 || bytes[offset] === 0x0a || bytes[offset] === 0x0d)) offset += 1;
  return offset;
}

const isPdfRegexDigit = (byte: number | undefined): boolean => byte !== undefined && byte >= 0x30 && byte <= 0x39;
/** The regex `\s` over latin1: tab to carriage return, space, and U+00A0. */
const isPdfRegexSpace = (byte: number | undefined): boolean => byte !== undefined && ((byte >= 0x09 && byte <= 0x0d) || byte === 0x20 || byte === 0xa0);
/** The regex `\w`: ASCII letters, digits and `_`; every byte from 0x80 up is a non-word byte. */
const isPdfRegexWord = (byte: number | undefined): boolean =>
  byte !== undefined && ((byte >= 0x30 && byte <= 0x39) || (byte >= 0x41 && byte <= 0x5a) || (byte >= 0x61 && byte <= 0x7a) || byte === 0x5f);

const PDF_OBJECT_END = 0;
const PDF_TRAILER_END = 1;

/** Whether `word` (ASCII) sits at `at`. */
function pdfWordAt(bytes: Buffer, at: number, word: string): boolean {
  if (at + word.length > bytes.length) return false;
  for (let index = 0; index < word.length; index += 1) if (bytes[at + index] !== word.charCodeAt(index)) return false;
  return true;
}

/**
 * The bytes searched per native pass of findPdfEnd. A window is decoded to a
 * string for the regex below and dropped, so memory stays this size however
 * long the file is; it stays under 1 KiB so a check that sees no string that
 * long (the test for #1567) still holds.
 */
const PDF_SEARCH_WINDOW = 1000;
/** A keyword of at most 9 bytes (`startxref` is the longest) that starts before `windowEnd - 9` lies wholly in the window. */
const PDF_SEARCH_OVERLAP = 9;
/**
 * Where an end pattern can be found: the `obj` that ends an `N G obj` header,
 * or a keyword not preceded by a word byte (`\b` before a word byte). A header
 * is found from its `obj` and not from its first digit, because a run of
 * numbers has a digit start at every number but an `obj` only where a header
 * can end, so the regex skips the rest natively. Only the place is found here;
 * findPdfEnd reads the header back from the bytes and checks the rest there, so
 * a place can be refused but a true match is never missed.
 */
const PDF_OBJECT_END_PLACE = /obj|(?<![A-Za-z0-9_])(?:endobj|xref|trailer)/gu;
const PDF_TRAILER_END_PLACE = /obj|(?<![A-Za-z0-9_])startxref/gu;

/** The first digit of the `\d+\s+\d+\s+` that ends at `at`, or -1: read back over the bytes, run by run. */
function pdfObjectHeaderStart(bytes: Buffer, at: number): number {
  let position = at;
  for (let part = 0; part < 2; part += 1) {
    const space = position;
    while (isPdfRegexSpace(bytes[position - 1])) position -= 1;
    if (position === space) return -1;
    const digits = position;
    while (isPdfRegexDigit(bytes[position - 1])) position -= 1;
    if (position === digits) return -1;
  }
  return position;
}

/**
 * The byte-level form of pdf.js's end patterns, matching exactly what these
 * latin1 regexes (the `u` flag, no `i`) matched, searched forward from `from`:
 *   object  /\b(?:endobj|\d+\s+\d+\s+obj|xref|trailer\s*<<)\b/gu
 *   trailer /\b(?:startxref|\d+\s+\d+\s+obj)\b/gu
 * Both `\b` apply to every alternative, so `trailer<<` ends the object only
 * where a word byte follows the `<<`, as the regex's own trailing boundary
 * demands. `endobj` is true for the alternative the caller steps past (`endobj`
 * or `startxref`).
 *
 * The places a match can end or start are found by a native regex over a
 * bounded window of the file, so a long run of bytes that hold none (spaces in
 * a stream, say) costs no JavaScript step per byte, and no copy of the whole
 * file is made. Each is then checked on the bytes, as the regex would. A header
 * starts at the first digit of its run, the only digit with no word byte before
 * it, so each `obj` has at most one header, and a header holds no letter, so
 * none can start between an earlier place and its own `obj`: the places come in
 * the order the starts do. The window begins one byte early so the lookbehind
 * sees the byte before its first start, and stops short of its end so a keyword
 * is never cut by it: those bytes begin the next window.
 */
function findPdfEnd(bytes: Buffer, from: number, kind: typeof PDF_OBJECT_END | typeof PDF_TRAILER_END): { index: number; end: number; endobj: boolean } | null {
  const keyword = kind === PDF_OBJECT_END ? "endobj" : "startxref";
  const places = kind === PDF_OBJECT_END ? PDF_OBJECT_END_PLACE : PDF_TRAILER_END_PLACE;
  let windowStart = from;
  while (windowStart < bytes.length) {
    const base = Math.max(0, windowStart - 1);
    const windowEnd = Math.min(bytes.length, windowStart + PDF_SEARCH_WINDOW);
    // Places at or past `limit` wait for the next window, unless this one reaches the end of the file.
    const limit = windowEnd === bytes.length ? windowEnd : windowEnd - PDF_SEARCH_OVERLAP;
    const window = bytes.toString("latin1", base, windowEnd);
    places.lastIndex = windowStart - base;
    for (let found = places.exec(window); found !== null && base + found.index < limit; found = places.exec(window)) {
      let index = base + found.index;
      const byte = bytes[index]!;
      let end = -1;
      let endobj = false;
      if (byte === 0x6f) {
        // An `obj`: the header ends here if numbers and gaps lead back to a start the search has not passed.
        const start = pdfObjectHeaderStart(bytes, index);
        if (start < from || isPdfRegexWord(bytes[start - 1])) continue;
        index = start;
        end = found.index + base + 3;
      } else if (byte === keyword.charCodeAt(0) && pdfWordAt(bytes, index, keyword)) {
        end = index + keyword.length;
        endobj = true;
      } else if (kind === PDF_OBJECT_END && byte === 0x78 && pdfWordAt(bytes, index, "xref")) end = index + 4;
      else if (kind === PDF_OBJECT_END && byte === 0x74 && pdfWordAt(bytes, index, "trailer")) {
        let position = index + 7;
        while (isPdfRegexSpace(bytes[position])) position += 1;
        end = bytes[position] === 0x3c && bytes[position + 1] === 0x3c ? position + 2 : -1;
      }
      // The closing \b: the last byte matched is a word byte or `<`, and the next must differ in kind.
      if (end >= 0 && isPdfRegexWord(bytes[end - 1]) !== isPdfRegexWord(bytes[end])) return { index, end, endobj };
    }
    windowStart = limit;
  }
  return null;
}

/** `^word(?:\s|$)` over the token `bytes[start, end)`. */
function tokenIsKeyword(bytes: Buffer, start: number, end: number, word: string): boolean {
  const after = start + word.length;
  if (after > end) return false;
  for (let i = 0; i < word.length; i += 1) if (bytes[start + i] !== word.charCodeAt(i)) return false;
  return after === end || isPdfRegexSpace(bytes[after]);
}

/** `^\d+\s+\d+\s+obj\b` over the token `bytes[start, end)`; digits and spaces are disjoint, so no backtracking. */
function tokenIsObjectHeader(bytes: Buffer, start: number, end: number): boolean {
  let i = start;
  for (const run of [isPdfRegexDigit, isPdfRegexSpace, isPdfRegexDigit, isPdfRegexSpace]) {
    const from = i;
    while (i < end && run(bytes[i])) i += 1;
    if (i === from) return false;
  }
  if (i + 3 > end || bytes[i] !== 0x6f || bytes[i + 1] !== 0x62 || bytes[i + 2] !== 0x6a) return false;
  return i + 3 === end || !isPdfRegexWord(bytes[i + 3]);
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
function recoveryXrefOffsets(bytes: Buffer): number[] | null {
  const offsets: number[] = [];
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
    // The token is matched in place: a token can run to the end of a long line,
    // so a string of it per object would copy most of the file each time.
    if (tokenIsKeyword(bytes, position, end, "xref")) {
      const trailer = bytes.indexOf("trailer", position);
      position = trailer < 0 ? bytes.length : trailer;
      const startxref = bytes.indexOf("startxref", position);
      position = startxref < 0 ? bytes.length : startxref;
    } else if (tokenIsObjectHeader(bytes, position, end)) {
      const match = findPdfEnd(bytes, end, PDF_OBJECT_END);
      const contentEnd = Math.min(bytes.length, !match ? bytes.length : match.endobj ? match.end + 1 : match.index);
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
    } else if (tokenIsKeyword(bytes, position, end, "trailer")) {
      const match = findPdfEnd(bytes, end, PDF_TRAILER_END);
      position = !match ? bytes.length : match.endobj ? match.end + 1 : match.index;
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
function readPdfXrefSection(bytes: Buffer, offset: number): PdfXrefSection | undefined {
  const lexer = new PdfLexer(bytes, offset);
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
 * falls back to the scan, which is modelled. The check reads the bytes
 * directly and makes no decoded copy of the file.
 */
export function hasPdfIndexBudget(bytes: Buffer): boolean {
  const recovery = recoveryXrefOffsets(bytes);
  if (recovery === null) return false;
  const roots: number[] = [];
  const linearized = linearizedXrefOffset(bytes);
  if (linearized !== undefined) roots.push(linearized);
  // Otherwise pdf.js takes the last startxref anywhere in the file, %%EOF or
  // not; it is walked for a linearized file too, which costs one more section.
  const keyword = bytes.lastIndexOf("startxref");
  if (keyword >= 0) roots.push(Number(bytes.toString("latin1", keyword + 9, Math.min(keyword + 64, bytes.length)).match(/^\s*(\d+)/u)?.[1]));
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
        section = readPdfXrefSection(bytes, offset) ?? null;
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
 * killable child process (ADR-0038, pdf-structure-sandbox.ts), never in the
 * server's process.
 */
async function classifyPdfStructure(bytes: Buffer, file?: DocumentFileOnDisk): Promise<DocumentStructureReason> {
  // A cheap first fence: a declared entry count pdf.js would loop over,
  // refused before any child starts (ADR-0033 item 3, as amended by ADR-0038).
  if (!hasPdfIndexBudget(bytes)) return "unsupported_structure";
  return inspectPdfStructureInSandbox(bytes, file);
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

/** Whether the file is one Orbit can open and show: the renderer opens it and finds a page (ADR-0033). Call only after the malware scan has passed. */
export async function classifyDocumentStructure(bytes: Buffer, mediaType: SupportedDocumentMediaType, file?: DocumentFileOnDisk): Promise<DocumentStructureReason> {
  if (mediaType === "application/pdf") return classifyPdfStructure(bytes, file);
  return classifyImageStructure(bytes, mediaType, file);
}

/** True when `classifyDocumentStructure` finds a file Orbit can open and show. */
export async function validateSupportedDocumentStructure(bytes: Buffer, mediaType: SupportedDocumentMediaType, file?: DocumentFileOnDisk): Promise<boolean> {
  return (await classifyDocumentStructure(bytes, mediaType, file)) === "supported_structure";
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
