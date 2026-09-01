/**
 * The workspace → chart transform (#451): every geometric and tonal decision
 * the home screen makes about real data lives here, as pure functions.
 *
 * The dial is an orbital calendar — the one law the ratified mockup's bodies
 * were drawn by (#414): today sits at 12 o'clock and each day of lead time is
 * one degree clockwise, so angle° = daysUntilDue − 90. Distance grows
 * linearly with time, radius = 62 + 0.242·days, bounded by the dial rim;
 * overdue bodies fall inward at 0.625/day, floored clear of the sun. Every
 * mockup body obeys this to ~2px of hand jitter except the T−161d body,
 * which was hand-placed where 177 days would sit — the #414 defect, corrected
 * here and in the mockup together.
 *
 * The sky is fixed (CON-13, #428): a household's absolute map position is a
 * pure function of its identity, so its bearing can never move between
 * sessions, days, or devices. Product cap is five households.
 */

const DIAL_CENTRE = 190;
const RIM = 166;
const SUN_CLEARANCE = 24;

/** FNV-1a, 32-bit: a stable, dependency-free hash for identity → geometry. */
export function hashId(text) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/** Calendar-day difference, clock-independent. null when unscheduled. */
export function daysUntil(dueDate, today) {
  if (!dueDate) return null;
  return Math.round((Date.parse(dueDate) - Date.parse(today)) / 86400000);
}

/** The chart key's urgency bands: overdue / due soon / upcoming / wide orbit. */
export function bandOf(days) {
  if (days === null || days === undefined) return "unscheduled";
  if (days < 0) return "overdue";
  if (days <= 30) return "due-soon";
  if (days <= 90) return "upcoming";
  return "ok";
}

/** Where a body with this much lead time sits on the dial. */
export function dialPlacement(days) {
  const angle = (Math.max(-90, Math.min(days, 430)) - 90) * (Math.PI / 180);
  const radius = days >= 0
    ? Math.min(62 + 0.242 * days, RIM)
    : Math.max(SUN_CLEARANCE, 62 - 0.625 * -days);
  return {
    angle,
    radius,
    x: Math.round((DIAL_CENTRE + Math.cos(angle) * radius) * 10) / 10,
    y: Math.round((DIAL_CENTRE + Math.sin(angle) * radius) * 10) / 10,
  };
}

/** Bigger = costlier (chart key). Radius in dial units from minor units. */
export function bodySize(costMinor) {
  if (!costMinor) return 4;
  const pounds = Math.max(costMinor / 100, 1);
  return Math.min(8.5, Math.max(3.5, Math.round((0.8 + 1.09 * Math.log(pounds)) * 10) / 10));
}

/**
 * A household's absolute position in the shared map. Bearing comes from one
 * hash, distance (600–800, the band the design scattered its sample five
 * across) from an independent one, so neither perturbs the other.
 */
export function constellationPosOf(householdId) {
  const bearing = (hashId(householdId) / 0xffffffff) * Math.PI * 2;
  const distance = 640 + (hashId(`${householdId}/distance`) % 121);
  return [
    Math.round(Math.cos(bearing) * distance),
    Math.round(Math.sin(bearing) * distance),
  ];
}

const PLANET_TONES = {
  overdue: "--warm",
  "due-soon": "--warm",
  upcoming: "--upcoming",
  ok: "--ok",
  unscheduled: "--ok",
};

/**
 * The mini planets a distant constellation shows: its three most pressing
 * items as small bodies scattered deterministically around the ring, toned by
 * urgency. Offsets stay in the ±18..30 band the design used.
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

const PAINTS = { overdue: "ruby", "due-soon": "amber", upcoming: "sky", ok: "jade", unscheduled: "jade" };

/**
 * The dial's bodies (#414/#451): the household's active items placed by the
 * law, plus any document suggestions as un-accepted accent bodies. Sorted by
 * lead time. Decorations follow the chart key: kind marks the body's face
 * (crescent = inspection, cored = renewal, plain = service), a belt means
 * documents, a trail rides with anything within 60 days of the sun, the ping
 * sits on overdue, and the comet flies from the closest approach.
 */
export function dialBodiesOf(household, { suggestions = [], today }) {
  const bodies = [];
  for (const item of household?.items ?? []) {
    if (item.status !== "active") continue;
    const days = daysUntil(item.dueDate, today);
    if (days === null) continue;
    bodies.push({
      id: item.id,
      title: item.title,
      days,
      dueDate: item.dueDate,
      placement: dialPlacement(days),
      size: bodySize(item.costMinor),
      paint: PAINTS[bandOf(days)],
      kind: item.subtype === "inspection" ? "inspection" : item.scheduleKind === "renewal" ? "renewal" : "service",
      suggestion: false,
      costMinor: item.costMinor ?? null,
      costIsEstimate: Boolean(item.costIsEstimate),
      currency: item.currency ?? "GBP",
      documentCount: item.documentCount ?? 0,
      trail: Math.abs(days) <= 60,
      overdue: days < 0,
    });
  }
  for (const suggestion of suggestions) {
    const days = daysUntil(suggestion.renewsOn, today);
    if (days === null) continue;
    bodies.push({
      id: suggestion.id,
      title: suggestion.title,
      days,
      placement: dialPlacement(days),
      size: bodySize(suggestion.costMinor),
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
  const closest = bodies.find((body) => !body.suggestion && body.days >= 0);
  if (closest) closest.closest = true;
  return bodies;
}

/**
 * The manifest's groups: needs attention (inside 31 days, overdue first),
 * document suggestions, then later this year — with the closest approach
 * called out on the attention heading.
 */
export function manifestGroupsOf(household, { suggestions = [], today }) {
  const sections = new Map((household?.sections ?? []).map((s) => [s.id, s.name]));
  const rows = (household?.items ?? [])
    .filter((item) => item.status === "active")
    .map((item) => ({
      id: item.id,
      title: item.title,
      section: sections.get(item.sectionId) ?? null,
      days: daysUntil(item.dueDate, today),
      dueDate: item.dueDate ?? null,
      band: bandOf(daysUntil(item.dueDate, today)),
      provider: item.provider ?? null,
      recurrenceMonths: item.recurrenceMonths ?? null,
      costMinor: item.costMinor ?? null,
      costIsEstimate: Boolean(item.costIsEstimate),
      currency: item.currency ?? "GBP",
      kind: item.subtype === "inspection" ? "inspection" : item.scheduleKind === "renewal" ? "renewal" : "service",
    }))
    .sort((a, b) => (a.days ?? Infinity) - (b.days ?? Infinity));
  const attention = rows.filter((row) => row.days !== null && row.days <= 30);
  const later = rows.filter((row) => row.days === null || row.days > 30);
  const closest = rows.find((row) => row.days !== null && row.days >= 0) ?? null;
  return { attention, suggestions, later, closest };
}

/**
 * The whole fixed sky for a workspace, in the shape the home renderer eats.
 * The primary household is the map origin by construction — the viewer
 * stands at the centre of their own sky, exactly as the ratified design
 * scattered its sample — and every other household sits at its own
 * identity-derived bearing, which therefore never moves for anyone.
 */
export function galaxyOf(workspace, today) {
  const households = (workspace?.households ?? []).slice(0, 5);
  const primary = workspace?.activeHouseholdId ?? households[0]?.id;
  const galaxy = {};
  for (const household of households) {
    galaxy[household.id] = {
      name: household.name,
      role: household.canManage ? "owner" : "member",
      pos: household.id === primary ? [0, 0] : constellationPosOf(household.id),
      planets: constellationPlanetsOf(household.items ?? [], today),
    };
  }
  return galaxy;
}

/**
 * The labelled sky (§11, #453): what a user with no household sees — every
 * visible household at its identity bearing, label only. No planets, no
 * role, no contents: the label IS the entire surface.
 */
export function labelledSkyOf(visibleHouseholds) {
  /*
   * Twelve DRAWN constellations, and no more (owner decision 2026-09-01,
   * #670).
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
   * The floor pass in `placement.js` guarantees the separation; the cap is
   * what keeps the sky inside the capacity that guarantee needs. Nobody loses
   * a household to it: the "where do you belong?" list in `Newcomer.svelte`
   * is fed the FULL set, so every household stays reachable by name. The sky
   * is capped; the list is not.
   */
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

const MONTH_LABELS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];

/**
 * The approach corridor (#461): every active scheduled item across every
 * household, unrolled onto a line of time. Overdue sits in the red zone above
 * today; the rest of the current month follows headerless; each later month
 * with anything approaching gets its rule. An order, not a scale.
 */
export function corridorOf(workspace, today, options = {}) {
  const primary = workspace?.activeHouseholdId ?? workspace?.households?.[0]?.id ?? null;
  const rows = [];
  for (const household of workspace?.households ?? []) {
    const sections = new Map((household.sections ?? []).map((s) => [s.id, s.name]));
    for (const item of household.items ?? []) {
      if (item.status !== "active" || !item.dueDate) continue;
      const days = daysUntil(item.dueDate, today);
      rows.push({
        id: item.id,
        title: item.title,
        household: household.name,
        away: household.id !== primary,
        section: sections.get(item.sectionId) ?? null,
        days,
        dueDate: item.dueDate,
        band: bandOf(days),
        provider: item.provider ?? null,
        costMinor: item.costMinor ?? null,
        costIsEstimate: Boolean(item.costIsEstimate),
        currency: item.currency ?? "GBP",
        kind: item.subtype === "inspection" ? "inspection" : item.scheduleKind === "renewal" ? "renewal" : "service",
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
  const overdue = rows.filter((row) => row.days < 0);
  const ahead = rows.filter((row) => row.days >= 0);
  const currentKey = today.slice(0, 7);
  const current = ahead.filter((row) => row.dueDate?.slice(0, 7) === currentKey);
  const months = [];
  const undated = ahead.filter((row) => !row.dueDate);
  for (const row of ahead) {
    if (!row.dueDate) continue;
    const key = row.dueDate.slice(0, 7);
    if (key === currentKey) continue;
    const last = months[months.length - 1];
    if (last?.key === key) last.rows.push(row);
    else months.push({ key, label: MONTH_LABELS[Number(key.slice(5)) - 1], rows: [row] });
  }
  const dated = ahead.filter((row) => row.dueDate);
  const lastKey = dated[dated.length - 1]?.dueDate.slice(0, 7) ?? currentKey;
  const monthsSpanned =
    (Number(lastKey.slice(0, 4)) - Number(today.slice(0, 4))) * 12 +
    (Number(lastKey.slice(5)) - Number(today.slice(5, 7))) + 1;
  return {
    overdue, current, months, undated,
    total: rows.length,
    systems: new Set(rows.map((row) => row.household).filter(Boolean)).size,
    monthsSpanned,
    /* the long name of the horizon month, for the closing line */
    horizon: dated.length
      ? new Date(dated[dated.length - 1].dueDate + "T00:00:00Z")
          .toLocaleDateString("en-GB", { month: "long", timeZone: "UTC" })
      : null,
  };
}
