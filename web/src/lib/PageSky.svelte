<script>
  import { onMount } from "svelte";
  import { fillStarTiles } from "$lib/sky.js";

  /**
   * The desk pages' backdrop (#1355, survey finding web-15): the tiled
   * starfield and the vignette over it, written once rather than on every
   * page. Each page still styles them in its own stylesheet (`.about-page
   * .sky`, `.mission-page .vignette` and so on), and the markup is the one
   * those rules already match, so nothing a page draws changes.
   *
   * `stars` false draws the vignette alone, for the pages whose sky is some
   * other backdrop (administration's station) or none (create, mail).
   * `fill` false leaves the tiles empty: household's pocket hides this sky
   * and does not build it (#1122).
   * @typedef {{ stars?: boolean, fill?: boolean }} Props
   */
  /** @type {Props} */
  let { stars = true, fill = true } = $props();

  /** @type {SVGGElement | undefined} */
  let far = $state();
  /** @type {SVGGElement | undefined} */
  let near = $state();

  onMount(() => {
    if (stars && fill && far && near) fillStarTiles(far, near);
  });
</script>

{#if stars}
<div class="sky" aria-hidden="true">
  <svg viewBox="0 0 1600 1000" preserveAspectRatio="xMidYMid slice">
    <g class="far" fill="var(--star-far)"><g id="fartile" bind:this={far}></g><use href="#fartile" x="1600"/></g>
    <g class="near" fill="var(--star-near)"><g id="neartile" bind:this={near}></g><use href="#neartile" x="1600"/></g>
  </svg>
</div>
{/if}
<div class="vignette" aria-hidden="true"></div>
