import { householdToday } from "../../../src/lib/household-date";

/**
 * The calendar date `days` days from today where the household lives (#1369).
 *
 * The app counts an item's days left from the household's own date
 * (`householdToday`), so a seeded due date must be counted from it too. Taken
 * from the UTC date instead, "20 days ahead" reads T−19d between 23:00 and
 * midnight UTC in UK summer time, when London is already on the next day.
 * Every e2e household lives in Europe/London: the engine's default, and what
 * the specs seed.
 */
export function householdDateFromToday(days: number, timeZone = "Europe/London", now: Date = new Date()): string {
  const today = householdToday(timeZone, now);
  return new Date(Date.parse(`${today}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}
