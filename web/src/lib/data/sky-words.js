/**
 * The words of Settings' Planets group (round 6 L), kept out of the
 * component so they can be tested on their own (#1461, #1462).
 */

/** L's readout for "names up close": none, every planet, or within N days. */
export const labelWords = (/** @type {number} */ d) =>
  (d <= 0 ? "none" : d >= 365 ? "every planet" : d === 1 ? "within 1 day" : `within ${d} days`);

/**
 * L's hint under "planets sit by": the reader's own first-warning days, "a
 * month" at 30, and nothing when the days are unknown.
 * @param {?number | undefined} n
 */
export function warningHint(n) {
  if (n == null || !Number.isInteger(n) || n < 1) return "";
  const unit = (/** @type {number} */ d) => (d === 1 ? "1 day" : `${d} days`);
  return `Your first warning is ${unit(n)} before, so each planet sits ${n === 30 ? "a month" : unit(n)} nearer the sun.`;
}
