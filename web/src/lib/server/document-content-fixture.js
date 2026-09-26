/**
 * Placeholder page and file content for the fixture harness's document
 * preview and download routes (#1141).
 *
 * `ORBIT_FIXTURES=1` stands the app up with no engine behind it (api.js's
 * `fixturesRequested`), so these two routes cannot decrypt or render
 * anything real. Rather than reach the engine and 500, they invent obviously
 * fake content — built from nothing but strings and `Buffer`, so no
 * dependency is added for data nobody is meant to read as real.
 */
import { AppError } from "orbit/lib/app-error";

import { DOCUMENTS_FIXTURE } from "$lib/data/fixtures/workspace.js";

/**
 * Finds a fixture document by id across every item's list — the content
 * routes only ever have the document id, not which item it rides with.
 * @param {string} documentId
 * @returns {?import("$lib/data/workspace.js").DocumentSummary}
 */
export function fixtureDocumentById(documentId) {
  for (const documents of Object.values(DOCUMENTS_FIXTURE)) {
    const found = documents.find((doc) => doc.id === documentId);
    if (found) return found;
  }
  return null;
}

/**
 * The same honest failure the real content routes answer for an id fixture
 * data does not know, so a stale or mistyped id 404s rather than 500s.
 * @param {string} documentId
 * @returns {import("$lib/data/workspace.js").DocumentSummary}
 */
export function requireFixtureDocument(documentId) {
  const doc = fixtureDocumentById(documentId);
  if (!doc) throw new AppError("document_not_found", "That document is not available", 404);
  return doc;
}

/** Grey bars standing in for lines of text, each a slightly different width. */
const PLACEHOLDER_LINE_WIDTHS = [640, 520, 610, 460, 590, 400];

/**
 * "A titled A4 page with grey text lines and the document's name" — never
 * real content, so nothing mistakes it for the document it stands in for.
 * @param {string} title
 * @returns {string}
 */
export function placeholderPageSvg(title) {
  const width = 850, height = 1202; /* roughly A4 at 100dpi */
  const escaped = title.replace(/&/g, "&amp;").replace(/</g, "&lt;");
  const lines = PLACEHOLDER_LINE_WIDTHS
    .map((w, i) => `<rect x="90" y="${230 + i * 54}" width="${w}" height="13" rx="3" fill="#c2c6cd"/>`)
    .join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
<rect width="${width}" height="${height}" fill="#ffffff"/>
<rect x="1" y="1" width="${width - 2}" height="${height - 2}" fill="none" stroke="#dcdfe4" stroke-width="2"/>
<text x="90" y="150" font-family="sans-serif" font-size="32" fill="#20242b">${escaped}</text>
<line x1="90" y1="182" x2="${width - 90}" y2="182" stroke="#dcdfe4" stroke-width="2"/>
${lines}
<text x="90" y="${height - 56}" font-family="sans-serif" font-size="15" fill="#9aa0aa">sample page — fixture data, not the real document</text>
</svg>`;
}

/** @param {string} text @returns {string} */
const pdfEscape = (text) => text.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");

/**
 * A minimal, genuinely valid one-page PDF naming the document — the closest
 * "a small sample file of the document's media type" gets without a PDF
 * library. Five hand-written objects and a real xref table, self-contained.
 * @param {string} title
 * @returns {Buffer}
 */
export function placeholderPdf(title) {
  const text = pdfEscape(title.slice(0, 70));
  const objects = [
    "<</Type/Catalog/Pages 2 0 R>>",
    "<</Type/Pages/Kids[3 0 R]/Count 1>>",
    "<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Resources<</Font<</F1 4 0 R>>>>/Contents 5 0 R>>",
    "<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>",
  ];
  const stream = `BT /F1 20 Tf 72 700 Td (${text}) Tj ET\n`
    + "BT /F1 11 Tf 72 674 Td (sample file -- fixture data, not the real document) Tj ET";
  objects.push(`<</Length ${Buffer.byteLength(stream, "latin1")}>>\nstream\n${stream}\nendstream`);

  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  for (let i = 0; i < objects.length; i++) {
    offsets.push(Buffer.byteLength(pdf, "latin1"));
    pdf += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`;
  }
  const xrefOffset = Buffer.byteLength(pdf, "latin1");
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= objects.length; i++) pdf += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  pdf += `trailer\n<</Size ${objects.length + 1}/Root 1 0 R>>\nstartxref\n${xrefOffset}\n%%EOF`;
  return Buffer.from(pdf, "latin1");
}

/**
 * "A small sample file of the document's media type if feasible, else the
 * same placeholder": a hand-written PDF is feasible; an image is not,
 * without a real image codec, so an image-typed fixture document downloads
 * the same placeholder page instead.
 * @param {import("$lib/data/workspace.js").DocumentSummary} doc
 * @returns {Buffer}
 */
export function placeholderDownloadBytes(doc) {
  if (doc.mediaType === "application/pdf") return placeholderPdf(doc.displayName);
  return Buffer.from(placeholderPageSvg(doc.displayName));
}
