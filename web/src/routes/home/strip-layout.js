/**
 * Pure geometry for the desk search strip (#1161, "C · unrolled",
 * design/v19/search/round-1/BUILD.md §3): the year drawn as a line above the
 * search field. Kept apart from +page.svelte the way pocket-dial.js's own
 * spacing law is, so it can be unit tested directly rather than through the
 * screen.
 *
 * The axis: −40 to +356 days across 760px, from x=30 to x=790. Today sits at
 * x≈106.8. Every value here is the build brief's own number.
 */

const X0 = 30;
const AXIS_SPAN = 760;
const DAY_MIN = -40;
const DAY_MAX = 356;
const PXD = AXIS_SPAN / (DAY_MAX - DAY_MIN);

export const AXIS_Y = 76;
export const AXIS_X0 = X0;
export const AXIS_X1 = X0 + AXIS_SPAN;
/** Where an unscheduled match's label anchors: the axis's own right edge. */
export const UNSCHEDULED_X = AXIS_X1;
/** Tier 0 (above) and tier 1 (below) run-line y, §3. */
export const TIER_RUN_Y = [AXIS_Y - 14, AXIS_Y + 26];
/** A label's own width budget before it must flip to a leading anchor. */
export const FLIP_WIDTH_X = 812;
/** Two marks closer than this (by label edge) cannot share a tier. */
export const TIER_GAP = 12;

/**
 * x for a day offset from today, clamped to the axis's own window.
 * @param {number} days
 */
export function xOfDays(days) {
  const clamped = Math.max(DAY_MIN, Math.min(DAY_MAX, days));
  return X0 + (clamped - DAY_MIN) * PXD;
}

const MONTH_NAMES = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];

/**
 * One tick per 1st-of-month from tomorrow through +356 days, computed from
 * `today` rather than hard-coded (§3).
 * @param {string} today a `YYYY-MM-DD` date
 * @returns {{ name: string, days: number, x: number }[]}
 */
export function monthTicks(today) {
  const start = new Date(`${today}T00:00:00Z`);
  const ticks = [];
  let cursor = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1));
  /* A year of months is always enough to cross the +356d ceiling once. */
  for (let guard = 0; guard < 14; guard++) {
    const days = Math.round((cursor.getTime() - start.getTime()) / 86400000);
    if (days > DAY_MAX) break;
    ticks.push({ name: MONTH_NAMES[cursor.getUTCMonth()], days, x: xOfDays(days) });
    cursor = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, 1));
  }
  return ticks;
}

/**
 * A mono label's width for layout, exact enough without measuring (§3).
 * @param {string} text
 * @param {number} fontSize
 */
export function textWidth(text, fontSize) {
  return text.length * fontSize * 0.6 + 6;
}

/**
 * Places each mark's label above (tier 0) or below (tier 1) the axis,
 * greedily left to right off each tier's own rightmost occupied edge. A mark
 * that fits neither tier keeps its body but loses its label — `labelled`
 * false — until the reader selects it (the caller's job, not this one's).
 *
 * Generic over whatever shape the caller's marks are (§4 hands it plain
 * `{x,width}` fixtures in tests, +page.svelte hands it its own richer mark
 * objects): every field the caller put in survives, alongside the four this
 * adds.
 *
 * @template {{ x: number, width: number }} T
 * @param {T[]} marks any shape, `x`/`width` read
 * @returns {(T & { tier: 0 | 1, flip: boolean, labelled: boolean })[]}
 *   the same marks, in ascending x order, each carrying its placement
 */
export function assignTiers(marks) {
  const sorted = [...marks].sort((a, b) => a.x - b.x);
  const rightEdge = [-Infinity, -Infinity];
  return sorted.map((m) => {
    /** @type {0 | 1} */
    let tier = 0;
    let labelled = true;
    if (m.x > rightEdge[0] + TIER_GAP) tier = 0;
    else if (m.x > rightEdge[1] + TIER_GAP) tier = 1;
    else labelled = false;
    const flip = m.x + m.width > FLIP_WIDTH_X;
    if (labelled) rightEdge[tier] = flip ? m.x : m.x + m.width;
    return { ...m, tier, flip, labelled };
  });
}

/**
 * The note line's own act(s) (#1162, wiring the two rows BUILD.md §1 left
 * inert): "complete" the closest thing due, offered only at rest; "add" the
 * typed name (or nothing typed), offered at rest and again when a query
 * matches nothing. BUILD.md §1 never shows both a query's own matches and an
 * act at once, so a live query with real matches offers none. Kept pure, the
 * same reason the geometry above is: +page.svelte supplies the live state —
 * `searchQuery` and `nothing`/`query` from `searchPocket()`, `closest` from
 * `manifestGroupsOf()`, and whether the complete act is armed — and fires
 * whatever this returns (completeCommand/applyCommand for "complete", the
 * create screen for "add"); this only decides what is on offer and how it
 * reads.
 * @param {{ searchQuery: string, nothing: boolean, query: string,
 *   closest: { id: string, title: string } | null, completeArmed: boolean }} args
 * @returns {({ kind: "complete", itemId: string, title: string, target: { id: string, title: string } }
 *   | { kind: "add", itemId: string, title: string, name: string })[]}
 */
export function stripActsOf({ searchQuery, nothing, query, closest, completeArmed }) {
  if (searchQuery) {
    if (!nothing) return [];
    return [{ kind: "add", itemId: "__add__", title: `add "${query}" as an item`, name: query }];
  }
  /** @type {ReturnType<typeof stripActsOf>} */
  const out = [];
  if (closest) {
    out.push({
      kind: "complete",
      itemId: "__complete__",
      title: completeArmed ? `tap again to complete "${closest.title}"` : `complete "${closest.title}"`,
      target: closest,
    });
  }
  out.push({ kind: "add", itemId: "__add__", title: "add an item", name: "" });
  return out;
}
