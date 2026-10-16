import { z } from "zod";

/**
 * A calendar date as Orbit stores one: `YYYY-MM-DD`, and a day that exists.
 * The one place that decides it (#1333): the command schema, the archive
 * import, reviewed intake and the date sieves all ask here, so `2026-02-31`
 * is refused everywhere rather than stored as the third of March.
 *
 * Arithmetic, not `Date`: no time zone and no two-digit-year quirk can move a
 * day, and the leap rule is the Gregorian one (every fourth year, not every
 * hundredth, except every four hundredth).
 */
const SHAPE = /^(\d{4})-(\d{2})-(\d{2})$/u;

function daysInMonth(year: number, month: number): number {
  if (month === 2) return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28;
  return month === 4 || month === 6 || month === 9 || month === 11 ? 30 : 31;
}

export function isCalendarDate(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = SHAPE.exec(value);
  if (!match) return false;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  return month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth(year, month);
}

/** What a refusal says; the archive import recognises it to word its own. */
export const CALENDAR_DATE_MESSAGE = "Use a real calendar day, written YYYY-MM-DD";

export const calendarDate = z.string().refine(isCalendarDate, { message: CALENDAR_DATE_MESSAGE });

/**
 * A stored date as the read path takes it: the shape only. A row the engine
 * accepted before it checked the day must still read (validate on write,
 * tolerate on read, #1333); the Postgres `date` column already holds only real
 * days, so this matters for what a JSON column carries.
 */
export const storedCalendarDate = z.string().regex(SHAPE);
