/**
 * THE ENTRY: what create's form holds, and the item it becomes (#1120,
 * proposal §2.5; the owner's #1058 decisions, built under #1069).
 *
 * Pure and shared, so the pocket's create page, the item's edit sheet and the
 * unit suite all read one set of rules:
 *
 *   · kind → schedule (#1058): service and renewal schedule themselves;
 *     inspection is a service with subtype `inspection`, so an MOT comes
 *     round; document is an expiry with an optional date, and happens once;
 *     suggestion schedules nothing.
 *   · recurrence is "every N months", 1 to 120 (`recurrenceMonths`' range),
 *     with 0 meaning once.
 *   · the section has no default: nothing saves until one is chosen, and the
 *     reason is said beside the save button (#1058).
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
/** The model's own ceiling on reminders per item. */
export const REMINDER_MAX = 8;

/**
 * What a kind schedules (#1058).
 * @param {Kind | null | undefined} kind
 * @returns {{ scheduleKind: ScheduleKind | undefined, subtype: string | undefined }}
 */
export function scheduleOf(kind) {
  switch (kind) {
    case "service": return { scheduleKind: "service", subtype: "service" };
    case "renewal": return { scheduleKind: "renewal", subtype: "renewal" };
    case "inspection": return { scheduleKind: "service", subtype: "inspection" };
    case "document": return { scheduleKind: "expiry", subtype: "document" };
    case "suggestion": return { scheduleKind: undefined, subtype: "suggestion" };
    default: return { scheduleKind: undefined, subtype: undefined };
  }
}

/**
 * The kind an existing item reads as: its subtype when that is one of the
 * five, otherwise what its schedule says. Null when neither says.
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

/** Whether a kind asks for a date at all (a suggestion schedules nothing). */
export const kindHasDate = (/** @type {Kind | null} */ kind) => kind !== "suggestion";
/** Whether a kind can come round (a document's expiry happens once). */
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
 * Reminders, toggled one day at a time, kept furthest-first and within the
 * model's ceiling.
 * @param {number[]} days
 * @param {number} day
 */
export function toggleReminder(days, day) {
  const next = days.includes(day) ? days.filter((one) => one !== day) : [...days, day];
  return next.sort((a, b) => b - a).slice(0, REMINDER_MAX);
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

/**
 * The message shown beside a cost field whose comma is not a thousands
 * separator in a valid position (#1151 W1-F1/W1-S4): Orbit is a UK product,
 * so a comma is only ever a thousands separator, never a decimal point.
 */
export const COST_FORMAT_HINT = "Use a dot for pence, for example 12.50";

/**
 * A typed cost in minor units: undefined when empty, NaN when it is not a
 * sum of money. Accepts "84", "84.5", "£84.50", "1,250", "1,250.00". A
 * comma is only accepted as a thousands separator in a valid grouping
 * position — groups of exactly three digits after it, none after the
 * decimal point — so "12,50" and "1,2500" are rejected rather than
 * silently reinterpreted (#1151 W1-F1/W1-S4).
 * @param {string} text
 */
export function minorOf(text) {
  const clean = String(text ?? "").replace(/[£$€\s]/g, "");
  if (!clean) return undefined;
  if (!/^\d+(\.\d{0,2})?$|^\d{1,3}(,\d{3})+(\.\d{0,2})?$/.test(clean)) return Number.NaN;
  return Math.round(Number(clean.replace(/,/g, "")) * 100);
}

/**
 * Why the entry cannot be saved yet, in the refusal vocabulary, or null
 * when it can. The first reason only: one line beside the button.
 * @param {Entry} entry
 */
export function refusalOf(entry) {
  if (!entry.name.trim()) return "not yet — give it a name";
  if (!entry.sectionId) return "not yet — choose a section";
  const cost = minorOf(entry.cost);
  if (cost !== undefined && Number.isNaN(cost)) return `not yet — ${COST_FORMAT_HINT.toLowerCase()}`;
  if (entry.recurrence > 0 && kindRecurs(entry.kind) && !entry.dueDate && entry.kind)
    return "not yet — a repeat needs a due date";
  return null;
}

/**
 * The fields an entry writes, shared by create and edit. Schedule follows
 * the kind and only exists with a date (the schema's rule); recurrence only
 * with a schedule that comes round.
 * @param {Entry} entry
 * @param {{ scheduleKind?: string | undefined }} [keep] an edited item's own schedule, which wins
 */
export function fieldsOf(entry, keep = {}) {
  const dated = kindHasDate(entry.kind) && entry.dueDate ? entry.dueDate : undefined;
  const scheduleKind = dated
    ? (/** @type {ScheduleKind | undefined} */ (keep.scheduleKind) ?? scheduleOf(entry.kind).scheduleKind)
    : undefined;
  const recurs = Boolean(scheduleKind) && scheduleKind !== "expiry" && entry.recurrence > 0;
  const cost = minorOf(entry.cost);
  return {
    sectionId: /** @type {string} */ (entry.sectionId),
    title: entry.name.trim(),
    provider: entry.provider.trim() || undefined,
    reference: entry.reference.trim() || undefined,
    costMinor: cost === undefined || Number.isNaN(cost) ? undefined : cost,
    dueDate: dated,
    scheduleKind,
    recurrenceMonths: recurs ? Math.min(RECURRENCE_MAX, entry.recurrence) : undefined,
    reminderDays: [...entry.reminderDays],
    notes: entry.notes.trim() || undefined,
  };
}

/**
 * The `item.upsert` a new entry sends.
 * @param {Entry} entry
 * @param {{ householdId: string, currency: string, id: string }} where
 */
export function createCommandOf(entry, { householdId, currency, id }) {
  return {
    type: "item.upsert",
    householdId,
    item: {
      id,
      ...fieldsOf(entry),
      subtype: scheduleOf(entry.kind).subtype,
      currency,
      status: "active",
    },
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
 * The item a reviewed receipt is approved as: the same fields create writes,
 * the kind's subtype, and the currency the mail was read in. The section
 * travels beside it (approveReceipt), as the reviewed-intake route takes it.
 * @param {Entry} entry
 * @param {string} currency
 */
export function reviewItemOf(entry, currency) {
  const { sectionId: _section, ...fields } = fieldsOf(entry);
  return { ...fields, subtype: scheduleOf(entry.kind).subtype, currency };
}
