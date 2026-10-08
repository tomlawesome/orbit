/**
 * The calendar date where a household lives (ADR-0034, #1325): "today" for a
 * rule that turns on a day, such as the snooze floor. A household's own time
 * zone, because its reminders resume at its own 09:00
 * (notification-worker.ts householdReminderTime); an unknown zone reads as
 * UTC rather than failing the command.
 */
export function householdToday(timeZone: string, now: Date = new Date()): string {
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
  } catch {
    return now.toISOString().slice(0, 10);
  }
}
