import type { ScheduleKind } from "@/lib/domain";

/* ADR-0034, #1324: the next due date after a completion is the engine's
   rule. Both the pure reducer (reduceWorkspace) and the repository's
   transaction (applyWorkspaceCommand) call nextDueDate, so they agree, and
   no client sends or computes it. */

function pad(value: number, width: number): string {
  return String(value).padStart(width, "0");
}

/**
 * `date` (YYYY-MM-DD) plus `months` calendar months, the day clamped to the
 * end of the month it lands in: 31 January plus one month is 28 February
 * (29th in a leap year), never 3 March.
 */
export function addCalendarMonths(date: string, months: number): string {
  const [year, month, day] = date.split("-").map(Number) as [number, number, number];
  const total = year * 12 + (month - 1) + months;
  const targetYear = Math.floor(total / 12);
  const targetMonth = total - targetYear * 12 + 1;
  const lastDay = new Date(Date.UTC(targetYear, targetMonth, 0)).getUTCDate();
  return `${pad(targetYear, 4)}-${pad(targetMonth, 2)}-${pad(Math.min(day, lastDay), 2)}`;
}

/**
 * When a completed item comes round again: its period in calendar months
 * after the day it was done. Nothing when it has no period, or when it is an
 * expiry, which happens once (#1005) -- the completion then ends its
 * schedule.
 */
export function nextDueDate(
  schedule: { scheduleKind?: ScheduleKind | null; recurrenceMonths?: number | null },
  completedDate: string,
): string | undefined {
  if (!schedule.scheduleKind || schedule.scheduleKind === "expiry") return undefined;
  if (!schedule.recurrenceMonths) return undefined;
  return addCalendarMonths(completedDate, schedule.recurrenceMonths);
}
