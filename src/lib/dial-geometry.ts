/**
 * Pure polar maths for the gravity-well dial (issue #326, spec: v19,
 * design/v19/home.html). No DOM, no tokens, no React — every export
 * here is a plain function of numbers/strings so it can be unit tested in
 * isolation from rendering.
 *
 * Geometry decisions (see the #326 report for the full derivation against
 * v19's hand-placed mockup bodies):
 *
 * - The dial is drawn in a 380x380 viewBox, centred at (190,190) — same
 *   frame as v19's `<svg viewBox="0 0 380 380">`.
 * - ANGLE: 12 o'clock (0deg) is always "today"; the year runs clockwise.
 *   angleForDays(d) = normalise((d / YEAR_DAYS) * 360). A body due in
 *   exactly one year lands back at 0deg (the "current month" tick), and a
 *   body due 6 months out lands at 180deg (6 o'clock) — matching v19's
 *   month compass, which prints the current month at 12 and wraps the
 *   other eleven clockwise.
 * - RADIUS (scheduled, d >= 0): linear from the perihelion threshold ring
 *   (RING.threshold, 62px — the dashed danger-well boundary) out to the
 *   one-year ring (RING.outer, 150px), clamped beyond a year. This exactly
 *   reproduces v19's placed bodies (e.g. T-16d -> r65.8, T-61d -> r76.7,
 *   T-122d -> r91.4, all within a fraction of a px of
 *   62 + 88 * days/365.2425) and lands the halfway point (6 months) on
 *   RING.mid (106px), the middle reference circle v19 also draws.
 * - RADIUS (overdue, d < 0): the "gravity well" pulls a body in from the
 *   threshold ring toward the sun asymptotically as it gets later —
 *   radius = clearance + (threshold - clearance) / (1 + overdueDays / halfLife).
 *   It approaches OVERDUE_PULL.clearance (22px, just outside the sun's
 *   glow) but never reaches it, however overdue an item becomes. The
 *   half-life (50 days) is picked so the mapping passes near v19's one
 *   overdue example (T+16d -> r52).
 * - SIZE: a body's radius is a fixed lookup by cost band (1..4). A hollow
 *   suggestion (CON-3) reads a couple of px larger at the same band so its
 *   ring remains legible against a filled body of the same cost.
 */

import { calendarDayNumber } from "@/lib/domain";

export const DIAL_VIEWBOX = 380;
export const DIAL_CENTER = 190;

export const SUN_GLOW_RADIUS = 13;
export const SUN_CORE_RADIUS = 7;

/** The three reference rings drawn on the chart (v19: r=62/106/150). */
export const RING = {
  /** Perihelion / danger-well threshold — inside this is overdue. */
  threshold: 62,
  /** Decorative halfway (six-month) reference ring. */
  mid: 106,
  /** The one-year boundary; scheduled radius clamps here. */
  outer: 150,
} as const;

export const YEAR_DAYS = 365.2425;

export const OVERDUE_PULL = {
  /** Closest a body may approach the sun, however overdue, in px. */
  clearance: 22,
  /** Overdue-days for the threshold gap to halve. */
  halfLifeDays: 50,
} as const;

export type DialCostBand = 1 | 2 | 3 | 4;

/** Base body radius (px) by cost band — cheap/small to costly/large. */
export const COST_BAND_RADIUS: Record<DialCostBand, number> = {
  1: 3.5,
  2: 4.75,
  3: 6,
  4: 7.5,
};

/** A hollow suggestion ring reads this many px larger than its cost band. */
export const SUGGESTION_RING_GROWTH = 2;

export const MONTH_NAMES = [
  "JAN", "FEB", "MAR", "APR", "MAY", "JUN",
  "JUL", "AUG", "SEP", "OCT", "NOV", "DEC",
] as const;

/** Days from `today` to `dueDate` (negative when overdue), TZ-safe. */
export function daysRemaining(today: string, dueDate: string): number {
  return calendarDayNumber(dueDate) - calendarDayNumber(today);
}

/** Normalises any angle in degrees into the [0, 360) range. */
export function normaliseAngle(angleDeg: number): number {
  return ((angleDeg % 360) + 360) % 360;
}

/**
 * Angle in degrees for a body due `days` from now: 0deg is 12 o'clock
 * ("today"/current month), increasing clockwise across the year. Wraps
 * seamlessly for periods longer than a year and for overdue (negative)
 * values.
 */
export function angleForDays(days: number): number {
  return normaliseAngle((days / YEAR_DAYS) * 360);
}

/**
 * Orbit radius in px for a body due `days` from now. Scheduled items map
 * linearly across the year between the threshold and outer rings; overdue
 * items are pulled asymptotically toward the sun as they get later.
 */
export function radiusForDays(days: number): number {
  if (days >= 0) {
    const span = RING.outer - RING.threshold;
    const fraction = Math.min(days, YEAR_DAYS) / YEAR_DAYS;
    return RING.threshold + span * fraction;
  }
  const overdueDays = -days;
  const span = RING.threshold - OVERDUE_PULL.clearance;
  return OVERDUE_PULL.clearance + span / (1 + overdueDays / OVERDUE_PULL.halfLifeDays);
}

/** True when a radius sits inside the perihelion threshold ring. */
export function isOverdueRadius(radius: number): boolean {
  return radius < RING.threshold;
}

/** Body (planet) radius in px for a cost band, widened when hollow. */
export function bodyRadiusForCostBand(costBand: DialCostBand, hollow: boolean): number {
  return COST_BAND_RADIUS[costBand] + (hollow ? SUGGESTION_RING_GROWTH : 0);
}

/** Cartesian point on the dial for a given orbit radius and angle. */
export function polarPoint(
  radius: number,
  angleDeg: number,
  center: number = DIAL_CENTER,
): { x: number; y: number } {
  const rad = (angleDeg * Math.PI) / 180;
  return {
    x: center + radius * Math.sin(rad),
    y: center - radius * Math.cos(rad),
  };
}

/**
 * SVG arc path (`d` attribute) tracing a body's own orbit ring between two
 * angles — used for the decay trail behind urgent bodies.
 */
export function describeOrbitArc(radius: number, startAngleDeg: number, endAngleDeg: number): string {
  const start = polarPoint(radius, startAngleDeg);
  const end = polarPoint(radius, endAngleDeg);
  const delta = endAngleDeg - startAngleDeg;
  const largeArc = Math.abs(delta) > 180 ? 1 : 0;
  const sweep = delta >= 0 ? 1 : 0;
  return `M ${start.x.toFixed(2)} ${start.y.toFixed(2)} A ${radius} ${radius} 0 ${largeArc} ${sweep} ${end.x.toFixed(2)} ${end.y.toFixed(2)}`;
}

/** The 12 month compass labels, starting with the current month at 12 o'clock. */
export function monthCompassLabels(today: string): string[] {
  const currentMonthIndex = Number(today.slice(5, 7)) - 1;
  return Array.from({ length: 12 }, (_, offset) => MONTH_NAMES[(currentMonthIndex + offset) % 12]);
}

/** Short, screen-reader-friendly phrase for a body's due date. */
export function describeDaysRemaining(days: number): string {
  if (days === 0) return "due today";
  if (days < 0) return `${-days} day${-days === 1 ? "" : "s"} overdue`;
  return `due in ${days} day${days === 1 ? "" : "s"}`;
}

export interface DialBodyGeometry {
  daysRemaining: number;
  angleDeg: number;
  orbitRadius: number;
  bodyRadius: number;
  x: number;
  y: number;
  isOverdue: boolean;
}

/** Full geometry pipeline for one dial body: date + cost band -> position. */
export function computeBodyGeometry(
  item: { dueDate: string; costBand: DialCostBand; type: string },
  today: string,
): DialBodyGeometry {
  const days = daysRemaining(today, item.dueDate);
  const angleDeg = angleForDays(days);
  const orbitRadius = radiusForDays(days);
  const hollow = item.type === "suggestion";
  const radius = bodyRadiusForCostBand(item.costBand, hollow);
  const { x, y } = polarPoint(orbitRadius, angleDeg);
  return {
    daysRemaining: days,
    angleDeg,
    orbitRadius,
    bodyRadius: radius,
    x,
    y,
    isOverdue: isOverdueRadius(orbitRadius),
  };
}
