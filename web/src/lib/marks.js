/**
 * The pen's whole set of section marks (#867) — one table, three consumers:
 * the household screen's Sections card, the manifest, and the dial's own
 * section legend all draw a mark from here rather than keeping their own
 * copy of the figures.
 *
 * Five shipped glyphs (home, vehicle, device, service, calendar) never
 * change meaning or ink. Seven asterisms — hook, kite, ladle, cross, bow,
 * wedge, belt — are pen-drawn: a few stars (nodes r=.9) joined by one
 * stroke in the chart ink, nothing filled. Twelve marks is the cap. Every
 * id here is also in src/lib/domain.ts's `sectionIcons` (the server's own
 * validation) — keep the two lists in step if either changes.
 *
 * The seven asterisms' paths are taken verbatim from the ratified mockup,
 * design/v19/sections-mark/round-1/a-asterisms.html's `GL` table (owner,
 * 2026-09-16: "Yes."), not redrawn.
 */

/**
 * A figure's own stroked nodes — Mark.svelte draws each as a plain
 * `<circle r=".9">`, never through `{@html}` (no raw markup travels through
 * this table; every element Mark.svelte renders is a real Svelte node).
 * @param {number} cx @param {number} cy
 * @returns {{ cx: number, cy: number }}
 */
const N = (cx, cy) => ({ cx, cy });

/**
 * @typedef {object} MarkGlyph
 * @property {string} ink   one of src/lib/domain.ts's sectionAccents
 * @property {{ d: string, transform?: string, strokeWidth?: number }[]} [paths]
 * @property {{ x: number, y: number, width: number, height: number, rx: number }[]} [rects]
 * @property {{ cx: number, cy: number }[]} [nodes]   stars, r=.9, nothing filled
 */

/** @type {Record<string, MarkGlyph>} */
export const MARKS = {
  home: { ink: "sage", paths: [{ d: "M2.6 7.7 8 3.1l5.4 4.6" }, { d: "M4.3 7.4v5.6h7.4V7.4" }] },
  vehicle: {
    ink: "blue",
    paths: [{ d: "M2.7 10.6V9.1l1.6-2.7h7.4l1.6 2.7v1.5" }],
    nodes: [{ cx: 5.2, cy: 10.7 }, { cx: 10.8, cy: 10.7 }],
  },
  device: {
    ink: "sand",
    rects: [{ x: 4.2, y: 2.7, width: 7.6, height: 10.6, rx: 1.5 }],
    paths: [{ d: "M6.7 11.6h2.6" }],
  },
  service: {
    ink: "plum",
    paths: [{
      d: "M14.6 6.4a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.8-3.8a6 6 0 0 1-7.9 7.9l-6.9 6.9a2.1 2.1 0 0 1-3-3l6.9-6.9a6 6 0 0 1 7.9-7.9l-3.8 3.8z",
      transform: "scale(.667)", strokeWidth: 1.7,
    }],
  },
  calendar: {
    ink: "coral",
    rects: [{ x: 2.6, y: 3.6, width: 10.8, height: 9.8, rx: 1.4 }],
    paths: [{ d: "M2.6 6.6h10.8M5.6 2.3v2.2M10.4 2.3v2.2" }],
  },
  hook: {
    ink: "sage",
    paths: [{ d: "M2.6 9.4 6 5.6l4.4 1.6 3-3.6" }],
    nodes: [N(2.6, 9.4), N(6, 5.6), N(10.4, 7.2), N(13.4, 3.6)],
  },
  kite: {
    ink: "blue",
    paths: [{ d: "M7 2.8 13 6.5 9 13.2 3 8.5z" }],
    nodes: [N(7, 2.8), N(13, 6.5), N(9, 13.2), N(3, 8.5)],
  },
  ladle: {
    ink: "sand",
    paths: [{ d: "M2.5 3.5 5.5 5.5 8.5 6l4-1 1 4.5-4 1z" }],
    nodes: [N(2.5, 3.5), N(5.5, 5.5), N(8.5, 6), N(12.5, 5), N(13.5, 9.5), N(9.5, 10.5)],
  },
  cross: {
    ink: "plum",
    paths: [{ d: "M3 3.5 13 12.5M11 3 5.5 13" }],
    nodes: [N(3, 3.5), N(13, 12.5), N(11, 3), N(5.5, 13)],
  },
  bow: {
    ink: "coral",
    paths: [{ d: "M2.5 11.5Q8 1.5 13.5 11.5" }],
    nodes: [N(2.5, 11.5), N(8, 6.5), N(13.5, 11.5)],
  },
  wedge: {
    ink: "sage",
    paths: [{ d: "M4 13 8 3l5 8z" }],
    nodes: [N(4, 13), N(8, 3), N(13, 11)],
  },
  belt: {
    ink: "blue",
    paths: [{ d: "M3 12.5 8 8l5-4.5" }],
    nodes: [N(3, 12.5), N(8, 8), N(13, 3.5)],
  },
};

/** The five original glyphs: fixed to their section, never a button. */
export const SHIPPED_MARKS = new Set(["home", "vehicle", "device", "service", "calendar"]);

/**
 * The seven asterisms, in the pen's own order — the order a household's
 * marks are assigned in, and the order the pen recycles through once every
 * asterism in the household is worn.
 */
export const PEN_ORDER = ["hook", "kite", "ladle", "cross", "bow", "wedge", "belt"];

/**
 * The mark a new section wears on arrival: the first asterism this
 * household's other sections have not worn yet. A lone new section always
 * wears "hook". `MAX_SECTIONS` (12) against 4 real shipped defaults leaves
 * room for more user sections than there are asterisms (8 against 7); past
 * that the pen recycles from the start rather than leaving a section
 * markless, in the same pen order.
 * @param {Iterable<string>} wornIcons every icon already worn in this household
 * @returns {string}
 */
export function nextMark(wornIcons) {
  const worn = new Set(wornIcons);
  return PEN_ORDER.find((icon) => !worn.has(icon)) ?? PEN_ORDER[0];
}

/**
 * The ink a mark id prints in — icon and accent travel together, never
 * chosen apart.
 * @param {string} icon
 * @returns {string}
 */
export function inkOf(icon) {
  return MARKS[icon]?.ink ?? MARKS.home.ink;
}

/**
 * The household's real default sections — always these ids, created for
 * every household, never a button (domain.ts's `defaultSections`: four
 * today, not the five the vocabulary has room for — "calendar" is a
 * reserved shipped glyph, not a fifth id every household gets).
 *
 * This is the whole of #867's migration: nothing is written to an existing
 * section's stored icon/accent. A user section saved before this issue
 * keeps whatever it already had (in practice, the pre-#867 fallback,
 * "home"/"sage" — 2b's open question, never actually chosen) and LOOKS
 * like the real Home section until the owner notices and taps to swap it —
 * but every consumer (the Sections card, the constellation, the corridor)
 * already offers that swap the moment this ships, because `shipped` is
 * decided by the section's id, never by what it happens to be wearing.
 */
export const SHIPPED_SECTION_IDS = new Set(["home", "vehicle", "device", "service"]);
