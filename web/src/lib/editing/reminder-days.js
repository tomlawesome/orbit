/**
 * THE REMINDER DAYS the Add form offers (#1892, design/v19/reminder-days/
 * round-1/t-one-scale.html, owner "61a T"): one set of presets, the same on
 * desk and phone, plus any whole number of days typed in, 1 to 365. 365 is
 * the engine's own ceiling (REMINDER_DAYS_MAX in src/lib/domain.ts, pinned by
 * test, as the web bundle does not import server code); the server refuses
 * more, so the form never offers it.
 */
export const REMINDER_PRESETS = [1, 3, 7, 14, 30, 60, 90];
export const REMINDER_DAYS_MIN = 1;
export const REMINDER_DAYS_MAX = 365;
/** What the field refuses, in the design's words. */
export const REMINDER_REFUSAL = `a whole number of days, ${REMINDER_DAYS_MIN} to ${REMINDER_DAYS_MAX}`;

/** The typed text as a day, or null when it is not a whole number in range. @param {string} text */
export function reminderDayOf(text) {
  if (!/^\d{1,3}$/u.test(text)) return null;
  const day = Number(text);
  return day >= REMINDER_DAYS_MIN && day <= REMINDER_DAYS_MAX ? day : null;
}

/** The most reminders an item may carry (REMINDER_MAX in src/lib/domain.ts, pinned by test). */
export const REMINDER_MAX = 8;
