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
  for (const item of household.items ?? []) {
    if (item.status !== "active") continue;
    const days = daysUntil(item.dueDate, today);
    if (days === null) continue;
    bodies.push({
      id: item.id,
      title: item.title,
      days,
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
  const sections = new Map((household.sections ?? []).map((s) => [s.id, s.name]));
  const rows = (household.items ?? [])
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
