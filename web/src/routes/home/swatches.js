/**
 * The theme swatch row shared between the desk account panel (`.account`,
 * +page.svelte) and the pocket account sheet (`.msheet`, pocket.svelte,
 * #852): the same five buttons, the same titles, the same click behaviour.
 *
 * Used to live entirely inside home.behaviour.js's `mountHome` closure. #852
 * needed the same wiring for the pocket dialect's sheet, and copying it would
 * have left two copies to keep in sync by hand, so it moved here instead —
 * both home.behaviour.js and pocket.behaviour.js import it now.
 */

/* title -> pack name: "star-chart" is starchart, "after dark" is afterdark. */
/** @type {(button: HTMLElement) => string} */
export const packOf = (button) => button.title.replace(/[\s-]/g, "");

/**
 * @param {string} name
 * @param {HTMLElement} button
 * @param {() => void} [onChange] - a caller-specific follow-up run after the
 *   theme and the pressed state are set. The desk uses it to re-measure the
 *   constellation labels, which size differently per pack; the pocket sheet
 *   has nothing else that needs telling, so it simply omits this.
 */
export function setSwatch(name, button, onChange) {
  document.documentElement.dataset.theme = name;
  for (const other of /** @type {HTMLElement} */ (button.parentElement).querySelectorAll("button"))
    other.setAttribute("aria-pressed", String(other === button));
  /* Survive a refresh. See the note in app.html: the server holds the real
     preference once the shell is wired; this is the pre-paint cache. */
  try { localStorage.setItem("orbit-theme", name); } catch {}
  onChange?.();
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
