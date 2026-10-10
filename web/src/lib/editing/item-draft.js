/**
 * EDITING IN THE DRAWER'S OWN ROWS (#1319; owner-decisions §34; design/v19/
 * belt-purpose/round-8/m-colour-per-option.html, `editing` and its
 * choosers): what the rows hold while an item is being edited, the choices
 * each chooser offers, and the `item.upsert` edits a save sends.
 *
 * The rows send what they hold as create does (create/entry.js intentOf):
 * the typed values and the kind chosen. Whether they can be saved, and what
 * the kind schedules, are the engine's (ADR-0034, #1325), asked through its
 * dry run as the rows change (EditSession).
 */
import { entryOf, intentOf, REMINDER_DEFAULT } from "../../routes/create/entry.js";
import { dayMonthYear, every } from "$lib/format.js";
import { addMonths } from "./calendar.js";
import { sectionColourOf, typeColourOf } from "$lib/option-colour.js";

/**
 * @typedef {{
 *   title: string,
 *   dueDate: string,
 *   sectionId: string | null,
 *   kind: string | null,
 *   recurrence: number,
 *   cost: string,
 *   provider: string,
 *   reference: string,
 *   reminders: string,
 *   notes: string,
 * }} Draft
 *
 * @typedef {{ value: string, words: string, colour: string | null, note?: string, figure?: string, unit?: string }} Choice
 */

/** The orbital periods the band offers, once at the top to 2 years at the foot (round 7). */
export const PERIODS = /** @type {const} */ ([
  [0, "does not repeat"], [1, "every month"], [3, "every 3 months"],
  [6, "every 6 months"], [12, "every year"], [24, "every 2 years"],
]);
/** The three types round 8 colours, in its order. */
export const TYPES = ["service", "renewal", "inspection"];

const SYMBOLS = /** @type {Record<string, string>} */ ({ GBP: "£", EUR: "€", USD: "$" });

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
  const sign = SYMBOLS[item.currency ?? "GBP"] ?? "";
  return {
    title: entry.name,
    dueDate: entry.dueDate,
    sectionId: entry.sectionId,
    kind: entry.kind,
    recurrence: entry.recurrence,
    cost: entry.cost ? `${sign}${entry.cost}` : "",
    provider: entry.provider,
    reference: entry.reference,
    reminders: remindersWords(entry.reminderDays),
    notes: entry.notes,
  };
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
 * The type tiles: service, renewal, inspection; and the item's own kind
 * too when it is another (a document's expiry), so keeping it stays a
 * choice.
 * @param {string | null} current
 * @returns {Choice[]}
 */
export function typeChoices(current) {
  const kinds = current && !TYPES.includes(current) ? [...TYPES, current] : TYPES;
  return kinds.map((kind) => ({ value: kind, words: kind, colour: typeColourOf(kind) }));
}

/**
 * The band's cells: the six periods, and the item's own when it is none of
 * them (every 2 months), in its place, so keeping it stays a choice. Each
 * reads its figure beside its unit, and its foot line the date it would
 * next come round to after `due`.
 * @param {number} current @param {string | null} due
 * @returns {Choice[]}
 */
export function periodChoices(current, due) {
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
      note: n ? (due ? `then ${dayMonthYear(addMonths(due, n))}` : "") : "once",
    };
  });
}

/**
 * The edits a save of the rows sends: what they hold, as intent — the cost
 * as typed, the reminders as the numbers typed, the repeat as chosen — and
 * the kind chosen. The engine judges them and decides what the kind
 * schedules (ADR-0034, #1325).
 * @param {Draft} draft
 * @returns {import('$lib/data/commands.js').ItemEdits}
 */
export function editsOf(draft) {
  const fields = intentOf({
    kind: /** @type {any} */ (draft.kind),
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
  });
  return { ...fields, ...(draft.kind ? { kind: draft.kind } : {}) };
}

/**
 * A SUGGESTION AMENDED IN ITS DRAWER (#1319: "a suggestion is reviewed in its
 * home drawer", owner-decisions §34, superseding §27's belt card). What the
 * relay read, as the item it would become, so the drawer's own rows edit it
 * exactly as they edit a filed item: the reminders a new entry starts with
 * (create's, as the review sheet's form starts them), the section the
 * approval would file it into unless another is chosen.
 * @param {import('$lib/data/workspace.js').ReceiptSuggestion} suggestion
 * @param {{ householdId: string, sectionId: string | null }} where
 * @returns {import('$lib/data/commands.js').CommandItem}
 */
export function proposedItemOf(suggestion, { householdId, sectionId }) {
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
    reminderDays: [...REMINDER_DEFAULT],
    notes: p.notes ?? null,
  };
}

/**
 * The amended item approveReceipt sends, from the edits a save of
 * proposedItemOf's rows makes (editsOf): the fields as written, the kind
 * chosen, and the relay's own reading of the subtype and schedule, which the
 * engine keeps unless the kind was changed (ADR-0034, #1325); and the
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
 *   key: "due" | "snooze" | "done" | "section" | "type" | "months" | "timezone" | "currency",
 *   label: string,
 *   heading: string,
 *   value: string | null,
 *   choices: Choice[],
 *   today: string,
 * }} ChooserAsk  what the chooser card beside the drawer is asked
 */

/**
 * What the chooser card shows for the value being chosen: the calendar for
 * the due date, the tiles for section and type, the band for the period.
 * @param {{ key: "due" | "section" | "type" | "months", label: string }} choosing
 * @param {Draft} draft
 * @param {{ id: string, name: string, icon?: string, visible?: boolean }[]} sections
 * @param {string} today
 * @returns {ChooserAsk}
 */
export function chooserAskOf(choosing, draft, sections, today) {
  const { key, label } = choosing;
  const base = { key, label, heading: label, today };
  if (key === "due") return { ...base, heading: "due date", value: draft.dueDate || null, choices: [] };
  if (key === "section") return { ...base, value: draft.sectionId, choices: sectionChoices(sections, draft.sectionId) };
  if (key === "type") return { ...base, value: draft.kind, choices: typeChoices(draft.kind) };
  return { ...base, value: String(draft.recurrence), choices: periodChoices(draft.recurrence, draft.dueDate || null) };
}
