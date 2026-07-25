export const sectionIcons = ["home", "vehicle", "device", "service", "calendar"] as const;
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
export const scheduleKinds = ["renewal", "service"] as const;
export type ScheduleKind = (typeof scheduleKinds)[number];

export type DueState = "overdue" | "due-soon" | "upcoming" | "unscheduled";

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
