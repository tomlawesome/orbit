<script>
  import { onMount } from "svelte";
  import { mountFurnace, sideOf } from "./furnace.js";

  /**
   * THE DIAL'S SUN, as the layer over the dial (#1250, furnace.js). Laid over
   * the dial's own square, so 380 dial units are this layer's width: the sun's
   * picture sits at the centre, `sideOf(r)` units across. The still is the
   * picture's own background, chosen per pack by the stylesheet, so only the
   * pack showing is fetched; the live canvas covers it once it has drawn.
   * Purely a picture: the link, the name and the hit area stay in the dial.
   */
  let {
    /* the disc's radius in dial units */
    r,
  } = $props();

  /** @type {HTMLDivElement} */
  let box;
  /** @type {HTMLCanvasElement} */
  let canvas;

  onMount(() => mountFurnace(box, canvas));
</script>

<div class="sunlayer" aria-hidden="true">
  <div class="sunpic" bind:this={box} style:--sun-side={sideOf(r) / 380}>
    <canvas bind:this={canvas}></canvas>
  </div>
</div>

<style>
  .sunlayer{position:absolute;inset:0;pointer-events:none;transform-origin:50% 50%}
  .sunpic{position:absolute;left:calc(50% - var(--sun-side) * 50%);top:calc(50% - var(--sun-side) * 50%);
    width:calc(var(--sun-side) * 100%);aspect-ratio:1;
    background:url(/sun/furnace-starchart.webp) center/100% 100% no-repeat;transition:filter .3s}
  :global([data-theme=clouds]) .sunpic,:global([data-theme=dawn]) .sunpic{background-image:url(/sun/furnace-dawn.webp)}
  :global([data-theme=retrograde]) .sunpic{background-image:url(/sun/furnace-retrograde.webp)}
  canvas{display:none;width:100%;height:100%}
  .sunpic:global(.live){background:none}
  .sunpic:global(.live) canvas{display:block}
</style>
