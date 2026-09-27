import { THEME_PACKS } from "./theme.js";

/*
 * The five theme swatches the account menus offer, and choosing one (#1120).
 * Shared by Chrome.svelte's desk card and the pocket hatch (pocket/Hatch.svelte)
 * rather than held in each; home's own rows (routes/home/swatches.js) join
 * when home moves onto the hatch in step 2.
 *
 * THE v1.3.0 ROSTER, FINAL (§15, owner: "the release theme list is star
 * chart, after dark, CLOUDS, dawn terminator, and retrograde"). Five packs,
 * five swatches, in the order and membership theme.js names (#865) -- atlas,
 * hanami, porcelain, miami and solarium are on the records shelf, offered
 * nowhere a reader can choose.
 *
 * The dot is the pack's most telling colour rather than strictly its --bg:
 * clouds shows the cool white of a cloud crest, which is the lighter end of
 * the range it was admitted to carry, and dawn shows the temperature story's
 * own ground now that the terminator has moved it off #c3ccdb.
 */
/** @type {Record<string, [string, string, string]>} */
const SWATCH = {
  starchart: ["star-chart", "#060b1c", ""],
  afterdark: ["after dark", "#05070d", ""],
  clouds: ["clouds", "#eef2f9", ""],
  dawn: ["dawn", "#d2d3d4", ""],
  retrograde: ["retrograde", "#080a14", "inset 0 0 0 1px #ff4fd8"],
};

/** @type {{ id: string, title: string, colour: string, shadow: string }[]} */
export const SWATCHES = THEME_PACKS.map((id) => {
  const [title, colour, shadow] = SWATCH[id];
  return { id, title, colour, shadow };
});

/**
 * Puts a pack on the page now and caches it for the next paint, the same
 * pre-paint cache home writes.
 * @param {string} id
 */
export function applyTheme(id) {
  document.documentElement.dataset.theme = id;
  try { localStorage.setItem("orbit-theme", id); } catch { /* private mode: this page only */ }
}
