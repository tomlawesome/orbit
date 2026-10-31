import { deflateSync } from "node:zlib";
import { readdirSync, readFileSync } from "node:fs";
import {
  classicChainPdf,
  syntheticModernPdf,
  syntheticPdfWithPages,
  syntheticStructurePdfFixtures,
  xrefStmChainPdf,
  xrefStreamPdf,
} from "./generated-pdf-documents";
import { syntheticOwnerPasswordPdf, syntheticUserPasswordPdf } from "./encrypted-pdf-documents";
import { syntheticPdf, syntheticPdfWithXrefStream } from "./synthetic-documents";

/**
 * Every PDF shape the index-budget check has been written against, for the
 * equivalence test of #1567: the producer fixtures, the synthetic builders, and
 * the hostile and linearized shapes of
 * src/server/documents/validation-budget.test.ts and
 * src/server/documents/pdf-structure-sandbox.test.ts. Those two files import
 * their builders from here: this is the one copy.
 */

export interface NamedPdf {
  name: string;
  bytes: Buffer;
}

const FIXTURE_DIRECTORY = new URL("./fixtures/", import.meta.url);

/** Every `.pdf` under tests/support/fixtures/. */
export function fixtureFilePdfs(): NamedPdf[] {
  return readdirSync(FIXTURE_DIRECTORY)
    .filter((entry) => entry.endsWith(".pdf"))
    .sort()
    .map((entry) => ({ name: `fixtures/${entry}`, bytes: readFileSync(new URL(entry, FIXTURE_DIRECTORY)) }));
}

// ---- validation-budget.test.ts ------------------------------------------

export function pdfWithXrefStream(dictionaryTail: string): Buffer {
  let value = "%PDF-1.7\n";
  value += "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n";
  value += "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n";
  value += "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>\nendobj\n";
  const xrefOffset = Buffer.byteLength(value);
  const entries = "11111111111111111111";
  value += `4 0 obj\n<< /Type /XRef /Root 1 0 R /Length ${entries.length} /W [1 2 1] ${dictionaryTail} >>\nstream\n`;
  value += `${entries}\nendstream\nendobj\n`;
  value += `startxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(value);
}

export function pdfWithClassicXref(subsectionHeaders: string[]): Buffer {
  let value = "%PDF-1.7\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n";
  const xrefOffset = Buffer.byteLength(value);
  value += `xref\n${subsectionHeaders.join("\n")}\n0000000000 65535 f \n`;
  value += `trailer\n<< /Size 3000000 /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(value);
}

const pad = (value: number): string => String(value).padStart(10, "0");
const TINY_XREF = "xref\n0 1\n0000000000 65535 f \n";

function linearizationObject(total: number): string {
  return `1 0 obj << /Linearized 1 /L ${pad(total)} /H [0000000100 0000000020] /O 2 /E 100 /N 1 /T 0000000200 >>\nendobj\n`;
}

function withMeasuredLength(build: (total: number) => string): Buffer {
  const total = Buffer.byteLength(build(0));
  const value = build(total);
  if (Buffer.byteLength(value) !== total) throw new Error("the measured length changed the file's length");
  return Buffer.from(value);
}

export function linearizedHidingOversizedSection(): Buffer {
  return withMeasuredLength((total) => {
    let value = "%PDF-1.7\n" + linearizationObject(total);
    value += "4 0 obj << /Type /XRef /W [0 0 0] /Index [0 2000000000] /Size 2000000000 /Root 1 0 R /Length 0 >>\n";
    value += "stream\n\nendstream\nendobj\n";
    const tinyOffset = Buffer.byteLength(value);
    value += `${TINY_XREF}trailer\n<< /Size 1 /Root 1 0 R >>\nstartxref\n${tinyOffset}\n%%EOF\n`;
    return value;
  });
}

export function linearizedWithSmallSections(): Buffer {
  return withMeasuredLength((total) => {
    let value = "%PDF-1.7\n" + linearizationObject(total);
    const firstPageOffset = Buffer.byteLength(value);
    const firstPage = (prev: number): string =>
      `${TINY_XREF}trailer\n<< /Size 1 /Root 1 0 R /Prev ${pad(prev)} >>\nstartxref\n0\n%%EOF\n`;
    const mainOffset = firstPageOffset + Buffer.byteLength(firstPage(0));
    value += firstPage(mainOffset);
    value += `${TINY_XREF}trailer\n<< /Size 1 /Root 1 0 R >>\nstartxref\n${firstPageOffset}\n%%EOF\n`;
    return value;
  });
}

export function smallPdfWithFirstObject(firstObject: string): Buffer {
  let value = `%PDF-1.7\n${firstObject}`;
  const xrefOffset = Buffer.byteLength(value);
  value += `${TINY_XREF}trailer\n<< /Size 1 /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(value);
}

export const BASE = "%PDF-1.7\n"
  + "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n"
  + "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n"
  + "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>\nendobj\n";

export function hiddenXrefObject(index: string): string {
  return `4 0 obj << /Type /XRef /W [0 0 0] /Index ${index} /Size 3 /Length 0 >>\nstream\n\nendstream\nendobj\n`;
}

export function classicTable(headerLine: string, extraObject = ""): Buffer {
  let value = BASE + extraObject;
  const xrefOffset = Buffer.byteLength(value);
  value += `xref\n${headerLine}\n0000000000 65535 f \n0000000009 00000 n \n0000000058 00000 n \n`;
  value += `trailer\n<< /Size 3 /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(value);
}

// ---- pdf-structure-sandbox.test.ts --------------------------------------

export function hugeXrefStreamObject(objectNumber: number): string {
  return `${objectNumber} 0 obj << /Type /XRef /W [0 0 0] /Index [0 2000000] /Size 5 /Length 0 >>\nstream\n\nendstream\nendobj\n`;
}

export function hostilePdf(separator: string, tail: string): Buffer {
  return Buffer.from(`%PDF-1.7\n${separator}${hugeXrefStreamObject(1)}${tail}`, "latin1");
}

export function hostilePdfWithSignedStartxref(): Buffer {
  const head = "%PDF-1.7\n2 0 obj\n<< /Type /Catalog >>\nendobj\n\f";
  const objectFourOffset = Buffer.byteLength(head, "latin1");
  return Buffer.from(`${head}${hugeXrefStreamObject(4)}startxref\n+${objectFourOffset}\n%%EOF`, "latin1");
}

/** A small object-stream bomb: the same builder as the sandbox test, with a small padding. */
export function objectStreamBomb(paddingMb: number): Buffer {
  const head = "2 0 ";
  const body = "<< /Type /Catalog /Pages 3 0 R >>";
  const first = head.length;
  const raw = Buffer.alloc(first + body.length + paddingMb * 1024 * 1024, 0x20);
  raw.write(head + body, 0, "latin1");
  const packed = deflateSync(raw, { level: 9 });
  const parts: Buffer[] = [];
  const offsets: Record<number, number> = {};
  let length = 0;
  const push = (piece: Buffer | string): void => {
    const buffer = Buffer.isBuffer(piece) ? piece : Buffer.from(piece, "latin1");
    parts.push(buffer);
    length += buffer.length;
  };
  push("%PDF-1.7\n%\xe2\xe3\xcf\xd3\n");
  offsets[1] = length;
  push(`1 0 obj\n<< /Type /ObjStm /N 1 /First ${first} /Filter /FlateDecode /Length ${packed.length} >>\nstream\n`);
  push(packed);
  push("\nendstream\nendobj\n");
  offsets[3] = length;
  push("3 0 obj\n<< /Type /Pages /Kids [4 0 R] /Count 1 >>\nendobj\n");
  offsets[4] = length;
  push("4 0 obj\n<< /Type /Page /Parent 3 0 R /MediaBox [0 0 200 200] >>\nendobj\n");
  offsets[5] = length;
  const row = (type: number, a: number, b: number): Buffer => {
    const entry = Buffer.alloc(7);
    entry[0] = type;
    entry.writeUInt32BE(a, 1);
    entry.writeUInt16BE(b, 5);
    return entry;
  };
  const table = Buffer.concat([
    row(0, 0, 65535),
    row(1, offsets[1]!, 0),
    row(2, 1, 0),
    row(1, offsets[3]!, 0),
    row(1, offsets[4]!, 0),
    row(1, offsets[5]!, 0),
  ]);
  push(`5 0 obj\n<< /Type /XRef /Size 6 /W [1 4 2] /Root 2 0 R /Length ${table.length} >>\nstream\n`);
  push(table);
  push("\nendstream\nendobj\n");
  push(`startxref\n${offsets[5]}\n%%EOF\n`);
  return Buffer.concat(parts);
}


/**
 * Inputs that sit on the edge of a pattern in the recovery scan, where one
 * byte decides whether an object's text ends early. A random byte flip almost
 * never builds these, so they are written out. `expected` is what the
 * string-based check answers (and so what the byte-level one must): `false`
 * where an oversized cross-reference stream is found and the file is refused,
 * `true` where the boundary hides it and the file is accepted.
 *
 * The scan ends an object at the first `\b(?:endobj|N M obj|xref|trailer\s*<<)\b`
 * and a trailer at the first `\b(?:startxref|N M obj)\b`, over latin1 text with
 * the `u` flag: `\s` includes 0xa0, and `\b` sees only ASCII letters, digits and
 * `_` as word characters, so 0x80 and above are non-word bytes.
 */
export interface BoundaryCase {
  name: string;
  bytes: Buffer;
  expected: boolean;
}

const HUGE_DICTIONARY = "/Type /XRef /W [0 0 0] /Index [0 2000000] /Size 3 /Length 0";
const HUGE_STREAM_TAIL = `${HUGE_DICTIONARY} >>\nstream\n\nendstream\nendobj\n`;

function latin1(value: string): Buffer {
  return Buffer.from(value, "latin1");
}

export function boundaryCases(): BoundaryCase[] {
  const cases: BoundaryCase[] = [];
  const add = (name: string, value: string, expected: boolean): void => {
    cases.push({ name, bytes: latin1(value), expected });
  };

  // One object whose text holds `marker`, then a huge /XRef stream dictionary.
  // The object ends at the marker if the marker matches objectEnd, which hides
  // the dictionary from it (accepted); if it does not, the object holds it
  // (refused). An object header as marker also starts a new object, which
  // holds the dictionary, so those answer refused either way.
  const marked = (marker: string): string => `%PDF-1.7\n1 0 obj\n<< /Note (${marker}) ${HUGE_STREAM_TAIL}`;
  const markers: Array<[string, string, boolean]> = [
    ["endobj ends the object", "endobj ", true],
    ["endobjx does not", "endobjx", false],
    ["endobj_ does not", "endobj_", false],
    ["endobj then 0xe9 does", "endobj\xe9", true],
    ["xendobj does not", "xendobj", false],
    ["0xe9 then endobj does", "\xe9endobj", true],
    ["xref ends the object", "xref ", true],
    ["xrefx does not", "xrefx", false],
    ["xref then 0xe9 does", "xref\xe9", true],
    ["trailer<<a ends the object", "trailer<<a", true],
    ["trailer, NBSP, <<a ends it", "trailer\xa0<<a", true],
    ["trailer<< then a non-word byte does not", "trailer<< ", false],
    ["trailer, NBSP, << then a non-word byte does not", "trailer\xa0<< ", false],
    ["1 0 obj ends it and starts one that holds the stream", "1 0 obj ", false],
    ["1, NBSP, 0, NBSP, obj ends it and starts one that holds the stream", "1\xa00\xa0obj ", false],
    ["1 0 objx does not", "1 0 objx", false],
    ["x1 0 obj does not", "x1 0 obj", false],
    ["0xe9 then 1 0 obj ends it and starts one that holds the stream", "\xe91 0 obj", false],
    ["1 0 obj then 0xe9 ends it and starts one that holds the stream", "1 0 obj\xe9", false],
  ];
  for (const [what, marker, expected] of markers) add(`${what}, before a huge /XRef stream`, marked(marker), expected);

  // endobj as the last bytes of the file, with the huge stream inside the object.
  add("endobj at the very end of the file", `%PDF-1.7\n1 0 obj\n<< ${HUGE_DICTIONARY} >>\nstream\n\nendstream\nendobj`, false);

  // After endobj (or startxref) the scan resumes one byte on, skipping a
  // comment's % so that the text after it is read as an object.
  add("endobj, then % and an object: the byte after endobj is skipped", `%PDF-1.7\n1 0 obj\n<< >>\nendobj%2 0 obj\n<< ${HUGE_STREAM_TAIL}`, false);
  add("endobj, then two bytes and an object: only one is skipped", `%PDF-1.7\n1 0 obj\n<< >>\nendobj%x2 0 obj\n<< ${HUGE_STREAM_TAIL}`, true);
  add("startxref, then % and an object: the byte after startxref is skipped", `%PDF-1.7\ntrailer\n<< >>\nstartxref%3 0 obj\n<< ${HUGE_STREAM_TAIL}`, false);
  add("startxref, then two bytes and an object: only one is skipped", `%PDF-1.7\ntrailer\n<< >>\nstartxref%x3 0 obj\n<< ${HUGE_STREAM_TAIL}`, true);

  // After a trailer the scan jumps to the next startxref or object header; an
  // `xref` token after that landing point then skips a later object.
  const afterTrailer = (landing: string): string =>
    `%PDF-1.7\ntrailer\n<< >>\n${landing}\nendobj\nxref\n4 0 obj\n<< ${HUGE_STREAM_TAIL}trailer\nstartxref\n0\n%%EOF\n`;
  const landings: Array<[string, string, boolean]> = [
    ["3 0 obj", "3 0 obj", true],
    ["3, NBSP, 0, NBSP, obj", "3\xa00\xa0obj", true],
    ["3 0 objx", "3 0 objx", false],
    ["x3 0 obj", "x3 0 obj", false],
    ["0xe9 then 3 0 obj", "\xe93 0 obj", true],
    ["startxref", "startxref", true],
    ["startxrefx", "startxrefx", false],
    ["xstartxref", "xstartxref", false],
    ["0xe9 then startxref", "\xe9startxref", true],
  ];
  for (const [what, landing, expected] of landings) add(`after a trailer, a landing on ${what}`, afterTrailer(landing), expected);

  // startxref followed directly by its offset, and by a no-break space first.
  const head = "%PDF-1.7\n1 0 obj\n<< /Type /Catalog >>\nendobj\n";
  const huge = `4 0 obj\n<< ${HUGE_STREAM_TAIL}`;
  const hugeAt = Buffer.byteLength(head + "\n");
  add("startxref directly followed by the offset of a huge stream", `${head}\n${huge}startxref${hugeAt}\n%%EOF\n`, false);
  add("startxref, NBSP, then the offset of a huge stream", `${head}\n${huge}startxref\xa0${hugeAt}\n%%EOF\n`, false);
  add("startxref, a line end, then the offset of a huge stream", `${head}\n${huge}startxref\n${hugeAt}\n%%EOF\n`, false);

  // One long single line of object headers: no line end to stop a token.
  cases.push({ name: "4 MiB of `1 0 obj ` on one line", bytes: latin1(`%PDF-1.7\n${"1 0 obj ".repeat(Math.ceil((4 * 1024 * 1024) / 8))}`), expected: true });
  return cases;
}

/** All of the above, named. */
export function allBudgetShapes(): NamedPdf[] {
  const shapes: NamedPdf[] = [
    ...fixtureFilePdfs(),
    { name: "syntheticPdf", bytes: syntheticPdf() },
    { name: "syntheticPdfWithXrefStream", bytes: syntheticPdfWithXrefStream() },
    { name: "syntheticModernPdf", bytes: syntheticModernPdf() },
    { name: "syntheticOwnerPasswordPdf", bytes: syntheticOwnerPasswordPdf() },
    { name: "syntheticUserPasswordPdf", bytes: syntheticUserPasswordPdf() },
    { name: "syntheticPdfWithPages(12)", bytes: syntheticPdfWithPages(12) },
    { name: "classicChainPdf 1 section", bytes: classicChainPdf({ sections: 1 }) },
    { name: "classicChainPdf 3 sections", bytes: classicChainPdf({ sections: 3 }) },
    { name: "classicChainPdf 256 sections", bytes: classicChainPdf({ sections: 256 }) },
    { name: "classicChainPdf 257 sections", bytes: classicChainPdf({ sections: 257 }) },
    { name: "xrefStmChainPdf", bytes: xrefStmChainPdf() },
    { name: "xrefStmChainPdf cycle", bytes: xrefStmChainPdf({ cycle: true }) },
    { name: "xrefStreamPdf", bytes: xrefStreamPdf() },
    ...syntheticStructurePdfFixtures.map((fixture) => ({ name: `structure: ${fixture.name}`, bytes: fixture.bytes })),
    { name: "xref stream /Index [0 2000000000]", bytes: pdfWithXrefStream("/Size 5 /Index [0 2000000000]") },
    { name: "xref stream /Size 2000000000", bytes: pdfWithXrefStream("/Size 2000000000") },
    { name: "xref stream /Index [0 12]", bytes: pdfWithXrefStream("/Size 12 /Index [0 12]") },
    { name: "classic xref over 1,250,000 entries", bytes: pdfWithClassicXref(["0 1000000", "1000000 250001"]) },
    { name: "classic xref at 1,250,000 entries", bytes: pdfWithClassicXref(["0 1000000", "1000000 250000"]) },
    { name: "linearized hiding an oversized section", bytes: linearizedHidingOversizedSection() },
    { name: "linearized with small sections", bytes: linearizedWithSmallSections() },
    { name: "/L does not equal the file length", bytes: smallPdfWithFirstObject("1 0 obj << /Linearized 1 /L 0000000999 /H [0000000100 0000000020] /O 2 /E 100 /N 1 /T 0000000200 >>\nendobj\n") },
    { name: "/Linearized is 0", bytes: smallPdfWithFirstObject("1 0 obj << /Linearized 0 /L 0000000000 /H [0000000100 0000000020] /O 2 /E 100 /N 1 /T 0000000200 >>\nendobj\n") },
    { name: "first object not a dictionary", bytes: smallPdfWithFirstObject("1 0 obj\n(/Linearized 1)\nendobj\n") },
    { name: "A1 hidden xref stream, startxref past the end", bytes: Buffer.from(`${BASE}${hiddenXrefObject("[0 2000000]")}startxref\n99999999\n%%EOF\n`) },
    { name: "A2 hidden xref stream, no startxref", bytes: Buffer.from(`${BASE}${hiddenXrefObject("[0 2000000]")}%%EOF\n`) },
    { name: "A3 small hidden xref stream, broken startxref", bytes: Buffer.from(`${BASE}${hiddenXrefObject("[0 12]")}startxref\n99999999\n%%EOF\n`) },
    { name: "B5 classic header hidden by a comment", bytes: classicTable("0 2000000 %pad") },
    { name: "B6 small classic header with a comment", bytes: classicTable("0 3 %ok") },
    { name: "B7 /XRefStm with a good startxref", bytes: classicTable("0 3", "5 0 obj\n<< /Type /Foo /XRefStm 0 >>\nendobj\n") },
    { name: "hostile: form feed, bare %%EOF", bytes: hostilePdf("\f", "%%EOF") },
    { name: "hostile: NUL, bare %%EOF", bytes: hostilePdf("\0", "%%EOF") },
    { name: "hostile: form feed, startxref not a number", bytes: hostilePdf("\f", "startxref\nabc\n%%EOF") },
    { name: "hostile: signed startxref", bytes: hostilePdfWithSignedStartxref() },
    { name: "object-stream bomb (1 MB)", bytes: objectStreamBomb(1) },
    ...boundaryCases().map(({ name, bytes }) => ({ name: `boundary: ${name}`, bytes })),
    { name: "empty file", bytes: Buffer.alloc(0) },
    { name: "header only", bytes: Buffer.from("%PDF-1.7\n") },
    { name: "one long token", bytes: Buffer.from(`%PDF-1.7\n${"a".repeat(5000)}`) },
    { name: "unterminated string", bytes: Buffer.from("%PDF-1.7\n1 0 obj\n(never closed\n") },
    { name: "unterminated hex string", bytes: Buffer.from("%PDF-1.7\n1 0 obj\n<abc\n") },
  ];
  return shapes;
}
