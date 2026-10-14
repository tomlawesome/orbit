/**
 * Documents and staged papers as home's item drawer and the reading card show
 * them. Named for the belt (#458), which first drew these rows; the belt itself
 * retired in #1319 and only the vocabulary it shared with the drawer remains.
 *
 * Pure, like chart.js and documents.js: the fetching lives in the seam
 * (workspace.js). This module only says what each document row and its
 * preview card read.
 */
import { kindOfItem } from "./chart.js";
/* Relative, like chart.js's own imports: this module is pure and is exercised
   straight from node by the unit suite, which knows no SvelteKit aliases. */
import { longDate, sizeLabel } from "../format.js";
import { stagedPreviewHref } from "../pocket/review.js";

/**
 * format.js's size words, with a document that has no size on record said so.
 * @param {?number} [bytes]
 * @returns {string}
 */
const sizeWords = (bytes) => (bytes === null || bytes === undefined ? "unknown size" : sizeLabel(bytes));

/**
 * "PDF (application/pdf)" — what the file is, in both registers.
 * @param {?string} [mediaType]
 * @returns {{ plate: string, type: string }}
 */
const kindOfFile = (mediaType) => {
  const short = String(mediaType ?? "").split("/").pop()?.toUpperCase() || "FILE";
  return { plate: short, type: mediaType ? `${short} (${mediaType})` : short };
};

/**
 * chart.js's own kind reading (dialBodiesOf/corridorOf), unchanged.
 * @param {import('./workspace.js').WorkspaceItem} item
 * @returns {string}
 */
export const kindOf = (item) => kindOfItem(/** @type {any} */ (item));

/**
 * The three media types the preview endpoint (#476) can actually turn into a
 * page — `src/server/documents/validation.ts`'s own list, said here so the
 * screen can honestly decide NOT to ask before it tries (#1088: "never draw a
 * fake page" cuts both ways — it also means never spinning on a kind Orbit
 * was always going to refuse).
 * @type {ReadonlySet<string>}
 */
export const PREVIEW_SUPPORTED_MEDIA_TYPES = new Set(["application/pdf", "image/jpeg", "image/png"]);

/**
 * One document, as a body in the band and as its own card — and, since
 * #1319, as a row in home's item drawer, which opens the same preview card
 * and reader from it (workspace.js readItem, readItemDocuments).
 *
 * `href` is the honest v1 display the owner ruled for (§15): details, and the
 * original in your hands. #476's page-one render is a seam, not a promise —
 * see the marked place in the screen.
 * @param {import('./workspace.js').DocumentSummary} doc
 * @returns {BeltDocumentRow}
 */
export function documentRowOf(doc) {
  const { plate, type } = kindOfFile(doc.mediaType);
  return {
    id: doc.id,
    name: doc.displayName,
    size: sizeWords(doc.sizeBytes),
    added: doc.availableAt ? longDate(doc.availableAt) : "unknown",
    type,
    plate,
    clean: doc.scanStatus === "clean",
    scan: doc.scanStatus ?? null,
    /* GET /api/documents/{id}/download — private, no-store, and the only
       thing Orbit can honestly hand over until the preview endpoint lands. */
    href: `/api/documents/${encodeURIComponent(doc.id)}/download`,
    /* GET /api/documents/{id}/preview (#476) — page one, whole, in its own
       proportions. Always page one: Orbit records no page count (#1088). */
    previewHref: `/api/documents/${encodeURIComponent(doc.id)}/preview`,
    /* #1088: what the preview card (create-v3's readcard) needs beyond the
       item-card's honest display above — the raw lifecycle state, so the
       screen can tell scanning from removed from refused from simply
       unsupported, and the retention date a removed file's line names. */
    lifecycle: doc.lifecycle ?? null,
    mediaType: doc.mediaType ?? null,
    ready: Boolean(doc.ready),
    deleteAfter: doc.deleteAfter ? longDate(doc.deleteAfter) : null,
  };
}

/**
 * The preview card's own honest state (#1088, owner-decisions.md §18): the
 * page nearly edge to edge when Orbit can draw one, and otherwise one of the
 * four states the focus block holds still for. Never a guess: `removed` and
 * `refused` are the server's own lifecycle, `scanning` is simply "not ready
 * yet", and `undrawable` is everything ready and clean that is still not one
 * of the three kinds the renderer understands.
 *
 * @param   {BeltDocumentRow} doc
 * @returns {"available" | "scanning" | "removed" | "refused" | "undrawable" | "staged"}
 */
export function documentPreviewStateOf(doc) {
  /* #1155: a suggestion's paper is staged with the mail, not stored -- there
     is no document row until the suggestion is accepted, and no download or
     restore. But its page one draws exactly where an accepted document's
     does (owner-decisions §18) whenever the mail named it as a PDF and the
     preview route can be built; "staged" is now only the one paper Orbit
     genuinely cannot draw a page for. Read first: a staged paper has no
     lifecycle word of its own, so every test below would otherwise call it
     scanning. */
  if (doc.staged) {
    if (doc.previewHref) return "available";
    return doc.mediaType && doc.mediaType !== "application/pdf" ? "undrawable" : "staged";
  }
  if (doc.lifecycle === "pending_deletion") return "removed";
  if (doc.lifecycle === "rejected") return "refused";
  if (!doc.ready) return "scanning";
  if (!doc.mediaType || !PREVIEW_SUPPORTED_MEDIA_TYPES.has(doc.mediaType)) return "undrawable";
  return "available";
}

/**
 * One document as it rides beside its item in the belt.
 *
 * @typedef {object} BeltDocumentRow
 * @property {string} id
 * @property {string} name
 * @property {string} size
 * @property {string} added
 * @property {string} type
 * @property {string} plate
 * @property {boolean} clean
 * @property {?string} scan
 * @property {string} href
 * @property {string} previewHref
 * @property {?string} lifecycle
 * @property {?string} mediaType
 * @property {boolean} ready
 * @property {?string} deleteAfter  "9 September 2026", when the file is on the clock
 * @property {boolean} [staged]  a suggestion's paper (#1145): it rides with the
 *   mail and is attached only on acceptance -- no `documents` row, and no
 *   download -- but its page one draws the same as an accepted document's
 *   wherever `previewHref` names one (#1155)
 * @property {?string} [attachmentId]  the staged attachment's own id, for a
 *   staged paper with a name (null for the count-only fallback)
 */

/**
 * "PDF" from a paper's own name, for a staged paper the list gives no media
 * type for: the plate the reading card holds still.
 * @param {string} name
 * @returns {string}
 */
export const plateOfName = (name) => {
  const dot = name.lastIndexOf(".");
  const ext = dot > 0 ? name.slice(dot + 1) : "";
  return ext && ext.length <= 5 ? ext.toUpperCase() : "FILE";
};

/**
 * A suggestion's papers as they ride beside it (#1145): staged with the
 * mail, named where the list names them (#467; the fixture does, live data
 * gives the count), attached only on acceptance -- no `documents` row, no
 * download. A named PDF gets a preview route (#1155): the same page-one
 * reading card an accepted document opens, just answered from the mail's own
 * staging rather than a stored document.
 *
 * @param {import('./workspace.js').ItemView | import('./workspace.js').ReceiptSuggestion} suggestion
 * @returns {BeltDocumentRow[]}
 */
function stagedDocsOf(suggestion) {
  const arrived = suggestion.receivedAt ? longDate(suggestion.receivedAt) : "unknown";
  const named = suggestion.attachments?.map((a) => ({
    name: a.displayName ?? "forwarded document",
    size: sizeWords(a.sizeBytes),
    clean: a.scanState === "clean",
    attachmentId: a.id ?? null,
    mediaType: a.mediaType ?? null,
  }));
  const count = suggestion.attachmentCount ?? 0;
  const papers = named ?? Array.from({ length: count }, (_, j) => ({
    name: count === 1 ? "forwarded document" : `forwarded document ${j + 1}`, size: "unknown size", clean: false,
    attachmentId: null, mediaType: null,
  }));
  return papers.map((paper, j) => ({
    id: `${suggestion.id}-paper-${j + 1}`,
    name: paper.name,
    size: paper.size,
    added: arrived,
    type: plateOfName(paper.name),
    plate: plateOfName(paper.name),
    clean: paper.clean,
    scan: paper.clean ? "clean" : null,
    href: "",
    // receiptId and id are the same value on a ReceiptSuggestion (used for
    // clarity); the fallback only matters to the type checker; ItemView
    // widens receiptId to optional through Partial<ReceiptSuggestion>.
    previewHref: paper.attachmentId && paper.mediaType === "application/pdf"
      ? stagedPreviewHref(suggestion.receiptId ?? suggestion.id, paper.attachmentId) : "",
    lifecycle: null,
    mediaType: paper.mediaType,
    ready: false,
    deleteAfter: null,
    staged: true,
    attachmentId: paper.attachmentId,
  }));
}

/**
 * A suggestion's papers as its home drawer lists them (#1319: a suggestion
 * is reviewed in its home drawer, owner-decisions §34): the staged rows the
 * belt rode beside it, each with the drawer's one-line `meta`. Every one
 * opens the preview card, which says itself whether it has a page.
 *
 * @param {import('./workspace.js').ItemView | import('./workspace.js').ReceiptSuggestion} suggestion
 * @returns {import('./workspace.js').DrawerDocument[]}
 */
export const suggestionPapersOf = (suggestion) =>
  stagedDocsOf(suggestion).map((doc) => ({ ...doc, meta: "attached on acceptance" }));
