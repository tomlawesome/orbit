<script>
  /**
   * THE IMPORTANCE TILES (#1463; round 6 P, round 7 S): three tiles, each the
   * planet its level would draw, small to large, in the section's colour,
   * the word under it. The one control for the three levels: the Add form's
   * row (desk) and the edit drawer's chooser (desk and phone) both draw it,
   * on the chooser's own Tiles (a radio group, one tile in the tab order,
   * arrows walk, a press or Enter picks). Nothing is pressed until a level
   * is chosen, and "not set" is never a fourth tile.
   *
   * @typedef {{
   *   value: string | null,
   *   onpick: (value: string) => void,
   *   colour?: string | null,
   *   label?: string,
   *   required?: boolean,
   * }} Props
   */
  import Tiles from "./Tiles.svelte";
  import { IMPORTANCE_CHOICES } from "./importance.js";

  /** @type {Props} */
  let { value, onpick, colour = null, label = "Importance", required = false } = $props();
</script>

<div class="imp-tiles" data-opt={colour ?? undefined}>
  <Tiles choices={[...IMPORTANCE_CHOICES]} {value} {label} cols={3} {onpick} {required} />
</div>

<style>
  .imp-tiles :global(.tiles){margin-top:0}
  .imp-tiles :global(.tile){min-height:56px}
</style>
