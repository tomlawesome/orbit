/**
 * The archive's shape (#462): every document across every household — the
 * belt, unrolled — plus the relay's not-yet-attached catches. Pure mapping;
 * fetching lives in the seam (workspace.js).
 *
 * Provenance is only claimed where it is knowable: a receipt's attachment is
 * "via your relay" by definition, but a stored document's origin is not in
 * the API (asked for alongside filenames in #467), so attached rows say
 * nothing rather than guessing.
 */
import { bandOf, daysUntil } from "./chart.js";

/**
 * One row of the archive table, whichever origin it came from: a stored
 * document against a household's item, or a relay attachment not yet filed.
 *
 * @typedef {object} ArchiveRow
 * @property {string} id
 * @property {string} name
 * @property {?number} sizeBytes
 * @property {string} addedAt
 * @property {?boolean} clean
 * @property {{ id: string, title: string, band: string }} [item]
 * @property {string} [suggestion]
 * @property {string} [receiptId]
 * @property {?string} household
 * @property {boolean} viaRelay
 * @property {boolean} loose
 */

/**
 * @param {object} params
 * @param {import('./workspace.js').Workspace} [params.workspace]
 * @param {import('./workspace.js').Receipt[]} [params.receipts]
 * @param {Record<string, import('./workspace.js').DocumentSummary[]>} [params.documentsByItem]
 * @param {string} params.today
 * @returns {{ groups: { label: string, rows: ArchiveRow[] }[], total: number, bytes: number, megabytes: string, allClean: boolean }}
 */
export function archiveOf({ workspace, receipts = [], documentsByItem = {}, today }) {
  /** @type {ArchiveRow[]} */
  const rows = [];
  for (const household of workspace?.households ?? []) {
    for (const item of household.items ?? []) {
      for (const doc of documentsByItem[item.id] ?? []) {
        rows.push({
          id: doc.id,
          name: doc.displayName,
          sizeBytes: doc.sizeBytes ?? null,
          addedAt: doc.availableAt,
          clean: doc.scanStatus === "clean",
          item: { id: item.id, title: item.title, band: bandOf(daysUntil(item.dueDate, today)) },
          household: household.name,
          viaRelay: false,
          loose: false,
        });
      }
    }
  }
  for (const receipt of receipts.filter((one) => one.canApprove)) {
    const attachments =
      receipt.attachments ??
      (receipt.attachmentCount
        ? [{ displayName: `${receipt.attachmentCount} forwarded document${receipt.attachmentCount === 1 ? "" : "s"}` }]
        : []);
    for (const [index, attachment] of attachments.entries()) {
      rows.push({
        id: `${receipt.id}-att-${index}`,
        name: /** @type {string} */ (attachment.displayName),
        sizeBytes: attachment.sizeBytes ?? null,
        addedAt: /** @type {string} */ (receipt.receivedAt),
        clean: attachment.scannedClean ?? null,
        suggestion: receipt.proposal?.title ?? "Forwarded email",
        receiptId: receipt.id,
        household: null,
        viaRelay: true,
        loose: true,
      });
    }
  }
  rows.sort((a, b) => (a.addedAt < b.addedAt ? 1 : a.addedAt > b.addedAt ? -1 : a.id.localeCompare(b.id)));

  /* Recency groups against the reckoning date, in the order recency yields. */
  const [year, month] = [today.slice(0, 4), today.slice(5, 7)];
  /**
   * @param {string} addedAt
   * @returns {string}
   */
  const labelOf = (addedAt) => {
    if (addedAt.slice(0, 7) === `${year}-${month}`) return "This month";
    if (addedAt.slice(0, 4) === year) return "Earlier this year";
    if (Number(addedAt.slice(0, 4)) === Number(year) - 1) return "Last year";
    return "Older";
  };
  /** @type {{ label: string, rows: ArchiveRow[] }[]} */
  const groups = [];
  for (const row of rows) {
    const label = labelOf(row.addedAt);
    const last = groups[groups.length - 1];
    if (last?.label === label) last.rows.push(row);
    else groups.push({ label, rows: [row] });
  }
  const bytes = rows.reduce((sum, row) => sum + (row.sizeBytes ?? 0), 0);
  return {
    groups,
    total: rows.length,
    bytes,
    megabytes: (bytes / 1048576).toFixed(1),
    allClean: rows.every((row) => row.clean !== false),
  };
}
