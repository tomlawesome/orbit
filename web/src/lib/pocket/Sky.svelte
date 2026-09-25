<script>
  import Grain from "$lib/Grain.svelte";
  import { TILED_LAYERS, TILED_SEED, seededRng } from "$lib/sky.js";

  /**
   * THE POCKET SKY (#1120, proposal §5.2 "Surfaces"): the desk's drifting
   * star field and vignette as a kit part, so no pocket screen arrives on a
   * flat colour. Glass needs something behind it to read as glass.
   *
   * A 400x850 tile (the phone's shape) of the desk's own two layers, counts
   * scaled to the tile (40 far, 20 near), seeded so every load and the
   * fidelity gate draw the same sky. Each layer drifts on the desk's period
   * (far 400s, near 195s) by transform only, over a copy of itself one tile
   * to the right, so the wrap is seamless. Opacity is the pack's --stars.
   *
   * Mount it first in a pocket screen's markup. `grain` is off: signed-in
   * pocket screens carry none, as on the desk (owner question 4, §5.5); if
   * the owner answers otherwise, it is this one prop.
   * @typedef {{ grain?: boolean }} Props
   */
  /** @type {Props} */
  let { grain = false } = $props();

  /**
   * @param {number} layer
   * @param {number} count
   * @param {() => number} rng
   */
  function stars(layer, count, rng) {
    const { rMin, rSpan, oMin, oSpan } = TILED_LAYERS[layer];
    return Array.from({ length: count }, () => ({
      cx: (rng() * 400).toFixed(1),
      cy: (rng() * 850).toFixed(1),
      r: (rMin + rng() * rSpan).toFixed(2),
      o: (oMin + rng() * oSpan).toFixed(2),
    }));
  }
  /* One rng, far then near: the call order is what keeps the seed stable. */
  const rng = seededRng(TILED_SEED);
  const far = stars(0, 40, rng);
  const near = stars(1, 20, rng);
</script>

<div class="p-sky" aria-hidden="true">
  <svg viewBox="0 0 400 850" preserveAspectRatio="xMidYMid slice">
    <g class="far" fill="var(--star-far, #e9edf8)">
      <g id="p-sky-far">{#each far as s, i (i)}<circle cx={s.cx} cy={s.cy} r={s.r} opacity={s.o} />{/each}</g>
      <use href="#p-sky-far" x="400" />
    </g>
    <g class="near" fill="var(--star-near, #f4f0ff)">
      <g id="p-sky-near">{#each near as s, i (i)}<circle cx={s.cx} cy={s.cy} r={s.r} opacity={s.o} />{/each}</g>
      <use href="#p-sky-near" x="400" />
    </g>
  </svg>
</div>
<div class="p-vignette" aria-hidden="true"></div>
{#if grain}<Grain />{/if}

<style>
  .p-sky{position:fixed;inset:-5%;z-index:0;pointer-events:none;opacity:var(--stars, 1)}
  .p-sky svg{position:absolute;inset:0;width:100%;height:100%}
  .far{animation:p-driftf 400s linear infinite}
  .near{animation:p-driftn 195s linear infinite}
  @keyframes p-driftf{to{transform:translateX(-400px)}}
  @keyframes p-driftn{to{transform:translateX(-400px)}}
  /* The desk's vignette, verbatim (home.css .desk .vignette). */
  .p-vignette{position:fixed;inset:0;z-index:1;pointer-events:none;
    background:radial-gradient(ellipse at 50% 34%, transparent 55%, rgba(0,0,0,.28) 100%)}

  /* The light packs, as the desk draws them (home.css): stars lifted to a
     readable speck with a stroke, and faded toward the ground where the day
     is arriving; no darkening vignette. */
  :global(:is([data-theme=dawn],[data-theme=clouds])) .p-vignette{display:none}
  :global(:is([data-theme=dawn],[data-theme=clouds])) .far circle{opacity:.5;stroke:var(--star-far);stroke-width:.7}
  :global(:is([data-theme=dawn],[data-theme=clouds])) .near circle{opacity:.8;stroke:var(--star-near);stroke-width:.7}
  :global([data-theme=dawn]) .p-sky{
    -webkit-mask-image:linear-gradient(180deg,#000 0%,rgba(0,0,0,.55) 50%,rgba(0,0,0,.12) 80%,transparent 100%);
            mask-image:linear-gradient(180deg,#000 0%,rgba(0,0,0,.55) 50%,rgba(0,0,0,.12) 80%,transparent 100%)}
  :global([data-theme=clouds]) .p-sky{
    -webkit-mask-image:linear-gradient(180deg,#000 0%,rgba(0,0,0,.52) 34%,rgba(0,0,0,.14) 54%,transparent 66%);
            mask-image:linear-gradient(180deg,#000 0%,rgba(0,0,0,.52) 34%,rgba(0,0,0,.14) 54%,transparent 66%)}

  @media (prefers-reduced-motion:reduce){ .far,.near{animation:none} }
</style>
