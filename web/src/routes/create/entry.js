/**
 * THE ENTRY: what create's form holds, and the intent it sends (#1120,
 * proposal §2.5; the owner's #1058 decisions, built under #1069).
 *
 * The rules are the engine's (ADR-0034, #1325): what a kind schedules, which
 * subtype it records, that a new item is active, and every "not yet" refusal
 * live in src/ (item-kind.ts, refusals.ts). This module holds what the form
 * shows and offers — the kinds as chips, the recurrence and reminder
 * choices, which fields a kind asks for — and turns what the member typed
 * and chose into the command, unjudged. The form learns whether it can be
 * saved from the engine's dry run (lib/data/dry-run.js).
 *
 *   · recurrence is "every N months", 1 to 120, with 0 meaning once.
 *   · the section has no default (#1058); the engine says "choose a section".
 *   · no assignee: nothing in the model carries one (#1058).
 */

/** The five kinds, in the desk's order, with the desk's glyphs. */
export const KINDS = /** @type {const} */ ([
  { id: "service", glyph: "●", word: "service" },
  { id: "renewal", glyph: "◉", word: "renewal" },
  { id: "inspection", glyph: "◑", word: "inspection" },
  { id: "suggestion", glyph: "○", word: "suggestion" },
  { id: "document", glyph: "◆", word: "document" },
]);

/** @typedef {"service" | "renewal" | "inspection" | "suggestion" | "document"} Kind */
/** @typedef {"renewal" | "service" | "expiry"} ScheduleKind */

export const RECURRENCE_MAX = 120;
/** A new entry comes round yearly unless told otherwise, as on the desk. */
export const RECURRENCE_DEFAULT = 12;
/** Reminder days offered in the reminders callout, furthest first. */
export const REMINDER_CHOICES = [90, 60, 30, 21, 14, 7, 3, 1];
/** The two reminders a new entry starts with (§2.5). */
export const REMINDER_DEFAULT = [21, 7];

/**
 * The kind a stored item reads as, so the form lights the right chip: its
 * subtype when that is one of the five, otherwise what its schedule says.
 * Presentation only — it reads what the engine stored and never decides it.
 * @param {{ subtype?: string | null, scheduleKind?: string | null }} item
 * @returns {Kind | null}
 */
export function kindOf(item) {
  const named = KINDS.find((kind) => kind.id === item.subtype);
  if (named) return named.id;
  if (item.scheduleKind === "renewal") return "renewal";
  if (item.scheduleKind === "service") return "service";
  if (item.scheduleKind === "expiry") return "document";
  return null;
}

/** Whether the form asks for a date for a kind (a suggestion schedules nothing). */
export const kindHasDate = (/** @type {Kind | null} */ kind) => kind !== "suggestion";
/** Whether the form offers a repeat for a kind (a document's expiry happens once). */
export const kindRecurs = (/** @type {Kind | null} */ kind) => kind !== "suggestion" && kind !== "document";

/**
 * One step of the recurrence stepper, held to once..120 months.
 * @param {number} months  0 is once
 * @param {number} delta
 */
export function stepRecurrence(months, delta) {
  const next = Math.round((Number(months) || 0) + delta);
  return Math.min(RECURRENCE_MAX, Math.max(0, next));
}

/** The stepper's value, in words. */
export function recurrenceWords(/** @type {number} */ months) {
  if (!months) return "once";
  if (months === 1) return "every month";
  if (months === 12) return "every 12 months";
  return `every ${months} months`;
}

/**
 * The desk's own recurrence control (#1058d, #1069): a select of one-off,
 * monthly and yearly, plus a fourth, custom choice that takes a count of
 * months. Not the phone's vocabulary (its stepper already works in months) —
 * the desk's, translated to the one range (`RECURRENCE_MAX`) every dialect
 * shares.
 * @param {"once" | "monthly" | "yearly" | "custom" | string} choice
 * @param {string | number} custom  the "every … months" input, read only when choice is "custom"
 */
export function recurrenceOfChoice(choice, custom) {
  if (choice === "once") return 0;
  if (choice === "monthly") return 1;
  if (choice === "yearly") return 12;
  const months = Math.round(Number(custom) || 0);
  return Math.min(RECURRENCE_MAX, Math.max(1, months));
}

/**
 * Reminders, toggled one day at a time, kept furthest-first. Too many is the
 * engine's refusal to make, not a silent trim (#1325).
 * @param {number[]} days
 * @param {number} day
 */
export function toggleReminder(days, day) {
  const next = days.includes(day) ? days.filter((one) => one !== day) : [...days, day];
  return next.sort((a, b) => b - a);
}

/**
 * A household as the form offers it: where an entry can live.
 * @typedef {{ id: string, name: string, currency?: string,
 *   sections: { id: string, name: string, icon: string, accent: string, visible: boolean }[] }} FormHousehold
 */

/**
 * @typedef {{
 *   kind: Kind | null,
 *   name: string,
 *   householdId: string | null,
 *   sectionId: string | null,
 *   provider: string,
 *   reference: string,
 *   dueDate: string,
 *   recurrence: number,
 *   cost: string,
 *   reminderDays: number[],
 *   notes: string,
 * }} Entry
 */

/**
 * A blank entry. The name may arrive prefilled (search's `add "x" as an
 * item`); the section never does (#1058).
 * @param {{ name?: string, householdId?: string | null }} [seed]
 * @returns {Entry}
 */
export function blankEntry({ name = "", householdId = null } = {}) {
  return {
    kind: null,
    name: name.trim().slice(0, 100),
    householdId,
    sectionId: null,
    provider: "",
    reference: "",
    dueDate: "",
    recurrence: RECURRENCE_DEFAULT,
    cost: "",
    reminderDays: [...REMINDER_DEFAULT],
    notes: "",
  };
}

/**
 * An existing item, as the form holds it for editing.
 * @param {{ title?: string, subtype?: string | null, scheduleKind?: string | null, householdId?: string,
 *   sectionId?: string | null, provider?: string | null, reference?: string | null, dueDate?: string | null,
 *   recurrenceMonths?: number | null, costMinor?: number | null, reminderDays?: number[] | null,
 *   notes?: string | null }} item
 * @returns {Entry}
 */
export function entryOf(item) {
  return {
    kind: kindOf(item),
    name: item.title ?? "",
    householdId: item.householdId ?? null,
    sectionId: item.sectionId ?? null,
    provider: item.provider ?? "",
    reference: item.reference ?? "",
    dueDate: item.dueDate ?? "",
    recurrence: item.recurrenceMonths ?? 0,
    cost: item.costMinor === null || item.costMinor === undefined ? "" : (item.costMinor / 100).toFixed(2),
    reminderDays: [...(item.reminderDays ?? [])],
    notes: item.notes ?? "",
  };
}

/** Optional text as the command carries it: trimmed, or left out. @param {string} text */
const optional = (text) => text.trim() || undefined;

/**
 * What the member typed and chose, as `item.upsert` carries it (ADR-0034):
 * the cost as typed and the repeat as chosen, for the engine to read and
 * judge. Never the schedule kind, subtype or status, which follow from the
 * kind in the engine.
 * @param {Entry} entry
 */
export function intentOf(entry) {
  return {
    sectionId: entry.sectionId,
    title: entry.name,
    provider: optional(entry.provider),
    reference: optional(entry.reference),
    cost: optional(entry.cost),
    dueDate: entry.dueDate || undefined,
    recurrenceMonths: entry.recurrence,
    reminderDays: [...entry.reminderDays],
    notes: optional(entry.notes),
  };
}

/**
 * The `item.upsert` a new entry sends: the kind chosen, and the intent.
 * @param {Entry} entry
 * @param {{ householdId: string, currency: string, id: string }} where
 */
export function createCommandOf(entry, { householdId, currency, id }) {
  return {
    type: "item.upsert",
    householdId,
    ...(entry.kind ? { kind: entry.kind } : {}),
    item: { id, ...intentOf(entry), currency },
  };
}

/**
 * Whether the form holds anything a reader would lose by leaving.
 * @param {Entry} entry
 * @param {Entry} start
 */
export function entryChanged(entry, start) {
  return JSON.stringify(entry) !== JSON.stringify(start);
}

/**
 * REVIEW MODE (#1120, proposal §2.5, §2.6): what the relay proposed for a
 * piece of mail, as the form holds it for the reader to amend before it
 * enters the orbit. The fields are pre-filled with the readings; the section
 * still has no default (#1058), and a reading that named no recurrence comes
 * in as once rather than guessing a year. The household is the receipt's,
 * or the reader's own when the mail named none.
 * @param {import('$lib/data/workspace.js').ItemProposal} [proposal]
 * @param {{ householdId?: string | null }} [where]
 * @returns {Entry}
 */
export function entryOfProposal(proposal = {}, { householdId = null } = {}) {
  return {
    ...entryOf({
      title: proposal.title ?? "",
      subtype: proposal.subtype ?? null,
      scheduleKind: proposal.scheduleKind ?? null,
      provider: proposal.provider ?? null,
      reference: proposal.reference ?? null,
      dueDate: proposal.dueDate ?? null,
      recurrenceMonths: proposal.recurrenceMonths ?? null,
      costMinor: proposal.costMinor ?? null,
      notes: proposal.notes ?? null,
    }),
    name: (proposal.title ?? "").slice(0, 100),
    householdId,
    reminderDays: [...REMINDER_DEFAULT],
  };
}

/**
 * The item a reviewed receipt is approved as: the intent create sends, the
 * kind chosen, and the currency the mail was read in. The section travels
 * beside it (approveReceipt), as the reviewed-intake route takes it; the
 * engine maps the kind and keeps the relay's own subtype unless the kind
 * changed.
 * @param {Entry} entry
 * @param {string} currency
 * @param {{ subtype?: string | null, scheduleKind?: string | null }} [reading]  the relay's
 */
export function reviewItemOf(entry, currency, reading = {}) {
  const { sectionId: _section, ...fields } = intentOf(entry);
  return {
    ...fields,
    ...(reading.subtype ? { subtype: reading.subtype } : {}),
    ...(reading.scheduleKind ? { scheduleKind: reading.scheduleKind } : {}),
    ...(entry.kind ? { kind: entry.kind } : {}),
    currency,
  };
}
