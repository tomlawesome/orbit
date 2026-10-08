/**
 * A COLOUR PER SECTION AND PER TYPE (#1319; owner-decisions §34; design/v19/
 * belt-purpose/round-8/m-colour-per-option.html, approved 2026-10-08):
 * "Over time users would associate colours with specific type/sections."
 *
 * Round 8 names seven colours, each a token pair in every pack (packs.css,
 * `--c-<name>` and its text-grade twin `--c-<name>-text`): four for sections
 * — Home orange, Vehicles teal, Devices violet, Services magenta — and three
 * for types — service lime, renewal rose, inspection cyan. `data-opt="<name>"`
 * on an element maps the pair onto `--opt` / `--opt-text` (packs.css), which
 * the chooser's tiles, the drawer's section and type values and the
 * manifest's section word read. Never the dial: its colours mean urgency.
 *
 * Sections are the household's own, not a fixed four, so the colour has to
 * follow a rule that never moves under a household that has learned it:
 *
 *   · the four shipped sections (their ids are fixed, marks.js
 *     SHIPPED_SECTION_IDS) wear their own colour;
 *   · any other section takes the colour of its MARK, the glyph it already
 *     wears beside its name: the twelve marks in the vocabulary's own order
 *     (src/lib/domain.ts sectionIcons) cycle the four colours, so the four
 *     shipped marks keep theirs, and calendar, hook, kite, ladle, cross,
 *     bow, wedge and belt run orange, teal, violet, magenta twice over;
 *   · a section with no mark Orbit knows takes one by its id's hash.
 *
 * A household with more than four sections shares colours; round 8 has four.
 */

/** The four section colours, in the vocabulary's order. */
export const SECTION_COLOURS = /** @type {const} */ (["home", "vehicles", "devices", "services"]);
/** The three type colours. */
export const TYPE_COLOURS = /** @type {const} */ (["service", "renewal", "inspection"]);

/** The shipped sections' fixed ids (domain.ts defaultSections). */
const SHIPPED = /** @type {Record<string, string>} */ ({
  home: "home", vehicle: "vehicles", device: "devices", service: "services",
});
/** domain.ts sectionIcons, in its order — keep in step with it. */
const MARK_ORDER = [
  "home", "vehicle", "device", "service", "calendar",
  "hook", "kite", "ladle", "cross", "bow", "wedge", "belt",
];

/** FNV-1a, as chart.js hashId: a stable number from a string. @param {string} text */
function hashOf(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

/**
 * The colour a section wears, by the rule above; null without a section.
 * @param {{ id?: string | null, icon?: string | null } | null | undefined} section
 * @returns {string | null}
 */
export function sectionColourOf(section) {
  if (!section || (!section.id && !section.icon)) return null;
  if (section.id && SHIPPED[section.id]) return SHIPPED[section.id];
  const mark = MARK_ORDER.indexOf(section.icon ?? "");
  if (mark >= 0) return SECTION_COLOURS[mark % SECTION_COLOURS.length];
  return SECTION_COLOURS[hashOf(String(section.id)) % SECTION_COLOURS.length];
}

/**
 * The colour a type wears: service, renewal and inspection have one; any
 * other subtype (a document's expiry, the relay's own words) has none.
 * @param {string | null | undefined} type
 * @returns {string | null}
 */
export function typeColourOf(type) {
  return TYPE_COLOURS.includes(/** @type {any} */ (type)) ? /** @type {string} */ (type) : null;
}
