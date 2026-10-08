/**
 * THE BELT PAGE'S OWN REFUSALS, until it retires with #1319 (ADR-0034
 * decision 6: the belt is not ported). The rules themselves are the
 * engine's (src/lib/refusals.ts), which refuses whatever slips past these;
 * this is the copy the belt drew before #1325, kept here so nothing outside
 * the belt carries one. Delete with the page.
 */

/** The hint beside a cost field whose comma is not a thousands separator. */
export const COST_FORMAT_HINT = "Use a dot for pence, for example 12.50";

/**
 * A typed cost in minor units: undefined when empty, NaN when it is not a
 * sum of money (see src/lib/refusals.ts costMinorOf, the engine's).
 * @param {string | undefined} text
 */
export function minorOf(text) {
  const clean = String(text ?? "").replace(/[£$€\s]/g, "");
  if (!clean) return undefined;
  if (!/^\d+(\.\d{0,2})?$|^\d{1,3}(,\d{3})+(\.\d{0,2})?$/.test(clean)) return Number.NaN;
  return Math.round(Number(clean.replace(/,/g, "")) * 100);
}

/**
 * Why the phone edit's entry cannot be saved yet, or null.
 * @param {import('../../create/entry.js').Entry} entry
 */
export function refusalOf(entry) {
  if (!entry.name.trim()) return "not yet — give it a name";
  if (!entry.sectionId) return "not yet — choose a section";
  const cost = minorOf(entry.cost);
  if (cost !== undefined && Number.isNaN(cost)) return `not yet — ${COST_FORMAT_HINT.toLowerCase()}`;
  const recurs = entry.kind !== "suggestion" && entry.kind !== "document";
  if (entry.recurrence > 0 && recurs && !entry.dueDate && entry.kind) return "not yet — a repeat needs a due date";
  return null;
}
