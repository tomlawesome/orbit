/**
 * THE THEME ROSTER, ONE PLACE (#865).
 *
 * Before this, the roster and its default were hand-written in at least four
 * places — app.html's pre-paint script, Chrome.svelte's swatches,
 * settings/+page.svelte's swatches, and tour/emphasis.js's forward/dim
 * classification — and two of the four disagreed about the default
 * (`starchart` vs `afterdark`). Atlas left the roster at #480 but stayed in
 * every one of those hand-written copies, still costing a place in every
 * change to the token system. This module is now the one export each of
 * those reads, so a sixth theme, or the next one to retire, is a change in
 * one place.
 *
 * AFTER DARK IS THE DEFAULT (owner, 2026-09-06), named here once: a reader
 * with no stored preference, or one naming a theme that no longer exists —
 * atlas is the first case — lands on it, with nothing further to configure.
 *
 * app.html's own pre-paint script is the one reader that cannot import this:
 * it is deliberately synchronous and runs before first paint, so any import
 * would be the flash it exists to prevent. It keeps a literal copy of the
 * same two values instead, checked against this module by
 * tests/unit/v19-theme-roster.test.mjs, the same arrangement
 * tests/unit/v19-pack-contrast.test.mjs already has with packs.css: neither
 * file imports the other, a test parses both and asserts they agree.
 */

/** The v1.3.0 roster (§15, owner), in the order every swatch list shows it. */
export const THEME_PACKS = ["starchart", "afterdark", "clouds", "dawn", "retrograde"];

export const DEFAULT_THEME = "afterdark";

/**
 * A stored or requested theme id, made safe to apply: itself when it names a
 * pack on the current roster, the default otherwise — a removed pack (atlas),
 * a typo, or nothing at all.
 *
 * @param {string | null | undefined} id
 * @returns {string}
 */
export function themeOrDefault(id) {
  return typeof id === "string" && THEME_PACKS.includes(id) ? id : DEFAULT_THEME;
}
