/**
 * The belt's manifest (#458): the workspace's own items and documents in the
 * shape the band seats them by.
 *
 * Pure, like chart.js and documents.js — the fetching lives in the seam
 * (workspace.js) and the geometry lives in the screen's band.js. This module
 * is only the vocabulary: which items are in the belt, in what order, what
 * each one's rock says, and what papers ride beside it.
 *
 * THE ORDER IS THE LAW. The belt is the manifest bent round a ring, so the
 * rows come out sorted by due date ascending and nothing downstream ever
 * re-sorts them: neighbours in the belt are neighbours in the list (owner,
 * 2026-08-16). An item with no date has no place in time, so it seats at the
 * later end rather than inventing one — the corridor's own rule for undated
 * rows (chart.js corridorOf), said in the belt's language.
 *
 * The urgency bands are chart.js's, not a fork: bandOf() decides, and only the
 * NAMES are translated here, because the mockup's card and rim classes are the
 * manifest's four short words (over / soon / up / ok) rather than the chart
 * key's long ones.
 */
import { bandOfKind, daysUntil, kindOfItem } from "./chart.js";
/* Relative, like chart.js's own imports: this module is pure and is exercised
   straight from node by the unit suite, which knows no SvelteKit aliases. */
import { longDate, tminus } from "../format.js";

/**
 * chart.js's bands, in the belt's own four-letter vocabulary.
 * @type {Record<string, "over" | "soon" | "up" | "ok" | "ended">}
 */
export const BELT_BAND = {
  overdue: "over",
  "due-soon": "soon",
  upcoming: "up",
  ok: "ok",
  unscheduled: "ok",
  /* #1005: a one-off past its date has ended, not fallen overdue. */
  ended: "ended",
};

/* The band's captions carry the short date the manifest uses — "29 Aug" —
   which format.js does not export because home spells it inline. Same
   options, so the two agree. */
/**
 * @param {string} iso
 * @returns {string}
 */
export const shortDate = (iso) =>
  new Date(iso + "T00:00:00Z").toLocaleDateString("en-GB", {
    day: "2-digit", month: "short", timeZone: "UTC",
  });

/**
 * The document plate's own words: "12 June 2026" from a stored instant.
 * @param {string} iso
 * @returns {string}
 */
const arrivedOn = (iso) =>
  new Date(iso).toLocaleDateString("en-GB", {
    day: "numeric", month: "long", year: "numeric", timeZone: "UTC",
  });

/**
 * workspace.js's document size vocabulary, so "240 KB" means one thing.
 * @param {?number} [bytes]
 * @returns {string}
 */
export const sizeLabel = (bytes) => {
  if (bytes === null || bytes === undefined) return "unknown size";
  return bytes >= 1024 * 1024
    ? `${Math.round((bytes / (1024 * 1024)) * 10) / 10} MB`
    : `${Math.round(bytes / 1024)} KB`;
};

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
 * What the band's caption says about the date. A renewal or a service simply
 * names the day; a one-off (#1005) says what the day IS -- "ends 29 Aug" while
 * it is still ahead, "ended 29 Aug" once it has passed.
 *
 * @param {string} kind
 * @param {?number} days
 * @param {string} date  the short date, "29 Aug"
 * @returns {string}
 */
export const whenOf = (kind, days, date) => {
  if (kind !== "expiry") return date;
  return `${days !== null && days < 0 ? "ended" : "ends"} ${date}`;
};

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
 * One document, as a body in the band and as its own card.
 *
 * `href` is the honest v1 display the owner ruled for (§15): details, and the
 * original in your hands. #476's page-one render is a seam, not a promise —
 * see the marked place in the screen.
 * @param {import('./workspace.js').DocumentSummary} doc
 * @returns {BeltDocumentRow}
 */
function documentRowOf(doc) {
  const { plate, type } = kindOfFile(doc.mediaType);
  return {
    id: doc.id,
    name: doc.displayName,
    size: sizeLabel(doc.sizeBytes),
    added: doc.availableAt ? arrivedOn(doc.availableAt) : "unknown",
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
    deleteAfter: doc.deleteAfter ? arrivedOn(doc.deleteAfter) : null,
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
  /* #1145: a suggestion's paper is staged with the mail, not stored -- there
     is no page to draw until the suggestion is accepted, and nothing to
     download, restore or refuse. Read first: a staged paper has no lifecycle
     word of its own, so every test below would otherwise call it scanning. */
  if (doc.staged) return "staged";
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
 *   mail and is attached only on acceptance -- no page, no download
 */

/**
 * One rock in the belt: the manifest's own item, rebuilt with every string
 * the card and ring caption need already reckoned.
 *
 * @typedef {object} BeltRow
 * @property {string} id
 * @property {string} title
 * @property {?string} section
 * @property {string} kind
 * @property {?string} provider
 * @property {?string} reference
 * @property {?string} notes
 * @property {?{reference?: string, notes?: string}} metadataStatus
 * @property {string} status
 * @property {?string} snoozedUntil
 * @property {?string} due
 * @property {number} days
 * @property {"over" | "soon" | "up" | "ok" | "ended"} urg
 * @property {string} t
 * @property {string} when
 * @property {string} longWhen
 * @property {?number} cost
 * @property {boolean} costIsEstimate
 * @property {string} currency
 * @property {?number} months
 * @property {number[]} remind
 * @property {BeltDocumentRow[]} docs
 * @property {import('./commands.js').CommandItem} item
 * @property {?import('./workspace.js').ItemView} [suggestion]  set on the one
 *   seat that is a mail-in suggestion (#1145): the receipt's own view, for
 *   the card's form and its two decisions; every other row leaves it unset
 */

/**
 * The whole belt for one household: every active item as a rock in date
 * order, each one's papers seated beside it, every string the card and the
 * caption need already reckoned against the same today the chart uses.
 *
 * `keepId` is the deep arrival: a retired or cancelled item is not in the
 * manifest, but if that is the item you followed a link to it must still have
 * a seat, or the address would resolve to somebody else's screen.
 *
 * #624: `keepId` is annotated because its `= null` default otherwise infers
 * the parameter as `null`, and every caller passing a real id is then a type
 * error. That was invisible while the workspace seam handed callers `any`.
 *
 * `suggestion` (#1145) is the visitor: a mail-in receipt arrived at by its
 * own address takes a seat at the date the relay read, hollow, so it can be
 * looked at among its neighbours in time before it is accepted. Only that
 * arrival seats it: the belt IS the manifest, and a suggestion is not in the
 * manifest until it is accepted into it, so a filed item's belt carries none.
 *
 * @param {{ household?: import('./workspace.js').Household | null, documentsByItem?: Record<string, import('./workspace.js').DocumentSummary[]>, today: string, keepId?: string | null, suggestion?: import('./workspace.js').ItemView | null }} input
 * @returns {BeltRow[]}
 */
export function beltManifestOf({ household, documentsByItem = {}, today, keepId = null, suggestion = null }) {
  const sections = new Map((household?.sections ?? []).map((s) => [s.id, s.name]));
  const rows = (household?.items ?? [])
    .filter((item) => item.status === "active" || item.id === keepId)
    .map((item) => {
      const days = daysUntil(item.dueDate, today);
      const kind = kindOf(item);
      const urg = BELT_BAND[bandOfKind(kind, days)];
      return {
        id: item.id,
        title: item.title,
        section: sections.get(item.sectionId) ?? null,
        kind,
        provider: item.provider ?? null,
        reference: item.reference ?? null,
        notes: item.notes ?? null,
        /* #941: why a Tier 1 field is absent, when it is. The card renders the
           row on the marker as well as on the value -- a damaged note that
           travelled no further than here would reach the screen as one nobody
           had written, which is the failure the marker exists to prevent. */
        metadataStatus: item.metadataStatus ?? null,
        status: item.status,
        snoozedUntil: item.snoozedUntil ?? null,
        due: item.dueDate ?? null,
        days: days ?? Number.MAX_SAFE_INTEGER,
        urg,
        t: item.dueDate ? tminus(item.dueDate, today) : "—",
        when: item.dueDate ? whenOf(kind, days, shortDate(item.dueDate)) : "unscheduled",
        longWhen: item.dueDate ? longDate(item.dueDate) : "unscheduled",
        cost: item.costMinor ?? null,
        /* costIsEstimate is not in WorkspaceItem's own typedef (workspace.js,
           out of this pass's scope) though the fixtures and chart.js both
           carry it -- cast rather than widen a typedef this file does not own. */
        costIsEstimate: Boolean(/** @type {{ costIsEstimate?: boolean }} */ (item).costIsEstimate),
        currency: item.currency ?? "GBP",
        months: item.recurrenceMonths ?? null,
        remind: item.reminderDays ?? [],
        docs: (documentsByItem[item.id] ?? []).map(documentRowOf),
        /* The raw record the command builders write against (#455): version,
           householdId and all. The view-model's joins never travel.
           WorkspaceItem itself carries no householdId (see the cast above) --
           real records do, which is what CommandItem (commands.js) models. */
        item: /** @type {import('./commands.js').CommandItem} */ (item),
      };
    });
  if (suggestion) rows.push(suggestionRowOf(suggestion, today));
  /* Sorted by date ascending — the belt IS this list. Undated rows fall to
     the later end (days is MAX_SAFE_INTEGER above); ties break on id so two
     items due the same day cannot swap places between loads. */
  rows.sort((a, b) => a.days - b.days || a.id.localeCompare(b.id));
  return rows;
}

/**
 * "PDF" from a paper's own name, for a staged paper the list gives no media
 * type for: the plate the reading card holds still.
 * @param {string} name
 * @returns {string}
 */
const plateOfName = (name) => {
  const dot = name.lastIndexOf(".");
  const ext = dot > 0 ? name.slice(dot + 1) : "";
  return ext && ext.length <= 5 ? ext.toUpperCase() : "FILE";
};

/**
 * A suggestion's papers as they ride beside it (#1145): staged with the
 * mail, named where the list names them (#467; the fixture does, live data
 * gives the count), attached only on acceptance. No page, no download.
 *
 * @param {import('./workspace.js').ItemView} suggestion
 * @returns {BeltDocumentRow[]}
 */
function stagedDocsOf(suggestion) {
  const arrived = suggestion.receivedAt ? arrivedOn(suggestion.receivedAt) : "unknown";
  const named = suggestion.attachments?.map((a) => ({
    name: a.displayName ?? "forwarded document",
    size: sizeLabel(a.sizeBytes),
    clean: Boolean(/** @type {{ scannedClean?: boolean }} */ (a).scannedClean),
  }));
  const count = suggestion.attachmentCount ?? 0;
  const papers = named ?? Array.from({ length: count }, (_, j) => ({
    name: count === 1 ? "forwarded document" : `forwarded document ${j + 1}`, size: "unknown size", clean: false,
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
    previewHref: "",
    lifecycle: null,
    mediaType: null,
    ready: false,
    deleteAfter: null,
    staged: true,
  }));
}

/**
 * The suggestion's own seat (#1145): the receipt in the row shape, at the
 * date the relay read (undated falls to the later end, like any undated
 * row), its papers staged beside it. The card draws the amend-then-accept
 * form from `suggestion`; nothing in `item` is ever written against, because
 * a suggestion has no commands -- it has two decisions.
 *
 * @param {import('./workspace.js').ItemView} suggestion
 * @param {string} today
 * @returns {BeltRow}
 */
export function suggestionRowOf(suggestion, today) {
  const proposal = suggestion.proposal ?? {};
  const due = proposal.dueDate ?? suggestion.renewsOn ?? null;
  const days = daysUntil(due, today);
  const scheduleKind = proposal.scheduleKind ?? suggestion.scheduleKind ?? null;
  const kind = scheduleKind === "expiry" ? "expiry" : "suggestion";
  const title = proposal.title ?? suggestion.title ?? "Forwarded email";
  const currency = proposal.currency ?? suggestion.currency ?? "GBP";
  return {
    id: suggestion.id,
    title,
    section: null,
    kind,
    provider: proposal.provider ?? suggestion.provider ?? null,
    reference: proposal.reference ?? null,
    notes: null,
    metadataStatus: null,
    status: "suggested",
    snoozedUntil: null,
    due,
    days: days ?? Number.MAX_SAFE_INTEGER,
    /* The rock is hollow and wears the accent, not an urgency (band.js); the
       T-label's own tone still comes from the bands everything else uses. */
    urg: BELT_BAND[bandOfKind(kind === "expiry" ? "expiry" : "renewal", days)],
    t: due ? tminus(due, today) : "—",
    when: due ? whenOf(kind, days, shortDate(due)) : "undated",
    longWhen: due ? longDate(due) : "undated",
    cost: proposal.costMinor ?? suggestion.costMinor ?? null,
    costIsEstimate: true,
    currency,
    months: proposal.recurrenceMonths ?? null,
    remind: [],
    docs: stagedDocsOf(suggestion),
    item: /** @type {import('./commands.js').CommandItem} */ (/** @type {unknown} */ ({
      id: suggestion.id, householdId: suggestion.householdId ?? "", title, status: "suggested", currency,
    })),
    suggestion,
  };
}

/**
 * How many papers the whole belt is carrying — the card's own count line.
 * @param {BeltRow[]} manifest
 * @returns {number}
 */
export const documentCountOf = (manifest) =>
  manifest.reduce((sum, row) => sum + row.docs.length, 0);
