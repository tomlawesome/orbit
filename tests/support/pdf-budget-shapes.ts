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
 * src/server/documents/pdf-structure-sandbox.test.ts (whose builders are
 * local to those files, so they are repeated here, unchanged in content).
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

function pdfWithXrefStream(dictionaryTail: string): Buffer {
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

function pdfWithClassicXref(subsectionHeaders: string[]): Buffer {
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
  return Buffer.from(value);
}

function linearizedHidingOversizedSection(): Buffer {
  return withMeasuredLength((total) => {
    let value = "%PDF-1.7\n" + linearizationObject(total);
    value += "4 0 obj << /Type /XRef /W [0 0 0] /Index [0 2000000000] /Size 2000000000 /Root 1 0 R /Length 0 >>\n";
    value += "stream\n\nendstream\nendobj\n";
    const tinyOffset = Buffer.byteLength(value);
    value += `${TINY_XREF}trailer\n<< /Size 1 /Root 1 0 R >>\nstartxref\n${tinyOffset}\n%%EOF\n`;
    return value;
  });
}

function linearizedWithSmallSections(): Buffer {
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

function smallPdfWithFirstObject(firstObject: string): Buffer {
  let value = `%PDF-1.7\n${firstObject}`;
  const xrefOffset = Buffer.byteLength(value);
  value += `${TINY_XREF}trailer\n<< /Size 1 /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(value);
}

const BASE = "%PDF-1.7\n"
  + "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n"
  + "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n"
  + "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>\nendobj\n";

function hiddenXrefObject(index: string): string {
  return `4 0 obj << /Type /XRef /W [0 0 0] /Index ${index} /Size 3 /Length 0 >>\nstream\n\nendstream\nendobj\n`;
}

function classicTable(headerLine: string, extraObject = ""): Buffer {
  let value = BASE + extraObject;
  const xrefOffset = Buffer.byteLength(value);
  value += `xref\n${headerLine}\n0000000000 65535 f \n0000000009 00000 n \n0000000058 00000 n \n`;
  value += `trailer\n<< /Size 3 /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(value);
}

// ---- pdf-structure-sandbox.test.ts --------------------------------------

function hugeXrefStreamObject(objectNumber: number): string {
  return `${objectNumber} 0 obj << /Type /XRef /W [0 0 0] /Index [0 2000000] /Size 5 /Length 0 >>\nstream\n\nendstream\nendobj\n`;
}

function hostilePdf(separator: string, tail: string): Buffer {
  return Buffer.from(`%PDF-1.7\n${separator}${hugeXrefStreamObject(1)}${tail}`, "latin1");
}

function hostilePdfWithSignedStartxref(): Buffer {
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

export { hostilePdf };

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
    { name: "hostile: no-break space before the object", bytes: hostilePdf("\xa0", "%%EOF") },
    { name: "object-stream bomb (1 MB)", bytes: objectStreamBomb(1) },
    { name: "empty file", bytes: Buffer.alloc(0) },
    { name: "header only", bytes: Buffer.from("%PDF-1.7\n") },
    { name: "one long token", bytes: Buffer.from(`%PDF-1.7\n${"a".repeat(5000)}`) },
    { name: "unterminated string", bytes: Buffer.from("%PDF-1.7\n1 0 obj\n(never closed\n") },
    { name: "unterminated hex string", bytes: Buffer.from("%PDF-1.7\n1 0 obj\n<abc\n") },
  ];
  return shapes;
}
