/*
 * THE POCKET DIAL'S SPACING LAW (proposal §1.7; #1120, building on #1129).
 *
 * Every dial body is tappable through a 44px hit circle, and two hit circles
 * never overlap. #1129 got the second half by shrinking a crowded body's hit
 * circle to half the gap to its neighbour, which kept both bodies but left
 * some targets under 44px. §1.7 settles it the other way: when two bodies
 * would sit closer than 48px centre to centre, the pocket keeps the one due
 * sooner on the dial and the other lives in the manifest only. The pocket
 * already draws "fewer, bigger bodies"; this makes the rule exact.
 *
 * Units are the dial's own viewBox (380 wide). The SVG scales with the
 * column, so the numbers are set for the narrowest dial the pocket draws:
 * 336px across at a 360px screen with 12px gutters (scale 0.884).
 *   HIT_R 25   → at least 44px across at 360, 47px at 390
 *   MIN_GAP 55 → at least 48px apart at 360, and never less than 2 × HIT_R,
 *                so the hit circles cannot touch
 */
export const DIAL_VIEWBOX = 380;
export const HIT_R = 25;
export const MIN_GAP = 55;

/**
 * @template {{ id: string, days: number, suggestion?: boolean, placement: { x: number, y: number } }} B
 * @param {B[]} bodies  in any order
 * @param {number} [minGap]
 * @returns {B[]}  the bodies that stay on the dial, soonest-due first
 */
export function spacedBodies(bodies, minGap = MIN_GAP) {
  /* Soonest due wins a crowded spot; an overdue body (negative days) is the
     soonest of all. A tie keeps the item over the relay's suggestion, since a
     suggestion also waits in the signals list. */
  const order = [...bodies].sort(
    (a, b) => a.days - b.days || Number(Boolean(a.suggestion)) - Number(Boolean(b.suggestion)),
  );
  /** @type {B[]} */
  const kept = [];
  for (const body of order) {
    const clear = kept.every(
      (other) => Math.hypot(other.placement.x - body.placement.x, other.placement.y - body.placement.y) >= minGap,
    );
    if (clear) kept.push(body);
  }
  return kept;
}
