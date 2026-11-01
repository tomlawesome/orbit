/**
 * Test oracle for #1567: today's string-based PDF index-budget check, lifted
 * verbatim from `src/server/documents/validation.ts` at commit fb6b6743, before
 * the check is ported to read the Buffer directly. The ported check must answer
 * exactly as this one does on every input. Only the entry point is renamed
 * (`hasPdfIndexBudget` to `hasPdfIndexBudgetOracle`) and exported; everything
 * else is unchanged. Never edit the logic: it is the frozen model.
 */

const MAX_PDF_XREF_ENTRIES = 1_250_000;
const PDF_DELIMITERS = new Set([..."()<>[]{}/%"]);
const PDF_WHITESPACE = new Set([..."\0\t\n\f\r "]);
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
export function hasPdfIndexBudgetOracle(bytes: Buffer): boolean {
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
