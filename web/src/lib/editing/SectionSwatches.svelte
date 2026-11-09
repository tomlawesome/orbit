<script>
  /**
   * THE SECTION SWATCHES (#1466; round 6 N, n-colour-chosen.html `.swatches`):
   * the four section colours as dots in one row of a section's editor, the
   * checked one ringed. A radio group built as Tiles.svelte builds its own: one
   * swatch in the tab order (the checked one); left and right walk the four,
   * wrapping, up and down stay put (one row), Home and End the ends. Arrows
   * move focus only; Enter, Space or a press picks.
   *
   * `value` is the section's EFFECTIVE colour (option-colour.js
   * sectionColourOf), so an untouched section shows its mark's colour checked;
   * a pick stores it, even when it is the mark's own.
   *
   * 22px dots on the desk, 30px on the phone (N's `.phone .swatches`). The
   * size is the grid's track, not a rule on the button, and the phone's button
   * is 44px tall and its tap target 44px wide (an invisible margin round the 30px dot).
   *
   * @typedef {{
   *   name: string,
   *   value: string | null,
   *   onpick: (colour: string) => void,
   *   layout?: "desk" | "pocket",
   * }} Props
   */
  import { SECTION_COLOURS } from "$lib/option-colour.js";

  /** @type {Props} */
  let { name, value, onpick, layout = "desk" } = $props();

  /** The swatch in the tab order: the checked one, else the first; arrows and focus move it. */
  let active = $derived(Math.max(0, SECTION_COLOURS.findIndex((one) => one === value)));
  /** @type {HTMLSpanElement | undefined} */
  let group = $state();

  /** @param {KeyboardEvent} event @param {number} i */
  function walk(event, i) {
    const n = SECTION_COLOURS.length;
    const to = event.key === "Home" ? 0 : event.key === "End" ? n - 1
      : event.key === "ArrowLeft" ? (i - 1 + n) % n : event.key === "ArrowRight" ? (i + 1) % n : null;
    if (to === null) return;
    event.preventDefault();
    active = to;
    /** @type {HTMLButtonElement | undefined} */ (group?.querySelectorAll("[role=radio]")[to])?.focus({ preventScroll: true });
  }
</script>

<span class="swatches" class:pocket={layout === "pocket"} role="radiogroup" aria-label="Colour for {name.trim() || 'this section'}" bind:this={group}>
  {#each SECTION_COLOURS as colour, i (colour)}
    <button type="button" role="radio" data-opt={colour} aria-checked={colour === value} aria-label={colour}
            tabindex={i === active ? 0 : -1} onclick={() => onpick(colour)} onkeydown={(event) => walk(event, i)} onfocus={() => (active = i)}><i></i></button>
  {/each}
</span>

<style>
  /* N's rules: 22px dots, 8px apart, the checked one ringed in the ink with the page's colour inside it.
     The dot's size is the grid's track and its own square; the button round it keeps the 44px floor in
     height (--p-hit), pulled back into the 22px track by a negative margin on the desk so the row is N's. */
  .swatches{display:inline-grid;grid-template-columns:repeat(4,22px);grid-auto-rows:22px;gap:8px;align-items:center;justify-items:stretch}
  .swatches button{appearance:none;padding:0;margin:calc((22px - var(--p-hit)) / 2) 0;border:0;background:none;cursor:pointer;position:relative;display:grid;align-items:center;min-height:var(--p-hit)}
  .swatches i{display:block;box-sizing:border-box;width:100%;aspect-ratio:1;border-radius:50%;border:2px solid transparent;background:var(--opt)}
  .swatches button[aria-checked=true] i{border-color:var(--ink);box-shadow:0 0 0 2px var(--bg) inset}
  .swatches button:focus-visible{outline:none}
  .swatches button:focus-visible i{outline:2px solid var(--accent);outline-offset:2px}
  /* the phone: N's 30px dots (only the width), in 44px rows */
  .swatches.pocket{grid-template-columns:repeat(4,var(--p-hit));grid-auto-rows:var(--p-hit);gap:0;flex:none}
  /* the button is the 44 by 44 target; the dot is 30px, painted in the content box inside 7px of padding (44 - 2x7 = 30) */
  .swatches.pocket button{margin:0;box-sizing:border-box;width:var(--p-hit);height:var(--p-hit);padding:7px;display:block}
  .swatches.pocket button i{width:100%;height:100%}
</style>
