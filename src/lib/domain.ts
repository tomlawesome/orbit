/*
 * The five shipped glyphs (home..calendar) plus the seven asterisms #867
 * ratified — hook, kite, ladle, cross, bow, wedge, belt — twelve marks, the
 * cap. The shipped five never change meaning; the seven are assigned to a
 * user-named section on arrival and may be swapped from the Sections card.
 * The frontend's own figure table (web/src/lib/marks.js) draws these by the
 * same ids — keep the two lists in the same order if either ever changes.
 */
export const sectionIcons = [
  "home", "vehicle", "device", "service", "calendar",
  "hook", "kite", "ladle", "cross", "bow", "wedge", "belt",
] as const;
export type SectionIcon = (typeof sectionIcons)[number];
export const sectionAccents = ["sage", "blue", "sand", "plum", "coral"] as const;
export type SectionAccent = (typeof sectionAccents)[number];

export interface HouseholdSection {
  id: string;
  name: string;
  icon: SectionIcon;
  accent: SectionAccent;
  visible: boolean;
}

export const defaultSections: HouseholdSection[] = [
  { id: "home", name: "Home", icon: "home", accent: "sage", visible: true },
  { id: "vehicle", name: "Vehicles", icon: "vehicle", accent: "blue", visible: true },
  { id: "device", name: "Devices", icon: "device", accent: "sand", visible: true },
  { id: "service", name: "Services", icon: "service", accent: "plum", visible: true },
];

export const itemStatuses = ["active", "expired", "cancelled", "archived"] as const;
export type ItemStatus = (typeof itemStatuses)[number];
/**
 * The three kinds of dated event an item can carry (#1005). `expiry` is the
 * one-off: it never recurs, a completion never takes a next date, and once its
 * day is past nothing is owed, so it is never counted as overdue.
 */
export const scheduleKinds = ["renewal", "service", "expiry"] as const;
export type ScheduleKind = (typeof scheduleKinds)[number];

/**
 * The bounds on what an item may hold (#1333), named once. The command
 * schema, the archive import, reviewed intake and the document suggestions
 * all build from these, so an item one door lets in is never one another
 * refuses on the way out.
 */
export const TITLE_MAX = 100;
export const SUBTYPE_MAX = 80;
export const PROVIDER_MAX = 100;
export const REFERENCE_MAX = 80;
/** An item's notes. */
export const NOTES_MAX = 2_000;
/** The notes on one entry of an item's history, or on a completion. */
export const ACTIVITY_NOTES_MAX = 1_000;
/** A cost in pence: a million pounds. */
export const COST_MINOR_MAX = 100_000_000;
/** A repeat is "every N months", at most ten years. */
export const RECURRENCE_MAX = 120;
/** The model's own ceiling on reminders per item. */
export const REMINDER_MAX = 8;
/** The model's own ceiling on how far ahead a reminder may be. */
export const REMINDER_DAYS_MAX = 365;

export type DueState = "overdue" | "due-soon" | "upcoming" | "unscheduled";
export type DueBand = "overdue" | "week" | "quarter" | "later" | "unscheduled";

export interface HomeItem {
  id: string;
  sectionId: string;
  title: string;
  subtype?: string;
  provider?: string;
  reference?: string;
  costMinor?: number;
  currency: string;
  dueDate?: string;
  scheduleKind?: ScheduleKind;
  recurrenceMonths?: number;
  reminderDays?: number[];
  snoozedUntil?: string;
  notes?: string;
  status: ItemStatus;
  version?: number;
  updatedAt?: string;
}

const MS_PER_DAY = 86_400_000;

/** Parses a calendar date without allowing the server timezone to shift it. */
export function calendarDayNumber(value: string): number {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) throw new Error(`Invalid calendar date: ${value}`);
  return Math.floor(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])) / MS_PER_DAY);
}

export function daysUntil(dueDate: string, today: string): number {
  return calendarDayNumber(dueDate) - calendarDayNumber(today);
}

export function getDueState(dueDate: string | undefined, today: string): DueState {
  if (!dueDate) return "unscheduled";
  const days = daysUntil(dueDate, today);
  if (days < 0) return "overdue";
  if (days <= 30) return "due-soon";
  return "upcoming";
}

/** Maps scheduled dates to the four heat-map bands used by item rows. */
export function getDueBand(dueDate: string | undefined, today: string): DueBand {
  if (!dueDate) return "unscheduled";
  const days = daysUntil(dueDate, today);
  if (days < 0) return "overdue";
  if (days < 7) return "week";
  if (days <= 90) return "quarter";
  return "later";
}

export function sortByDueDate(items: HomeItem[], today: string): HomeItem[] {
  const rank: Record<DueState, number> = { overdue: 0, "due-soon": 1, upcoming: 2, unscheduled: 3 };
  return [...items].sort((a, b) => {
    const stateDifference = rank[getDueState(a.dueDate, today)] - rank[getDueState(b.dueDate, today)];
    if (stateDifference !== 0) return stateDifference;
    if (!a.dueDate) return a.title.localeCompare(b.title);
    if (!b.dueDate) return -1;
    return a.dueDate.localeCompare(b.dueDate) || a.title.localeCompare(b.title);
  });
}

export function suggestNextDate(date: string, intervalMonths: number): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match || intervalMonths < 1) throw new Error("A valid date and positive interval are required");
  const year = Number(match[1]);
  const monthIndex = Number(match[2]) - 1 + intervalMonths;
  const day = Number(match[3]);
  const targetYear = year + Math.floor(monthIndex / 12);
  const targetMonth = ((monthIndex % 12) + 12) % 12;
  const lastDay = new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate();
  return `${targetYear}-${String(targetMonth + 1).padStart(2, "0")}-${String(Math.min(day, lastDay)).padStart(2, "0")}`;
}
