<script>
  import { fillStarTiles } from "$lib/sky.js";

  /**
   * The desk pages' backdrop (#1355, survey finding web-15; #1689): the tiled
   * starfield and the vignette over it, and the only place `.sky` and
   * `.vignette` are styled. They are this component's own scoped style, so a
   * route stylesheet never names them (route sheets outlive the route, #1050,
   * #1051). A page varies them through the props below and two custom
   * properties set on its wrapper: `--vignette-z` (default 1) and
   * `--vignette-gradient` (default: ellipse at 50% 34%, clear to 55%, .28
   * black at the edge). A backdrop a script builds (create, relay,
   * administration) pins its own sky layer with `pinSky` in `$lib/backdrops/pin.js`.
   *
   * `stars` false draws the vignette alone, for the pages whose sky is some
   * other backdrop (administration's station) or none (create, mail).
   * `fill` false leaves the tiles empty.
   * The phone draws its own sky, so both are hidden by CSS under the pocket
   * query (pocket/media.js), which the server page honours before any script
   * runs (#1727).
   * @typedef {{ stars?: boolean, fill?: boolean }} Props
   */
  /** @type {Props} */
  let { stars = true, fill = true } = $props();

  /** @type {SVGGElement | undefined} */
  let far = $state();
  /** @type {SVGGElement | undefined} */
  let near = $state();

  /* fills once the tiles are bound */
  $effect(() => {
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

<style>
  .sky{position:fixed;inset:0;pointer-events:none;opacity:var(--stars);
       transition:opacity .4s;z-index:0}
  .sky svg{position:absolute;inset:0;width:100%;height:100%}
  /* driftf and driftn are global, in $lib/atmosphere.css (#445) */
  .sky .far{animation:driftf 400s linear infinite}
  .sky .near{animation:driftn 195s linear infinite}
  .vignette{position:fixed;inset:0;pointer-events:none;z-index:var(--vignette-z,1);
            background:var(--vignette-gradient,radial-gradient(ellipse at 50% 34%, transparent 55%, rgba(0,0,0,.28) 100%))}
  /* the light packs have no edge to darken */
  :global([data-theme=clouds]) .vignette,:global([data-theme=dawn]) .vignette{background:none}
  /* the pocket query of $lib/pocket/media.js, written out as it asks */
  @media (max-width: 839.98px), (max-height: 479.98px){.sky,.vignette{display:none}}
  @media (prefers-reduced-motion: reduce){
    .sky .far,.sky .near{animation:none!important}
  }
</style>
