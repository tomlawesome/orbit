import { daysBetween, plural } from "$lib/format.js";
/**
 * THE DUE DATE'S MONTH CALENDAR (#1319; design/v19/belt-purpose/round-8/
 * m-colour-per-option.html, `editing-date`; rounds 4-8): the arithmetic the
 * chooser card draws and walks, pure so it is proved in the unit suite.
 *
 * Every date is a `YYYY-MM-DD` string read in UTC, as the rest of the app's
 * dates are (format.js): a calendar day, never an instant. Weeks start on
 * Monday; the month is always six rows of seven, so the card never changes
 * height as it pages.
 */

export const MONTHS_LONG = ["January", "February", "March", "April", "May", "June", "July",
  "August", "September", "October", "November", "December"];
export const DOW = ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"];
export const DOW_LONG = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

const DAY_MS = 86_400_000;
/** @param {string} iso */
const dayOf = (iso) => new Date(`${iso}T00:00:00Z`);

/** @param {number} year @param {number} month 0-11, may overflow @param {number} day */
export function isoOf(year, month, day) {
  return new Date(Date.UTC(year, month, day)).toISOString().slice(0, 10);
}

/** @param {string} iso @param {number} days */
export function addDays(iso, days) {
  return new Date(dayOf(iso).getTime() + days * DAY_MS).toISOString().slice(0, 10);
}

/**
 * `n` calendar months on, the day held to the end of a shorter month
 * (31 Jan + 1 is 28 Feb): for what a screen shows -- the calendar's month
 * paging only (#1337). The next due date a completion sets, and the preview
 * of it, are the engine's (src/lib/next-due-date.ts, #1324), never this.
 * @param {string} iso @param {number} n
 */
export function addMonths(iso, n) {
  const d = dayOf(iso);
  const first = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1));
  const last = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
  return isoOf(first.getUTCFullYear(), first.getUTCMonth(), Math.min(d.getUTCDate(), last));
}

/** Monday is 0. @param {string} iso */
export const dowOf = (iso) => (dayOf(iso).getUTCDay() + 6) % 7;

/** "Monday 29 August 2026", what a day's cell says aloud. @param {string} iso */
export function spokenDate(iso) {
  const d = dayOf(iso);
  return `${DOW_LONG[dowOf(iso)]} ${d.getUTCDate()} ${MONTHS_LONG[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/** "in 16 days", "today", "3 days overdue". @param {string} iso @param {string} today */
export function relWords(iso, today) {
  const d = daysBetween(today, iso);
  if (d === 0) return "today";
  if (d < 0) return `${plural(-d, "day")} overdue`;
  return `in ${plural(d, "day")}`;
}

/**
 * @typedef {{ iso: string, day: number, off: boolean, past: boolean, today: boolean }} CalendarDay
 */

/**
 * The month's six weeks, Monday first: the days of the months either side
 * fill the first and last rows, marked `off`.
 * @param {number} year @param {number} month 0-11 @param {string} today
 * @returns {CalendarDay[][]}
 */
export function monthGrid(year, month, today) {
  const lead = (new Date(Date.UTC(year, month, 1)).getUTCDay() + 6) % 7;
  const start = isoOf(year, month, 1 - lead);
  /** @type {CalendarDay[][]} */
  const weeks = [];
  for (let w = 0; w < 6; w++) {
    /** @type {CalendarDay[]} */
    const week = [];
    for (let i = 0; i < 7; i++) {
      const iso = addDays(start, w * 7 + i);
      const d = dayOf(iso);
      week.push({ iso, day: d.getUTCDate(), off: d.getUTCMonth() !== ((month % 12) + 12) % 12,
        past: iso < today, today: iso === today });
    }
    weeks.push(week);
  }
  return weeks;
}

/**
 * Where a key moves the calendar's focus from `iso`, or null when the key
 * is not the calendar's: arrows a day or a week, Home and End the week's
 * ends, PageUp and PageDown a month (with Shift, a year).
 * @param {string} iso @param {string} key @param {boolean} [shift]
 * @returns {string | null}
 */
export function stepDay(iso, key, shift = false) {
  switch (key) {
    case "ArrowLeft": return addDays(iso, -1);
    case "ArrowRight": return addDays(iso, 1);
    case "ArrowUp": return addDays(iso, -7);
    case "ArrowDown": return addDays(iso, 7);
    case "Home": return addDays(iso, -dowOf(iso));
    case "End": return addDays(iso, 6 - dowOf(iso));
    case "PageUp": return addMonths(iso, shift ? -12 : -1);
    case "PageDown": return addMonths(iso, shift ? 12 : 1);
    default: return null;
  }
}

/**
 * The day the calendar's focus rests on when it pages to a month: the
 * draft day if it is in that month, otherwise the chosen day's date held
 * to the month's length (or the 1st, with nothing chosen).
 * @param {number} year @param {number} month @param {string | null} draft @param {string | null} chosen
 */
export function restingDay(year, month, draft, chosen) {
  if (draft) {
    const d = dayOf(draft);
    if (d.getUTCFullYear() === year && d.getUTCMonth() === month) return draft;
  }
  const last = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return isoOf(year, month, Math.min(chosen ? dayOf(chosen).getUTCDate() : 1, last));
}
