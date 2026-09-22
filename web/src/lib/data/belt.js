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
 * @returns {"available" | "scanning" | "removed" | "refused" | "undrawable"}
 */
export function documentPreviewStateOf(doc) {
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
 * @param {{ household?: import('./workspace.js').Household | null, documentsByItem?: Record<string, import('./workspace.js').DocumentSummary[]>, today: string, keepId?: string | null }} input
 * @returns {BeltRow[]}
 */
export function beltManifestOf({ household, documentsByItem = {}, today, keepId = null }) {
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
  /* Sorted by date ascending — the belt IS this list. Undated rows fall to
     the later end (days is MAX_SAFE_INTEGER above); ties break on id so two
     items due the same day cannot swap places between loads. */
  rows.sort((a, b) => a.days - b.days || a.id.localeCompare(b.id));
  return rows;
}

/**
 * How many papers the whole belt is carrying — the card's own count line.
 * @param {BeltRow[]} manifest
 * @returns {number}
 */
export const documentCountOf = (manifest) =>
  manifest.reduce((sum, row) => sum + row.docs.length, 0);
