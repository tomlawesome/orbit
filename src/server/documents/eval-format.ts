/**
 * How the evaluation tools print a proportion (#1349, engine-13).
 *
 * Eight tools each had their own `percent`, and they disagreed: a zero
 * denominator printed "0", "0.0", "0.0%" or "n/a", and the precision was 0 or
 * 1 decimal. A tally of nothing is not 0%, so it is always "n/a" here, and
 * the precision is the caller's choice (one decimal unless it says otherwise).
 * Development tooling only; nothing a member sees is built from this.
 */

/** `part` of `whole` as a percentage, or "n/a" when there is no `whole`. */
export function percent(part: number, whole: number, digits = 1): string {
  return whole === 0 ? "n/a" : percentOfRatio(part / whole, digits);
}

/** A ratio already worked out (0 to 1) as a percentage. */
export function percentOfRatio(ratio: number, digits = 1): string {
  return `${(ratio * 100).toFixed(digits)}%`;
}
