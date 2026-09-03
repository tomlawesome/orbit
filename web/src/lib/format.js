/**
 * The manifest's vocabulary, shared (#445): a date, its distance in days, a
 * cost in minor units. One place, so T−161d means the same thing on every
 * screen. Pinned to the design's own today until real data arrives, so the
 * screens agree with the chart that sent you to them.
 */
export const DESIGN_TODAY = "2026-08-13";

/**
 * @param {string} iso
 * @returns {number}
 */
export const day = (iso) => Math.round(Date.parse(iso + "T00:00:00Z") / 86400000);

/**
 * @param {string} due
 * @param {string} [today]
 * @returns {string}
 */
export const tminus = (due, today = DESIGN_TODAY) => {
  const days = day(due) - day(today);
  return days < 0 ? `T+${-days}d` : `T−${days}d`;
};

/**
 * @param {string} iso
 * @returns {string}
 */
export const longDate = (iso) =>
  new Date(iso + "T00:00:00Z").toLocaleDateString("en-GB", {
    day: "numeric", month: "long", year: "numeric", timeZone: "UTC",
  });

/**
 * @param {number | null | undefined} minor
 * @param {string} currency
 * @param {boolean} [estimate]
 * @returns {string}
 */
export const money = (minor, currency, estimate = false) => {
  if (minor === null || minor === undefined) return "—";
  const amount = new Intl.NumberFormat("en-GB", { style: "currency", currency }).format(minor / 100);
  return estimate ? `~${amount}` : amount;
};

/**
 * @param {number} months
 * @returns {string}
 */
export const every = (months) =>
  months === 12 ? "every year" : months === 1 ? "every month" : `every ${months} months`;

/* Elapsed time in the relay's two registers: "4m ago" for chrome lines,
   "4 minutes ago" for sentences. `now` is passed in, never read from the
   clock, so fixtures pin it and the gate holds still. */
/**
 * @param {string} iso
 * @param {string} now
 * @returns {string}
 */
export const ago = (iso, now) => {
  const minutes = Math.max(0, Math.round((Date.parse(now) - Date.parse(iso)) / 60000));
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
};

/**
 * @param {string} iso
 * @param {string} now
 * @returns {string}
 */
export const agoLong = (iso, now) => {
  const minutes = Math.max(0, Math.round((Date.parse(now) - Date.parse(iso)) / 60000));
  /**
   * @param {number} n
   * @param {string} word
   * @returns {string}
   */
  const unit = (n, word) => `${n} ${word}${n === 1 ? "" : "s"} ago`;
  if (minutes < 60) return unit(minutes, "minute");
  const hours = Math.round(minutes / 60);
  if (hours < 24) return unit(hours, "hour");
  return unit(Math.round(hours / 24), "day");
};
