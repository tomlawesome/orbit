/**
 * A home theme pick, from the account card (`$lib/AccountCard.svelte`, shared
 * with Chrome since #1689; the pocket hatch uses `$lib/theme-swatches.js`).
 * The theme goes through chooseTheme, the one pick every screen uses: it
 * applies the pack, writes the pre-paint cache, saves it to the server and
 * counts the pick, so a session read already in flight cannot put the old
 * theme back. The pressed swatch is the card's own state.
 * @param {string} name the pack id
 */

import { chooseTheme } from "$lib/pick.js";

/** @param {string} name */
export function setSwatch(name) {
  return chooseTheme(name);
}
