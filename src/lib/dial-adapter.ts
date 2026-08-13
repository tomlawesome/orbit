/**
 * Adapts Orbit's domain data (`HomeItem`, issue #327 host: dashboard.tsx)
 * into the shapes `GravityDial` (#326) understands, and provides the small
 * vocabulary the v19 hero-sky spec calls for that the plain manifest list
 * never needed (T-minus labels). Pure functions only — no DOM, no React —
 * mirroring dial-geometry.ts's own boundary, so the mapping decisions are
 * unit-testable in isolation from rendering.
 *
 * Spec: docs/design/v19/home.html, docs/design/polish-register.md.
 */

import type { DialItem, DialItemStatus, DialItemType } from "@/components/gravity-dial";
import type { DialCostBand } from "@/lib/dial-geometry";
import { getDueBand, type DueBand, type HomeItem } from "@/lib/domain";

/**
 * The dial only has four urgency materials (POL-14); the product's own
 * due-band taxonomy (`getDueBand`) already carries the right granularity
 * for this, so this is a direct rename rather than a new judgement call:
 * the perihelion week reads "soon", the quarter reads "upcoming", and
 * everything later joins the wide, calm "ok" orbit. Unscheduled items
 * have no date to plot and are excluded (null) — they still surface in
 * the manifest below, just not on the chart.
 */
export function dialStatusForDueBand(band: DueBand): DialItemStatus | null {
  switch (band) {
    case "overdue": return "overdue";
    case "week": return "soon";
    case "quarter": return "upcoming";
    case "later": return "ok";
    case "unscheduled": return null;
  }
}

/**
 * The domain's `scheduleKind` is a 2-value enum (renewal/service); the
 * dial's CON-3 type language has two more (inspection/suggestion) that
 * nothing in the product produces yet — there is no per-item inspection
 * flag and no document-suggested-item pipeline into the dashboard list.
 * Until one of those lands, an item without an explicit `scheduleKind`
 * reads as a plain "service" body, the neutral filled dot.
 */
export function dialTypeForItem(item: Pick<HomeItem, "scheduleKind">): DialItemType {
  return item.scheduleKind === "renewal" ? "renewal" : "service";
}

/**
 * Cost bands are a coarse 4-step visual size, not a precise value — the
 * manifest below prints the real formatted cost next to every row.
 * Thresholds (£50 / £200 / £750) are chosen so a typical household's mix
 * of small (batteries, sweeps) through large (insurance, boiler) items
 * spreads across all four sizes rather than clustering in one band.
 */
const COST_BAND_THRESHOLDS_MINOR = [5_000, 20_000, 75_000] as const;

export function costBandForCostMinor(costMinor: number | undefined | null): DialCostBand {
  if (costMinor == null) return 1;
  if (costMinor <= COST_BAND_THRESHOLDS_MINOR[0]) return 1;
  if (costMinor <= COST_BAND_THRESHOLDS_MINOR[1]) return 2;
  if (costMinor <= COST_BAND_THRESHOLDS_MINOR[2]) return 3;
  return 4;
}

/**
 * T-minus vocabulary (v19): counts down to a future due date as "T-16d",
 * counts up from an overdue one as "T+16d" — using the mockup's minus
 * sign (U+2212, not a hyphen) to match its printed chart key exactly.
 * `days` is `daysUntil(dueDate, today)`: negative once overdue.
 */
export function formatTMinus(days: number): string {
  return days < 0 ? `T+${-days}d` : `T−${days}d`;
}

/**
 * Builds the dial's item list from the same `HomeItem[]` the manifest
 * below renders (usually the workspace's already filtered/sorted
 * `visibleItems`), so the chart and the list are always looking at the
 * same picture. Items with no due date can't be plotted (the dial's
 * radius is a function of days remaining) and are skipped here — they
 * still appear in the manifest's "Unscheduled" group.
 *
 * `documents` is intentionally left unset: no per-item document/
 * attachment count exists in the domain model yet (see #327 report), so
 * the belt (CON-1) and the callout's documents chip (CON-5) simply won't
 * render until that field exists — nothing here fabricates one.
 */
export function buildDialItems(items: HomeItem[], today: string): DialItem[] {
  const dialItems: DialItem[] = [];
  for (const item of items) {
    if (!item.dueDate) continue;
    const status = dialStatusForDueBand(getDueBand(item.dueDate, today));
    if (!status) continue;
    dialItems.push({
      id: item.id,
      title: item.title,
      dueDate: item.dueDate,
      costBand: costBandForCostMinor(item.costMinor),
      type: dialTypeForItem(item),
      status,
    });
  }
  return dialItems;
}

export interface CalloutPlacement {
  side: "left" | "right";
  top: number;
  left?: number;
  right?: number;
}

interface CalloutRect {
  top: number;
  left: number;
  right: number;
  width: number;
}

/**
 * POL-6, quadrant-aware: places the hover callout on whichever side of the
 * dial's own centre the hovered body sits, so its leader line points
 * outward and the callout box never has to cross the cluster of other
 * bodies to reach it. Pure geometry (no DOM) so the side-selection logic
 * is unit-testable without a real layout engine; the host component
 * supplies real `getBoundingClientRect()` results.
 */
export function calloutPlacementForBody(
  bodyRect: CalloutRect,
  dialRect: { left: number; width: number },
  viewportWidth: number,
): CalloutPlacement {
  const rightSide = bodyRect.left + bodyRect.width / 2 >= dialRect.left + dialRect.width / 2;
  const top = bodyRect.top - 14;
  return rightSide
    ? { side: "right", top, left: bodyRect.right + 20 }
    : { side: "left", top, right: viewportWidth - bodyRect.left + 20 };
}
