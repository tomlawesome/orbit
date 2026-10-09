/**
 * WHY A CHANGE CANNOT BE MADE YET, IN THE MEMBER'S WORDS (ADR-0034 decision 4,
 * #1325). Every refusal a member reads is worded here, once, and travels over
 * the API with its code; the browser shows the words it is given and never
 * rewrites them. The words are the ones the front end used before the rules
 * moved (create's refusalOf, the drawer's editsOf and completion), so a member
 * sees nothing change.
 *
 * Developer-facing errors -- a malformed command, a schema bound -- keep their
 * own plain messages in workspace.ts; these are only the "not yet" ones.
 */
import { AppError } from "@/lib/errors";
import { kindRecurs, type ItemKind } from "@/lib/item-kind";

/** The model's own ceiling on reminders per item (workspaceItemSchema). */
export const REMINDER_MAX = 8;
/** The model's own ceiling on how far ahead a reminder may be. */
export const REMINDER_DAYS_MAX = 365;

/**
 * Orbit is a UK product, so a comma in a typed cost is only ever a thousands
 * separator, never a decimal point (#1151 W1-F1/W1-S4).
 */
export const COST_FORMAT_HINT = "use a dot for pence, for example 12.50";

export const refusalWords = {
  name: "not yet — give it a name",
  section: "not yet — choose a section",
  cost: `not yet — ${COST_FORMAT_HINT}`,
  repeatNeedsDate: "not yet — a repeat needs a due date",
  reminderCount: `not yet — at most ${REMINDER_MAX} reminders`,
  reminderDays: `not yet — a reminder is at most ${REMINDER_DAYS_MAX} days before`,
  completedDate: "not yet — choose the day it was done",
  snoozeFloor: "not yet — snooze to a day after today",
} as const;

export type RefusalRule = keyof typeof refusalWords;

/** The code each refusal travels with; the browser keys nothing off it but tests do. */
export const refusalCodes: Record<RefusalRule, string> = {
  name: "item_name_missing",
  section: "item_section_missing",
  cost: "cost_format",
  repeatNeedsDate: "repeat_needs_date",
  reminderCount: "too_many_reminders",
  reminderDays: "reminder_too_far_ahead",
  completedDate: "completed_date_missing",
  snoozeFloor: "snooze_not_after_today",
};

/**
 * A change refused in the member's words: 422, the rule's code, the words as
 * the member reads them.
 */
export class Refusal extends AppError {
  constructor(public readonly rule: RefusalRule) {
    super(refusalCodes[rule], refusalWords[rule], 422);
    this.name = "Refusal";
  }
}

/**
 * A typed cost in minor units: undefined when empty, NaN when it is not a sum
 * of money. Accepts "84", "84.5", "£84.50", "1,250", "1,250.00". A comma is
 * only accepted as a thousands separator in a valid grouping position -- groups
 * of exactly three digits after it, none after the decimal point -- so "12,50"
 * and "1,2500" are refused rather than silently reinterpreted (#1151
 * W1-F1/W1-S4).
 */
export function costMinorOf(text: string | undefined | null): number | undefined {
  const clean = String(text ?? "").replace(/[£$€\s]/g, "");
  if (!clean) return undefined;
  if (!/^\d+(\.\d{0,2})?$|^\d{1,3}(,\d{3})+(\.\d{0,2})?$/.test(clean)) return Number.NaN;
  return Math.round(Number(clean.replace(/,/g, "")) * 100);
}

/** What a new or edited item says, as the checks below read it. */
export interface ItemIntentFacts {
  title?: unknown;
  sectionId?: unknown;
  cost?: unknown;
  dueDate?: unknown;
  recurrenceMonths?: unknown;
  reminderDays?: unknown;
}

/**
 * The first reason an item cannot be saved yet, or null when it can. The
 * first only: one line beside the save button. The order is the browser's
 * before the rules moved -- name, section, cost, a repeat with no date, then
 * the reminders' two ceilings.
 */
export function itemRefusal(item: ItemIntentFacts, kind: ItemKind | null | undefined): RefusalRule | null {
  if (typeof item.title !== "string" || !item.title.trim()) return "name";
  if (typeof item.sectionId !== "string" || !item.sectionId) return "section";
  if (typeof item.cost === "string" && Number.isNaN(costMinorOf(item.cost))) return "cost";
  const months = typeof item.recurrenceMonths === "number" ? item.recurrenceMonths : 0;
  if (months > 0 && kind && kindRecurs(kind) && !item.dueDate) return "repeatNeedsDate";
  const days = Array.isArray(item.reminderDays) ? item.reminderDays : [];
  if (days.length > REMINDER_MAX) return "reminderCount";
  if (days.some((day) => typeof day === "number" && day > REMINDER_DAYS_MAX)) return "reminderDays";
  return null;
}

/** The first reason a completion cannot be recorded yet, or null. */
export function completionRefusal(completion: { completedDate?: unknown; cost?: unknown }): RefusalRule | null {
  if (typeof completion.cost === "string" && Number.isNaN(costMinorOf(completion.cost))) return "cost";
  if (!completion.completedDate) return "completedDate";
  return null;
}

/**
 * A snooze has to land after today -- the household's today, the calendar
 * date where it lives (ADR-0034, #1325). Both are YYYY-MM-DD, so the string
 * order is the calendar order.
 */
export function snoozeRefusal(snoozedUntil: string, today: string): RefusalRule | null {
  return snoozedUntil <= today ? "snoozeFloor" : null;
}
