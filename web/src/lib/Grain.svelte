<script>
  import { onMount } from "svelte";
  import { rasteriseSvg } from "$lib/raster.js";

  /**
   * POL-13's film grain, once (#445) — and now rasterised once too (#499).
   *
   * Four screens carried this block inline and had already drifted (slope
   * 0.08 vs 0.09), so the slope stays a prop that preserves each screen's
   * ratified value.
   *
   * Per-theme hooks (owner, 2026-08-15: grain colour and size must be able to
   * differ per pack): SVG filter attributes cannot read CSS custom properties,
   * so on mount the component still reads --grain-freq (size) and
   * --grain-slope (intensity) off the resolved pack if they are set. Unset,
   * everything renders exactly as before. Opacity and blend are pure CSS and
   * live on the shared .grain rule (--grain-opacity, --grain-blend), unchanged
   * by this file. Colour needs a ratified per-pack value before it gets a
   * hook — recorded on #445.
   *
   * #499, the GPU law (§15): the filter graph below — fractalNoise at a fixed
   * baseFrequency, stitched, desaturated, alpha-ramped, composited "in" over
   * an opaque rect — never animates. It is the SAME noise every frame. But it
   * used to be a LIVE <feTurbulence> filter sitting in the paint tree, and
   * WebKit rasterises SVG filters on the CPU on every repaint of the page —
   * measured ~35% of the residual login paint cost (#498's ledger) for a
   * texture that had not actually changed since the previous frame.
   *
   * The fix keeps the identical filter graph — same baseFrequency/slope,
   * same numOctaves, same stitchTiles, same saturate-0, same linear alpha
   * ramp, same "in" composite, same unset (so default-0) seed — but runs it
   * exactly ONCE per (frequency, slope, viewport size, DPR): rasterise that
   * exact SVG, at the exact CSS pixel dimensions this element occupies (so
   * the filter region and the stitch math see the same numbers a live filter
   * would have seen) and at devicePixelRatio-native resolution (so retina
   * stays crisp), into a canvas; hand the canvas's data URL to a plain
   * background-image on THIS element. From then on this element costs
   * nothing per repaint — it is an ordinary raster layer — and only rebuilds
   * on resize, debounced, same as every other "paint once, blit" surface in
   * this app (the item belt's haze canvas, POL-11's drift).
   *
   * feTurbulence is deterministic for a fixed seed (the default, 0 — never
   * set here, on either side) and a fixed region size, so the raster this
   * produces is byte-for-byte what the live filter would have painted at
   * that exact size. That is why the fidelity gate still reads the same 0 px
   * it always has: this is not an approximation of the grain, it is the same
   * grain, computed once instead of every frame.
   *
   * The decode/draw/cache mechanics live in $lib/raster.js (#501): this file
   * only builds the filter-graph SVG and the cache key, since #501 needed
   * the identical mechanism for the dawn/dusk glows and a second copy of the
   * canvas dance would have drifted from this one the way the grain drifted
   * across screens before #445.
   */
  let { slope = 0.08 } = $props();
  let host;

  /** The exact filter graph, verbatim, wrapped in an SVG sized so its own
      user-space matches the live element's CSS box (w × h) while its
      intrinsic raster matches the device pixel grid (w × h × dpr). */
  function svgFor(freq, slope, w, h, dpr) {
    const rw = Math.max(1, Math.round(w * dpr));
    const rh = Math.max(1, Math.round(h * dpr));
    return (
      `<svg xmlns="http://www.w3.org/2000/svg" width="${rw}" height="${rh}" viewBox="0 0 ${w} ${h}">` +
      `<filter id="gr">` +
      `<feTurbulence type="fractalNoise" baseFrequency="${freq}" numOctaves="2" stitchTiles="stitch"/>` +
      `<feColorMatrix type="saturate" values="0"/>` +
      `<feComponentTransfer><feFuncA type="linear" slope="${slope}"/></feComponentTransfer>` +
      `<feComposite operator="in" in2="SourceGraphic"/>` +
      `</filter><rect width="${w}" height="${h}" filter="url(#gr)"/></svg>`
    );
  }

  async function rasterise(freq, slope, w, h, dpr) {
    const rw = Math.max(1, Math.round(w * dpr));
    const rh = Math.max(1, Math.round(h * dpr));
    const key = `grain|${freq}|${slope}|${rw}|${rh}`;
    return rasteriseSvg(key, svgFor(freq, slope, w, h, dpr), rw, rh);
  }

  onMount(() => {
    const style = getComputedStyle(host);
    const freq = style.getPropertyValue("--grain-freq").trim() || "0.9";
    const packSlope = style.getPropertyValue("--grain-slope").trim();
    const effectiveSlope = packSlope || String(slope);

    let cancelled = false;
    let timer;

    async function build() {
      const { width, height } = host.getBoundingClientRect();
      if (!width || !height) return;
      /* Capped at 2, as the belt's haze canvas caps it: retina stays crisp
         without a 3x+ display doubling the raster for no visible gain. */
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const w = Math.round(width), h = Math.round(height);

      /* Marks this element for the fidelity gate (screens.spec.js), which
         waits for it before screenshotting so the async decode below can
         never race a capture. Mockups' own inline grain SVG carries no such
         attribute, so that wait is a no-op there. */
      host.dataset.rasterised = "pending";
      const url = await rasterise(freq, effectiveSlope, w, h, dpr);
      if (cancelled) return;

      /* Imperative, not a bound style: this and the readiness flag below
         must land in the same tick, with nothing async between them, so a
         poller can never observe "ready" before the background is actually
         painted. */
      host.style.backgroundImage = `url(${url})`;
      host.style.backgroundSize = "100% 100%";
      host.style.backgroundRepeat = "no-repeat";
      host.dataset.rasterised = "ready";
    }

    function onResize() {
      clearTimeout(timer);
      timer = setTimeout(build, 120);
    }

    build();
    window.addEventListener("resize", onResize);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      window.removeEventListener("resize", onResize);
    };
  });
</script>

<div class="grain" bind:this={host} aria-hidden="true"></div>
