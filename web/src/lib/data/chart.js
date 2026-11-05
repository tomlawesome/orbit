/**
 * The workspace → chart transform (#451): every geometric and tonal decision
 * the home screen makes about real data lives here, as pure functions.
 *
 * The dial is an orbital calendar — the one law the ratified mockup's bodies
 * were drawn by (#414): today sits at 12 o'clock and each day of lead time is
 * one degree clockwise, so angle° = daysUntilDue − 90. Distance is
 * logarithmic (#1464, decision 37): radius = 62 + 104·ln(1 + d/14)/ln(1 + 365/14),
 * so the next fortnight fills the inner half of the sky and a year out (or
 * further) sits on the rim, 166. Overdue bodies fall inward on a mirror
 * curve, 62 − 38·ln(1 + |d|/7)/ln(1 + 60/7), reaching the event horizon (24)
 * at 60 days. Bodies that would touch are nudged apart by bearing only
 * (seatBodies, round 4 G's rule); radius is never changed.
 *
 * Size is the other law (#1460, proportional-symbol scaling with power
 * compensation): yearly £ = (costMinor/100) × (recurrenceMonths > 0 ?
 * 12/recurrenceMonths : 1); radius = clamp(rMin·(yearly/50)^k, rMin, rMax),
 * k = ln(rMax/rMin)/ln(1000), rounded to 0.1 -- £50/yr is the smallest body,
 * £50,000/yr the largest. Desk range DESK_SIZE, pocket range POCKET_SIZE.
 *
 * The sky is fixed (CON-13, #428): a household's absolute map position is a
 * pure function of its identity, so its bearing can never move between
 * sessions, days, or devices. Product cap is five households.
 */

import { BAND_VAR } from "$lib/data/bands.js";
import { bandOf, daysBetween, dayMonth, monthOnly, MONTHS } from "$lib/format.js";

/**
 * The minimal shapes this transform reads off a workspace — loose and
 * additive on purpose, since the real objects (workspace.js's own
 * typedefs) carry more than a chart ever looks at.
 *
 * @typedef {object} ChartItem
 * @property {string} id
 * @property {string} title
 * @property {string} status
 * @property {?string} [dueDate]
 * @property {string} [sectionId]
 * @property {?string} [provider]
 * @property {?string} [subtype]
 * @property {?string} [scheduleKind]
 * @property {?number} [recurrenceMonths]
 * @property {?number} [costMinor]
 * @property {boolean} [costIsEstimate]
 * @property {string} [currency]
 * @property {number} [documentCount]
 * @property {?string} [importance]  "low" | "normal" | "high"; null or absent is not set (#1463)
 * @property {?number[]} [reminderDays]  the item's own reminder days (reminder_rules.days_before), for the warning date (#1462)
 *
 * @typedef {object} ChartHousehold
 * @property {string} id
 * @property {string} name
 * @property {boolean} [canManage]
 * @property {boolean} [requested]
 * @property {ChartItem[]} [items]
 * @property {{ id: string, name: string, icon?: string, accent?: string }[]} [sections]
 * @property {{ itemId: string, kind: string, occurredAt: string, effectiveDate?: ?string }[]} [activities]
 *
 * @typedef {object} ChartSuggestion
 * @property {string} id
 * @property {string} title
 * @property {string} [renewsOn]
 * @property {?string} [scheduleKind]
 * @property {number} [costMinor]
 * @property {string} [currency]
 * @property {string} [receiptId]
 * @property {string} [sourceDocument]
 *
 * @typedef {object} ChartWorkspace
 * @property {?string} [activeHouseholdId]
 * @property {ChartHousehold[]} [households]
 *
 * @typedef {object} ChartBody  a dial body — a scheduled item or an un-accepted suggestion
 * @property {string} id
 * @property {string} title
 * @property {number} days  until the real due date
 * @property {number} drivingDays  what places the planet: `days`, or the days to its warning date (#1462)
 * @property {?string} [dueDate]
 * @property {{ angle: number, radius: number, x: number, y: number }} placement  seated at the desk size
 * @property {{ angle: number, radius: number, x: number, y: number }} pocketPlacement  seated at the pocket size
 * @property {number} size
 * @property {number} pocketSize  the same law on the pocket's own range (#1460)
 * @property {?string} importance  the item's level, "low" | "normal" | "high", or null (not set); a suggestion has none (#1463)
 * @property {boolean} hollow  drawn hollow: importance is what size shows and this item has none (#1463)
 * @property {string} paint
 * @property {string} kind
 * @property {boolean} suggestion
 * @property {?number} costMinor
 * @property {boolean} costIsEstimate
 * @property {string} currency
 * @property {number} documentCount
 * @property {boolean} trail
 * @property {boolean} overdue
 * @property {boolean} [closest]
 */

const DIAL_CENTRE = 190;
const RIM = 166;
const SUN_CLEARANCE = 24;
const ZERO_RADIUS = 62;
/** Decision 37: the log scale's close-up and horizon, and the overdue mirror's. Constants, not settings. */
export const CLOSE_UP_DAYS = 14;
export const HORIZON_DAYS = 365;
export const OVERDUE_CLOSE_UP_DAYS = 7;
export const OVERDUE_SPAN_DAYS = 60;

/**
 * FNV-1a, 32-bit: a stable, dependency-free hash for identity → geometry.
 * @param {string} text
 */
export function hashId(text) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/**
 * Calendar-day difference, clock-independent. null when unscheduled.
 * @param {string | null | undefined} dueDate
 * @param {string} today
 * @returns {?number}
 */
export function daysUntil(dueDate, today) {
  if (!dueDate || !today) return null;
  return daysBetween(today, dueDate);
}

/**
 * The days that place a planet (#1462): the days until due, or, when the user
 * sets planets by their warning date, those days less the warning offset: the
 * largest of the item's own reminder days where it has any, else the user's
 * first-warning days, else 0. May be negative (the warning date has passed).
 * The one place the offset is worked out.
 *
 * @param {{ days: number, reminderDays?: ?number[] }} item
 * @param {{ skyDriver?: ?string, firstWarningDays?: ?number }} [options]
 * @returns {number}
 */
export function drivingDays({ days, reminderDays }, { skyDriver, firstWarningDays } = {}) {
  if (skyDriver !== "warning") return days;
  const own = (reminderDays ?? []).filter((one) => Number.isFinite(one));
  return days - (own.length ? Math.max(...own) : (firstWarningDays ?? 0));
}

/**
 * Where a body with this much lead time sits on the dial.
 * @param {number} days
 */
export function dialPlacement(days) {
  const angle = (Math.max(-90, Math.min(days, 430)) - 90) * (Math.PI / 180);
  const radius = radiusOf(days);
  return { angle, radius, ...pointAt(angle, radius) };
}

/**
 * Distance from the sun in dial units: log curve out, mirror log curve in (decision 37).
 * @param {number} days
 */
function radiusOf(days) {
  if (days >= 0) {
    const f = Math.min(1, Math.log(1 + days / CLOSE_UP_DAYS) / Math.log(1 + HORIZON_DAYS / CLOSE_UP_DAYS));
    return ZERO_RADIUS + (RIM - ZERO_RADIUS) * f;
  }
  const f = Math.log(1 + -days / OVERDUE_CLOSE_UP_DAYS) / Math.log(1 + OVERDUE_SPAN_DAYS / OVERDUE_CLOSE_UP_DAYS);
  return Math.max(SUN_CLEARANCE, ZERO_RADIUS - (ZERO_RADIUS - SUN_CLEARANCE) * f);
}

/**
 * Dial coordinates for a bearing and radius, rounded to 0.1.
 * @param {number} angle
 * @param {number} radius
 */
function pointAt(angle, radius) {
  return {
    x: Math.round((DIAL_CENTRE + Math.cos(angle) * radius) * 10) / 10,
    y: Math.round((DIAL_CENTRE + Math.sin(angle) * radius) * 10) / 10,
  };
}

/**
 * Seat bodies so none touches another (round 4 G's rule). Inner first, ties by
 * days; a body keeps its bearing if it is clear of every body already seated
 * (centre distance >= both radii + 3), else takes the first clear bearing of
 * angle +/- k * 0.25 degrees, k = 1..720, + before -. Radius never changes.
 * Pure: the input is not mutated; the result is in input order.
 * @template {{ days: number, angle: number, radius: number, x: number, y: number }} T
 * @param {T[]} bodies
 * @param {(body: T) => number} sizeOf  drawn radius in dial units
 * @returns {T[]}
 */
export function seatBodies(bodies, sizeOf) {
  const result = bodies.map((b) => ({ ...b }));
  const order = bodies.map((_, i) => i).sort((i, j) => bodies[i].radius - bodies[j].radius || bodies[i].days - bodies[j].days);
  /** @type {{ x: number, y: number, r: number }[]} */
  const seated = [];
  for (const i of order) {
    const body = bodies[i];
    const r = sizeOf(body);
    const spot = (/** @type {number} */ angle) => ({
      x: DIAL_CENTRE + Math.cos(angle) * body.radius,
      y: DIAL_CENTRE + Math.sin(angle) * body.radius,
    });
    const clear = (/** @type {{ x: number, y: number }} */ p) => seated.every((o) => Math.hypot(o.x - p.x, o.y - p.y) >= o.r + r + 3);
    let angle = body.angle;
    let at = spot(angle);
    search: for (let k = 1; k <= 720 && !clear(at); k++) {
      for (const sign of [1, -1]) {
        const a = body.angle + (sign * k * 0.25 * Math.PI) / 180;
        const p = spot(a);
        if (clear(p)) {
          angle = a;
          at = p;
          break search;
        }
      }
    }
    seated.push({ ...at, r });
    Object.assign(result[i], { angle, ...pointAt(angle, body.radius) });
  }
  return result;
}

/** Radius range in dial units, [rMin, rMax]: the desk's legibility at 640px. */
export const DESK_SIZE = [3.5, 13];
/** The pocket's range: its floor is set by the 44px tap rule. */
export const POCKET_SIZE = [5, 12];

/**
 * Bigger = costlier per year (chart key, #1460). Radius in dial units from
 * minor units and how often the cost recurs, on a power curve from £50/yr
 * (rMin) to £50,000/yr (rMax), capped at both ends. A one-off, or a
 * suggestion (no recurrence), counts its cost once; no cost is rMin.
 * @param {?number} [costMinor]
 * @param {?number} [recurrenceMonths]
 * @param {readonly number[]} [range]  [rMin, rMax]
 */
export function bodySize(costMinor, recurrenceMonths, range = DESK_SIZE) {
  const [rMin, rMax] = range;
  if (!costMinor || costMinor < 0) return rMin;
  const yearly = (costMinor / 100) * (recurrenceMonths && recurrenceMonths > 0 ? 12 / recurrenceMonths : 1);
  const k = Math.log(rMax / rMin) / Math.log(1000);
  const radius = Math.min(rMax, Math.max(rMin, rMin * Math.pow(yearly / 50, k)));
  return Math.round(radius * 10) / 10;
}

/**
 * Round 6 P's `impSize`, in the app's units: what a planet's radius is when
 * "planet size shows" is importance. The scenes' three sizes are low, normal
 * and high; not set is the smallest minus 0.5. The desk and the pocket each
 * have their own, as they have their own cost range.
 * @param {?string | undefined} level  "low" | "normal" | "high", or none
 * @param {"desk" | "pocket"} scene
 * @returns {number}
 */
export function importanceSize(level, scene) {
  const [low, normal, high] = IMPORTANCE_SIZE[scene];
  if (level === "high") return high;
  if (level === "normal") return normal;
  if (level === "low") return low;
  return low - 0.5;
}
/** P's `imp` for each scene: low, normal, high. */
const IMPORTANCE_SIZE = { desk: [4.5, 7.5, 11], pocket: [5, 8, 11.5] };

/**
 * A household's absolute position in the shared map. Bearing comes from one
 * hash, distance (600–800, the band the design scattered its sample five
 * across) from an independent one, so neither perturbs the other.
 *
 * @param {string} householdId
 * @returns {[number, number]}
 */
export function constellationPosOf(householdId) {
  const bearing = (hashId(householdId) / 0xffffffff) * Math.PI * 2;
  const distance = 640 + (hashId(`${householdId}/distance`) % 121);
  return [
    Math.round(Math.cos(bearing) * distance),
    Math.round(Math.sin(bearing) * distance),
  ];
}

/* The band's token comes from BAND_VAR (#1341); only `overdue` differs. A
   distant planet's overdue is the planet's own warmth, not the band's alarm. */
/** @type {Record<string, string>} */
const PLANET_TONES = {
  ...BAND_VAR,
  overdue: "--warm",
};

/**
 * The mini planets a distant constellation shows: its three most pressing
 * items as small bodies scattered deterministically around the ring, toned by
 * urgency. Offsets stay in the ±18..30 band the design used.
 *
 * @param {ChartItem[]} items
 * @param {string} today
 * @returns {Array<[number, number, number, string]>}
 */
export function constellationPlanetsOf(items, today) {
  const scheduled = items
    .filter((item) => item.status === "active")
    .map((item) => ({ item, days: daysUntil(item.dueDate, today) }))
    .sort((a, b) => (a.days ?? Infinity) - (b.days ?? Infinity))
    .slice(0, 3);
  return scheduled.map(({ item, days }, index) => {
    /* One 120° sector per planet, placed within it by identity: scattered
       like the design's, never piled onto one bearing by hash luck. These
       dots are decorative weather, not navigation — only the constellation's
       own bearing is sacred. */
    const angle = ((hashId(item.id) % 120) + index * 120) * (Math.PI / 180);
    const distance = 18 + (hashId(`${item.id}/orbit`) % 13);
    const radius = 2 + ((hashId(`${item.id}/size`) % 9) / 10);
    return [
      Math.round(Math.cos(angle) * distance),
      Math.round(Math.sin(angle) * distance),
      radius,
      PLANET_TONES[bandOf(days)],
    ];
  });
}

/* A ring dot's tone is the planet's own, where it is one a ring draws. */
/** @type {Record<string, string>} */
const RING_TONES = { "--warm": "--warm", "--ok": "--ok", "--upcoming": "--upcoming", "--overdue": "--overdue", "--ink-mid": "--ink-mid" };

/**
 * constellationPlanetsOf's planets as the dots on a small household ring
 * (#1353, web-27): the far sky's placement re-centred on the ring. `spread`
 * divides a planet's offset down to the ring's scale, and a dot's radius is
 * `rMin` plus the body's size times `rScale`.
 *
 * @param {Array<[number, number, number, string]>} planets
 * @param {{ centre: number, spread: number, rMin: number, rScale: number }} scale
 * @returns {{ cx: number, cy: number, r: number, tone: string }[]}
 */
export const ringDotsOf = (planets, { centre, spread, rMin, rScale }) =>
  planets.map(([x, y, r, tone]) => ({
    cx: centre + x / spread,
    cy: centre + y / spread,
    r: rMin + r * rScale,
    tone: RING_TONES[tone] ?? "--ok",
  }));

/** @type {Record<string, string>} */
const PAINTS = { overdue: "ruby", "due-soon": "amber", upcoming: "sky", ok: "jade", unscheduled: "jade", ended: "ended" };

/**
 * The body's word in the chart key (ADR-0044): an expiry is "expiry" (#1005, a
 * one-off ending is what the body IS), told by the item's schedule kind alone;
 * everything else is drawn as a service, as it always was. An item has no
 * type, and no body is drawn with a type face (#1322).
 *
 * @param {ChartItem} item
 * @returns {string}
 */
const chartWordOf = (item) => (item.scheduleKind === "expiry" ? "expiry" : "service");

/**
 * The urgency band, with the one exception the design rules (#1005): nothing is
 * owed once a one-off thing has ended, so an expiry past its date is never
 * overdue. It gets its own quiet band instead, and lingers there.
 *
 * @param {string} kind
 * @param {?number} [days]
 * @returns {string}
 */
export function bandOfKind(kind, days) {
  const band = bandOf(days);
  return kind === "expiry" && band === "overdue" ? "ended" : band;
}

/**
 * The dial's bodies (#414/#451): the household's active items placed by the
 * law, plus any document suggestions as un-accepted accent bodies. Sorted by
 * lead time. Decorations follow the chart key: every filed item's body is
 * drawn plain (#1322 -- the kind stays on the body as data, with no face of
 * its own; only a suggestion keeps its hollow accent look), a belt means
 * documents, a trail rides with anything within 60 days of the sun, the ping
 * sits on overdue, and the comet flies from the closest approach.
 *
 * A planet sits where its driving days put it (`drivingDays`, #1462); its
 * days, dates, band, overdue flag and the sort order stay on the real due date.
 *
 * @param {?ChartHousehold} household
 * @param {{ suggestions?: ChartSuggestion[], today: string, skyDriver?: ?string, firstWarningDays?: ?number, planetSize?: ?string }} options
 * @returns {ChartBody[]}
 */
export function dialBodiesOf(household, { suggestions = [], today, skyDriver, firstWarningDays, planetSize }) {
  const byImportance = planetSize === "importance";
  const driver = { skyDriver, firstWarningDays };
  /** @type {ChartBody[]} */
  const bodies = [];
  for (const item of household?.items ?? []) {
    if (item.status !== "active") continue;
    const days = daysUntil(item.dueDate, today);
    if (days === null) continue;
    const kind = chartWordOf(item);
    const driving = drivingDays({ days, reminderDays: item.reminderDays }, driver);
    bodies.push({
      id: item.id,
      title: item.title,
      days,
      drivingDays: driving,
      dueDate: item.dueDate,
      /* The dial law holds for an expiry too: it sits where its date falls,
         which after the date is inward, for as long as it lingers (#1005). */
      placement: dialPlacement(driving),
      pocketPlacement: dialPlacement(driving),
      size: byImportance ? importanceSize(item.importance, "desk") : bodySize(item.costMinor, item.recurrenceMonths),
      pocketSize: byImportance ? importanceSize(item.importance, "pocket") : bodySize(item.costMinor, item.recurrenceMonths, POCKET_SIZE),
      importance: item.importance ?? null,
      hollow: byImportance && !item.importance,
      paint: PAINTS[bandOfKind(kind, days)],
      kind,
      suggestion: false,
      costMinor: item.costMinor ?? null,
      costIsEstimate: Boolean(item.costIsEstimate),
      currency: item.currency ?? "GBP",
      documentCount: item.documentCount ?? 0,
      trail: Math.abs(days) <= 60,
      /* An expiry never turns ruby, never pings and is never counted as
         overdue -- there is nothing left to owe on it (#1005). */
      overdue: kind !== "expiry" && days < 0,
    });
  }
  for (const suggestion of suggestions) {
    const days = daysUntil(suggestion.renewsOn, today);
    if (days === null) continue;
    const driving = drivingDays({ days }, driver);
    bodies.push({
      id: suggestion.id,
      title: suggestion.title,
      days,
      drivingDays: driving,
      placement: dialPlacement(driving),
      pocketPlacement: dialPlacement(driving),
      size: byImportance ? importanceSize(null, "desk") : bodySize(suggestion.costMinor, null),
      pocketSize: byImportance ? importanceSize(null, "pocket") : bodySize(suggestion.costMinor, null, POCKET_SIZE),
      importance: null,
      hollow: false,
      paint: "accent",
      kind: "suggestion",
      suggestion: true,
      costMinor: suggestion.costMinor ?? null,
      costIsEstimate: true,
      currency: suggestion.currency ?? "GBP",
      documentCount: 0,
      trail: Math.abs(days) <= 60,
      overdue: false,
    });
  }
  bodies.sort((a, b) => a.days - b.days);
  /* Touching planets are nudged apart by bearing, once per scene size (#1464). */
  const desk = seatBodies(bodies.map((b) => ({ days: b.drivingDays, size: b.size, ...b.placement })), (b) => b.size);
  const pocket = seatBodies(bodies.map((b) => ({ days: b.drivingDays, size: b.pocketSize, ...b.placement })), (b) => b.size);
  bodies.forEach((body, i) => {
    body.placement = { angle: desk[i].angle, radius: desk[i].radius, x: desk[i].x, y: desk[i].y };
    body.pocketPlacement = { angle: pocket[i].angle, radius: pocket[i].radius, x: pocket[i].x, y: pocket[i].y };
  });
  const closest = bodies.find((body) => !body.suggestion && body.days >= 0);
  if (closest) closest.closest = true;
  return bodies;
}

/**
 * What an item's row says about where it stands, when it is not simply
 * waiting for its date (#1319; the coordinator's ruling, 2026-10-08: the
 * drawer opens any item, and its row says its state in its meta). A retired,
 * cancelled or expired item can be restored; a one-off that was completed
 * stays active with no date and no repeat, and says when it was done.
 * Null for everything else.
 *
 * @param {ChartItem} item
 * @param {ChartHousehold["activities"]} [activities]
 * @returns {{ word: string, restorable: boolean } | null}
 */
export function itemStateOf(item, activities = []) {
  if (item.status === "archived") return { word: "retired", restorable: true };
  if (item.status === "cancelled") return { word: "cancelled", restorable: true };
  if (item.status === "expired") return { word: "expired", restorable: true };
  if (item.status !== "active" || item.dueDate || item.recurrenceMonths) return null;
  /* the newest thing that happened to it; the kinds that end in "completed"
     are the engine's completions (service_completed, renewal_completed) */
  const last = (activities ?? [])
    .filter((one) => one.itemId === item.id)
    .reduce((newest, one) => (!newest || one.occurredAt > newest.occurredAt ? one : newest),
      /** @type {NonNullable<ChartHousehold["activities"]>[number] | null} */ (null));
  if (!last || !/completed$/u.test(last.kind)) return null;
  const day = (last.effectiveDate ?? last.occurredAt).slice(0, 10);
  return { word: `done ${dayMonth(day)}`, restorable: false };
}

/**
 * The manifest's groups: needs attention (inside 31 days, overdue first),
 * document suggestions, then later this year — with the closest approach
 * called out on the attention heading.
 *
 * @param {?ChartHousehold} household
 * @param {{ suggestions?: ChartSuggestion[], today: string }} options
 */
export function manifestGroupsOf(household, { suggestions = [], today }) {
  const rows = (household?.items ?? [])
    .filter((item) => item.status === "active")
    .map((item) => manifestRowOf(household, item, today))
    .sort((a, b) => (a.days ?? Infinity) - (b.days ?? Infinity));
  const attention = rows.filter((row) => row.days !== null && row.days <= 30);
  const later = rows.filter((row) => row.days === null || row.days > 30);
  const closest = rows.find((row) => row.days !== null && row.days >= 0) ?? null;
  return { attention, suggestions, later, closest };
}

/**
 * One item as a manifest row, whatever its status: the manifest's own rows,
 * and the one row the phone draws for an item it was asked for that the
 * manifest does not list (#1319). An item that is not active wears the
 * ended tone, never an urgency, and `state` says why.
 *
 * @param {?ChartHousehold} household
 * @param {ChartItem} item
 * @param {string} today
 */
export function manifestRowOf(household, item, today) {
  const section = (household?.sections ?? []).find((one) => one.id === item.sectionId);
  const days = daysUntil(item.dueDate, today);
  const state = itemStateOf(item, household?.activities);
  return {
    id: item.id,
    title: item.title,
    section: section?.name ?? null,
    days,
    dueDate: item.dueDate ?? null,
    band: item.status === "active" ? bandOfKind(chartWordOf(item), days) : "ended",
    provider: item.provider ?? null,
    recurrenceMonths: item.recurrenceMonths ?? null,
    costMinor: item.costMinor ?? null,
    costIsEstimate: Boolean(item.costIsEstimate),
    currency: item.currency ?? "GBP",
    kind: chartWordOf(item),
    state: state?.word ?? null,
    restorable: Boolean(state?.restorable),
  };
}

/**
 * The whole fixed sky for a workspace, in the shape the home renderer eats.
 * The primary household is the map origin by construction — the viewer
 * stands at the centre of their own sky, exactly as the ratified design
 * scattered its sample — and every other household sits at its own
 * identity-derived bearing, which therefore never moves for anyone.
 */
/**
 * One household as the sky draws it — the shape `galaxyOf` and `labelledSkyOf`
 * both produce, keyed by household id.
 *
 * `role` is null in the labelled sky (§11): a viewer who belongs to nothing is
 * neither owner nor member of what they can see. `requested` appears only
 * there, where asking to join is the only thing you can do with a household.
 *
 * @typedef {object} GalaxyEntry
 * @property {string} name
 * @property {"owner" | "member" | null} role
 * @property {[number, number]} pos            bearing and distance, CON-13
 * @property {Array<[number, number, number, string]>} planets  dx, dy, r, tone
 * @property {number} [items]                  total item count — galaxyOf only,
 *                                              for the constellations backdrop's
 *                                              "N ITEMS" label (#474/#475)
 * @property {boolean} [requested]             labelled sky only
 */

/**
 * @param {?ChartWorkspace} workspace
 * @param {string} today
 * @returns {Record<string, GalaxyEntry>}
 */
export function galaxyOf(workspace, today) {
  const households = (workspace?.households ?? []).slice(0, 5);
  const primary = workspace?.activeHouseholdId ?? households[0]?.id;
  /** @type {Record<string, GalaxyEntry>} */
  const galaxy = {};
  for (const household of households) {
    galaxy[household.id] = {
      name: household.name,
      role: household.canManage ? "owner" : "member",
      pos: household.id === primary ? [0, 0] : constellationPosOf(household.id),
      planets: constellationPlanetsOf(household.items ?? [], today),
      items: (household.items ?? []).length,
    };
  }
  return galaxy;
}

/**
 * The labelled sky (§11, #453): what a user with no household sees — every
 * visible household at its identity bearing, label only. No planets, no
 * role, no contents: the label IS the entire surface.
 *
 * @param {ChartHousehold[] | null | undefined} visibleHouseholds
 * @returns {Record<string, GalaxyEntry>}
 */
export function labelledSkyOf(visibleHouseholds) {
  /*
   * At most twelve DRAWN constellations (owner decision 2026-09-01, #670).
   *
   * This used to be uncapped, on the reasoning that a newcomer must see every
   * system there is and that "the overlap relaxation keeps a crowded sky
   * clickable". The second half of that was untrue, and #670 is the bill: a
   * relaxation is asymptotic, so past the point where the sky physically
   * holds them it settles constellations ON TOP of each other rather than
   * merely close together. Two overlapping hit circles mean a click aimed at
   * one household lands on another — and that click sends a join request to
   * whoever it landed on. An uncapped sky therefore does not show a newcomer
   * every system, it shows them a sky that misdirects their choice.
   *
   * Twelve is an upper bound, not a promise (owner ruling 2026-09-02): the
   * floor pass in `placement.js` guarantees the separation, and on a small or
   * short viewport twelve is more than the sky can separate at all, so the
   * effective cap is min(12, what the floor pass can place) — the pass marks
   * anything past its last legal rank undrawn rather than placing it
   * sub-floor. Nobody loses a household to either cap: the "where do you
   * belong?" list in `Newcomer.svelte` is fed the FULL set, so every
   * household stays reachable by name whether or not the sky drew it.
   */
  /** @type {Record<string, GalaxyEntry>} */
  const galaxy = {};
  for (const household of (visibleHouseholds ?? []).slice(0, 12)) {
    galaxy[household.id] = {
      name: household.name,
      role: null,
      pos: constellationPosOf(household.id),
      planets: [],
      requested: Boolean(household.requested),
    };
  }
  return galaxy;
}


/**
 * The approach corridor (#461): every active item across every household,
 * unrolled onto a line of time. Overdue sits in the red zone above today; the
 * rest of the current month follows headerless; each later month with
 * anything approaching gets its rule. An order, not a scale. An item kept
 * without a date (#1281) rides at the foot, in `undated`, with the undated
 * suggestions: counted in `total`, never in a month, and no part of the
 * horizon.
 *
 * @typedef {object} CorridorRow  a scheduled item, or an un-accepted suggestion, on the line
 * @property {string} id
 * @property {boolean} [suggestion]
 * @property {?string} [receiptId]
 * @property {string} title
 * @property {?string} household
 * @property {boolean} away
 * @property {?string} [section]
 * @property {?string} [sectionId]     issue 1319, the section word's colour (option-colour.js)
 * @property {?string} [sectionIcon]   issue 867, the mark printed beside the row
 * @property {?string} [sectionAccent]
 * @property {number} days
 * @property {?string} dueDate
 * @property {string} band
 * @property {?string} provider
 * @property {?number} costMinor
 * @property {boolean} costIsEstimate
 * @property {string} currency
 * @property {string} [kind]
 * @property {?string} [sourceDocument]
 * @property {?string} [state]          issue 1319: "retired", "done 12 Jun"… (itemStateOf)
 * @property {boolean} [restorable]     issue 1319: retired, cancelled or expired
 *
 * @param {ChartWorkspace | null | undefined} workspace
 * @param {string} today
 * `include` names one item to put on the line whatever its status: the one
 * the address asked for (#1319, the drawer opens any item). It sits at its
 * own date, in the ended tone, its state on the row.
 *
 * @param {{ suggestions?: ChartSuggestion[], include?: ?string }} [options]
 */
export function corridorOf(workspace, today, options = {}) {
  const primary = workspace?.activeHouseholdId ?? workspace?.households?.[0]?.id ?? null;
  /** @type {CorridorRow[]} */
  const rows = [];
  for (const household of workspace?.households ?? []) {
    const sections = new Map((household.sections ?? []).map((s) => [s.id, s]));
    for (const item of household.items ?? []) {
      if (item.status !== "active" && item.id !== options.include) continue;
      const days = daysUntil(item.dueDate, today);
      const state = itemStateOf(item, household.activities);
      /* #867: the mark beside the entry — the section's own stored icon and
         accent, same as the Sections card and the dial's own legend read. */
      const section = sections.get(/** @type {string} */ (item.sectionId));
      rows.push({
        id: item.id,
        title: item.title,
        household: household.name,
        away: household.id !== primary,
        section: section?.name ?? null,
        sectionId: section?.id ?? null,
        sectionIcon: section?.icon ?? null,
        sectionAccent: section?.accent ?? null,
        /* #1281: no date sorts after every dated row, as an undated catch
           does below; no date is invented. */
        days: days ?? Number.MAX_SAFE_INTEGER,
        dueDate: item.dueDate ?? null,
        band: item.status === "active" ? bandOfKind(chartWordOf(item), days) : "ended",
        provider: item.provider ?? null,
        costMinor: item.costMinor ?? null,
        costIsEstimate: Boolean(item.costIsEstimate),
        currency: item.currency ?? "GBP",
        kind: chartWordOf(item),
        state: state?.word ?? null,
        restorable: Boolean(state?.restorable),
      });
    }
  }
  /* §14: suggestions ride the same line, in chronological order — a dashed
     row at its renewal date, still awaiting the two-tap. Undated catches sit
     at the very end of the corridor rather than inventing a date. */
  for (const suggestion of options.suggestions ?? []) {
    const days = daysUntil(suggestion.renewsOn, today);
    rows.push({
      id: suggestion.id,
      suggestion: true,
      receiptId: suggestion.receiptId ?? null,
      title: suggestion.title,
      household: null,
      away: false,
      section: null,
      days: days ?? Number.MAX_SAFE_INTEGER,
      dueDate: suggestion.renewsOn ?? null,
      band: "suggestion",
      provider: null,
      costMinor: suggestion.costMinor ?? null,
      costIsEstimate: true,
      currency: suggestion.currency ?? "GBP",
      kind: "suggestion",
      sourceDocument: suggestion.sourceDocument ?? null,
    });
  }
  rows.sort((a, b) => a.days - b.days || a.id.localeCompare(b.id));
  /* An expiry that has passed is not in the red zone and is not counted with
     it (#1005) -- nothing is owed on a thing that has ended. It keeps its seat
     on the line at the date it fell, which is where the reader looks for it. */
  const isOverdue = (/** @type {CorridorRow} */ row) => row.days < 0 && row.kind !== "expiry" && !row.restorable;
  const overdue = rows.filter(isOverdue);
  const ahead = rows.filter((row) => !isOverdue(row));
  const currentKey = today.slice(0, 7);
  const current = ahead.filter((row) => row.dueDate?.slice(0, 7) === currentKey);
  /** @type {{ key: string, label: string, rows: CorridorRow[] }[]} */
  const months = [];
  const undated = ahead.filter((row) => !row.dueDate);
  for (const row of ahead) {
    if (!row.dueDate) continue;
    const key = row.dueDate.slice(0, 7);
    if (key === currentKey) continue;
    const last = months[months.length - 1];
    if (last?.key === key) last.rows.push(row);
    else months.push({ key, label: MONTHS[Number(key.slice(5)) - 1].toUpperCase(), rows: [row] });
  }
  /* Every row here passed the `row.dueDate` truthy check the filter reads,
     but TS's `.filter()` type doesn't narrow on a plain truthy predicate —
     the cast below says only what the filter already guarantees. */
  const dated = /** @type {(CorridorRow & { dueDate: string })[]} */ (ahead.filter((row) => row.dueDate));
  const lastKey = dated[dated.length - 1]?.dueDate.slice(0, 7) ?? currentKey;
  const monthsSpanned =
    (Number(lastKey.slice(0, 4)) - Number(today.slice(0, 4))) * 12 +
    (Number(lastKey.slice(5)) - Number(today.slice(5, 7))) + 1;
  return {
    overdue, current, months, undated,
    /* what is on the line now; an item put here only because it was asked for (`include`) is not */
    total: rows.filter((row) => !row.restorable).length,
    systems: new Set(rows.map((row) => row.household).filter(Boolean)).size,
    monthsSpanned,
    /* the long name of the horizon month, for the closing line */
    horizon: dated.length
      ? monthOnly(dated[dated.length - 1].dueDate)
      : null,
  };
}
