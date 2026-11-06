/**
 * EDITING IN THE DRAWER'S OWN ROWS (#1319; owner-decisions §34; design/v19/
 * belt-purpose/round-8/m-colour-per-option.html, `editing` and its
 * choosers): what the rows hold while an item is being edited, the choices
 * each chooser offers, and the `item.upsert` edits a save sends.
 *
 * The rows send what they hold as create does (create/entry.js intentOf):
 * the typed values. Whether they can be saved, and what
 * the date and the repeat schedule, are the engine's (ADR-0034, #1325; ADR-0044), asked through its
 * dry run as the rows change (EditSession).
 */
import { entryOf, intentOf, reminderPairOf } from "../../routes/create/entry.js";
import { every, symbolOf } from "$lib/format.js";
import { sectionColourOf } from "$lib/option-colour.js";

/**
 * @typedef {{
 *   title: string,
 *   dueDate: string,
 *   sectionId: string | null,
 *   recurrence: number,
 *   scheduleKind?: "expiry",  // read-only: present only for an expiry, so the rows offer it no repeat
 *   cost: string,
 *   provider: string,
 *   reference: string,
 *   reminders: string,
 *   notes: string,
 *   importance?: "low" | "normal" | "high" | null,
 * }} Draft
 *
 * @typedef {{ value: string, words: string, colour: string | null, note?: string, figure?: string, unit?: string }} Choice
 */

/** The orbital periods the band offers, once at the top to 2 years at the foot (round 7). */
export const PERIODS = /** @type {[number, string][]} */ (
  [0, 1, 3, 6, 12, 24].map((n) => [n, n ? every(n) : "does not repeat"]));
/** An orbital period in the band's words. @param {number} months */
export function periodWords(months) {
  if (!months) return "does not repeat";
  return PERIODS.find(([n]) => n === months)?.[1] ?? every(months);
}

/** Reminder days as the row reads them: `21d before · 7d before`. @param {number[]} days */
export const remindersWords = (days) => days.map((d) => `${d}d before`).join(" · ");

/**
 * The reminder days a typed row holds: every number in it, furthest first,
 * once each.
 * @param {string} text
 */
export function remindersOf(text) {
  const days = (String(text).match(/\d+/g) ?? []).map(Number);
  return [...new Set(days)].sort((a, b) => b - a);
}

/**
 * The item as its rows hold it for editing: every value the read view
 * shows, as words where it is typed (the cost with its currency sign, the
 * reminders as the row reads them) and as the chooser's value where it is
 * chosen.
 * @param {import('$lib/data/commands.js').CommandItem} item
 * @returns {Draft}
 */
export function draftOf(item) {
  const entry = entryOf(item);
  const symbol = symbolOf(item.currency ?? "GBP");
  /* Only a sign costMinorOf can strip again is prefilled; any other currency
     is typed bare, as it always was, so an untouched cost still reads back. */
  const sign = ["£", "$", "€"].includes(symbol) ? symbol : "";
  return {
    title: entry.name,
    dueDate: entry.dueDate,
    sectionId: entry.sectionId,
    recurrence: entry.recurrence,
    ...(item.scheduleKind === "expiry" ? { scheduleKind: "expiry" } : {}),
    cost: entry.cost ? `${sign}${entry.cost}` : "",
    provider: entry.provider,
    reference: entry.reference,
    reminders: remindersWords(entry.reminderDays),
    notes: entry.notes,
    ...(entry.importance ? { importance: entry.importance } : {}),
  };
}

/**
 * The tiles of "where do these entries go?" (#1332): every kept section but
 * the one going, shown and hidden alike (hidden ones say so), and a section
 * added in this edit once it has a name (it says "new"). Same colour rule as
 * `sectionChoices`; the order is the editor's.
 * @param {{ id: string, name: string, icon?: string, visible?: boolean, fresh?: boolean, removed?: boolean }[]} rows
 * @param {string} going  the section being removed
 * @returns {Choice[]}
 */
export function destinationChoices(rows, going) {
  return rows
    .filter((one) => one.id !== going && !one.removed && one.name.trim())
    .map((one) => ({
      value: one.id,
      words: one.name.trim(),
      colour: sectionColourOf(one),
      ...(one.fresh ? { note: "new" } : one.visible === false ? { note: "hidden" } : {}),
    }));
}

/**
 * The section tiles: the household's visible sections, and the item's own
 * even if hidden, each in its colour.
 * @param {{ id: string, name: string, icon?: string, visible?: boolean }[]} sections
 * @param {string | null} current
 * @returns {Choice[]}
 */
export function sectionChoices(sections, current) {
  return sections
    .filter((one) => one.visible !== false || one.id === current)
    .map((one) => ({ value: one.id, words: one.name, colour: sectionColourOf(one) }));
}

/**
 * The band's cells: the six periods, and the item's own when it is none of
 * them (every 2 months), in its place, so keeping it stays a choice. Each
 * reads its figure beside its unit. The date an item would next come round
 * to is the engine's to say (the dry run of item.complete, ADR-0034, #1337),
 * never added up here, so a cell has no "then <date>" foot line of its own.
 * @param {number} current
 * @returns {Choice[]}
 */
export function periodChoices(current) {
  /** @type {number[]} */
  const months = PERIODS.map(([n]) => n);
  if (current && !months.includes(current)) months.push(current);
  months.sort((a, b) => a - b);
  return months.map((n) => {
    const years = n % 12 === 0;
    return {
      value: String(n),
      words: periodWords(n),
      colour: null,
      figure: n ? String(years ? n / 12 : n) : "once",
      unit: n ? (years ? (n === 12 ? "year" : "years") : (n === 1 ? "month" : "months")) : "",
      note: n ? "from when it's done" : "once",
    };
  });
}

/**
 * The edits a save of the rows sends: what they hold, as intent — the cost
 * as typed, the reminders as the numbers typed, the repeat as chosen. The
 * engine judges them and keeps the item's schedule (ADR-0044).
 * @param {Draft} draft
 * @returns {import('$lib/data/commands.js').ItemEdits}
 */
export function editsOf(draft) {
  const fields = intentOf({
    name: draft.title,
    householdId: null,
    sectionId: draft.sectionId,
    provider: draft.provider,
    reference: draft.reference,
    dueDate: draft.dueDate,
    recurrence: draft.recurrence,
    cost: draft.cost,
    reminderDays: remindersOf(draft.reminders),
    notes: draft.notes,
    importance: draft.importance ?? null,
  });
  return fields;
}

/**
 * A SUGGESTION AMENDED IN ITS DRAWER (#1319: "a suggestion is reviewed in its
 * home drawer", owner-decisions §34, superseding §27's belt card). What the
 * relay read, as the item it would become, so the drawer's own rows edit it
 * exactly as they edit a filed item: the reminders a new entry starts with
 * (the member's own pair from Settings, as the create forms and the review
 * sheet start them, or the default when it could not be read), the section
 * the approval would file it into unless another is chosen.
 * @param {import('$lib/data/workspace.js').ReceiptSuggestion} suggestion
 * @param {{ householdId: string, sectionId: string | null }} where
 * @param {{ reminders?: { firstWarningDays: number | null, finalWarningDays: number | null } | null }} [read]
 *   the member's pair, as workspace.js readReminders answers it
 * @returns {import('$lib/data/commands.js').CommandItem}
 */
export function proposedItemOf(suggestion, { householdId, sectionId }, { reminders } = {}) {
  const p = suggestion.proposal ?? {};
  return {
    id: suggestion.id,
    householdId,
    sectionId,
    status: "suggested",
    title: p.title ?? suggestion.title ?? "",
    subtype: p.subtype ?? null,
    scheduleKind: p.scheduleKind ?? suggestion.scheduleKind ?? null,
    provider: p.provider ?? suggestion.provider ?? null,
    reference: p.reference ?? null,
    dueDate: p.dueDate ?? suggestion.renewsOn ?? null,
    recurrenceMonths: p.recurrenceMonths ?? null,
    costMinor: p.costMinor ?? suggestion.costMinor ?? null,
    currency: p.currency ?? suggestion.currency ?? "GBP",
    reminderDays: reminderPairOf(reminders),
    notes: p.notes ?? null,
  };
}

/**
 * The amended item approveReceipt sends, from the edits a save of
 * proposedItemOf's rows makes (editsOf): the fields as written and the
 * relay's own reading of the subtype and schedule, which the engine keeps
 * (ADR-0034, #1325, ADR-0044); and the
 * section the rows chose, which the approval takes apart.
 * @param {import('$lib/data/commands.js').CommandItem} item  proposedItemOf's
 * @param {import('$lib/data/commands.js').ItemEdits} edits
 * @returns {{ item: import('$lib/data/workspace.js').ItemProposal, sectionId: string | null }}
 */
export function amendedOf(item, edits) {
  const { sectionId = null, ...fields } = edits;
  /** @type {Record<string, unknown>} */
  const out = { ...fields, subtype: item.subtype, scheduleKind: item.scheduleKind, currency: item.currency ?? "GBP" };
  for (const key of Object.keys(out)) if (out[key] === undefined || out[key] === null) delete out[key];
  return { item: /** @type {import('$lib/data/workspace.js').ItemProposal} */ (out), sectionId };
}

/**
 * @typedef {{
 *   key: "due" | "snooze" | "done" | "section" | "importance" | "months" | "reminders" | "timezone" | "currency",
 *   label: string,
 *   heading: string,
 *   value: string | null,
 *   choices: Choice[],
 *   colour?: string | null,
 *   days?: number[],
 *   due?: string | null,
 *   today: string,
 * }} ChooserAsk  what the chooser card beside the drawer is asked
 */

/**
 * What the chooser card shows for the value being chosen: the calendar for
 * the due date, the tiles for section, the band for the period.
 * @param {{ key: "due" | "section" | "importance" | "months", label: string }} choosing
 * @param {Draft} draft
 * @param {{ id: string, name: string, icon?: string, visible?: boolean }[]} sections
 * @param {string} today
 * @returns {ChooserAsk | null}  null for a key that has no chooser
 */
export function chooserAskOf(choosing, draft, sections, today) {
  const { key, label } = choosing;
  const base = { key, label, heading: label, today };
  if (key === "due") return { ...base, heading: "due date", value: draft.dueDate || null, choices: [] };
  if (key === "section") return { ...base, value: draft.sectionId, choices: sectionChoices(sections, draft.sectionId) };
  /* round 7 S: P's three tiles, in the item's section colour */
  if (key === "importance") return { ...base, value: draft.importance ?? null, choices: [], colour: sectionColourOf(sections.find((one) => one.id === draft.sectionId)) };
  if (key !== "months") return null;
  return { ...base, value: String(draft.recurrence), choices: periodChoices(draft.recurrence) };
}
