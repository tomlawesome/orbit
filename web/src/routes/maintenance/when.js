/**
 * The clock the maintenance screen shows against each entry (#526).
 *
 * Hand-built rather than `Intl.DateTimeFormat`, and in English whatever the
 * viewer's locale: the screen has to look the same in the fidelity gate as in
 * the mockup and in every browser that opens it, and `Intl` varies "Sep" and
 * "Sept" and "4 Sep" and "Sep 4" by ICU version and locale. What DOES vary by
 * viewer is the timezone, which is the one thing worth adapting — a person
 * reading "back by 22:30" needs it to be their 22:30.
 *
 * The server renders in UTC (`utc: true`), so its own timezone never leaks
 * into the markup; the screen re-renders in the viewer's zone once mounted.
 */

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** @param {number} n */
const two = (n) => String(n).padStart(2, "0");

/**
 * "21:48" — the wall clock.
 * @param {string} iso
 * @param {{ utc?: boolean }} [options]
 */
export function clock(iso, { utc = false } = {}) {
  const d = new Date(iso);
  return utc ? `${two(d.getUTCHours())}:${two(d.getUTCMinutes())}` : `${two(d.getHours())}:${two(d.getMinutes())}`;
}

/**
 * "21:48 · 4 Sep" — the clock and the day, for a timeline entry.
 * @param {string} iso
 * @param {{ utc?: boolean }} [options]
 */
export function when(iso, { utc = false } = {}) {
  const d = new Date(iso);
  const day = utc ? d.getUTCDate() : d.getDate();
  const month = MONTHS[utc ? d.getUTCMonth() : d.getMonth()];
  return `${clock(iso, { utc })} · ${day} ${month}`;
}
