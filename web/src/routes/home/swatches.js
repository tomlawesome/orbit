/**
 * The theme swatch row shared between the desk account panel (`.account`,
 * +page.svelte) and the pocket account sheet (`.msheet`, pocket.svelte,
 * #852): the same five buttons, the same titles, the same click behaviour.
 *
 * Used to live entirely inside home.behaviour.js's `mountHome` closure. #852
 * needed the same wiring for the pocket dialect's sheet, and copying it would
 * have left two copies to keep in sync by hand, so it moved here instead —
 * home.behaviour.js imports it; the pocket hatch uses $lib/theme-swatches.js.
 */

import { chooseTheme } from "$lib/pick.js";

/* title -> pack name: "star-chart" is starchart, "after dark" is afterdark. */
/** @type {(button: HTMLElement) => string} */
export const packOf = (button) => button.title.replace(/[\s-]/g, "");

/**
 * A home swatch press. The theme itself goes through chooseTheme, the one
 * pick every screen uses: it applies the pack, writes the pre-paint cache,
 * saves it to the server and counts the pick, so a session read already in
 * flight cannot put the old theme back. Only the pressed state is home's own.
 * @param {string} name
 * @param {HTMLElement} button
 */
export function setSwatch(name, button) {
  for (const other of /** @type {HTMLElement} */ (button.parentElement).querySelectorAll("button"))
    other.setAttribute("aria-pressed", String(other === button));
  return chooseTheme(name);
}

/**
 * Reconciles every swatch row's pressed state with the live theme. Both
 * dialects' rows ship with star-chart pressed (the mockup's own default), so
 * a reader who restored a different pack before paint needs this run once at
 * mount, or the pressed swatch and the live theme disagree until they click.
 * @param {ParentNode} [root]
 */
export function syncSwatches(root = document) {
  const active = document.documentElement.dataset.theme;
  for (const button of /** @type {NodeListOf<HTMLElement>} */ (root.querySelectorAll(".swatches button, .mswatches button")))
    button.setAttribute("aria-pressed", String(packOf(button) === active));
}
