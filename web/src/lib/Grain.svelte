<script>
  import { onMount } from "svelte";
  import { decodeSvg } from "$lib/raster.js";

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
   * stays crisp), onto the <canvas> inside this element. From then on this
   * element costs nothing per repaint — it is an ordinary raster layer — and
   * only rebuilds on resize, debounced, same as every other "paint once,
   * blit" surface in this app (the item belt's haze canvas, POL-11's drift).
   *
   * The canvas is shown as it is, not encoded (#797). This used to go on via
   * rasteriseSvg's PNG data URL to a background-image, and noise does not
   * compress: at 1440×900 on a retina screen that URL was 11 MB, and
   * building, parsing and decoding it froze the main thread for over two
   * seconds on every first load. The blit is the same 1:1 drawImage; only
   * the round trip is gone.
   *
   * The noise is generated as one TILE_PX-square tile and repeated (#798).
   * Generating it over the whole viewport was the largest single cost of
   * every first load — 450 ms in Chromium and 850 ms in WebKit at 1440×900
   * on a retina screen, on the main thread, before anything could move —
   * and feTurbulence's cost is simply its area. stitchTiles="stitch" fits a
   * whole number of noise periods into the tile (about 230 at the default
   * frequency), so the repeat is seamless, and grain this fine has no
   * feature the eye could catch coming round every 256 CSS px. The tile is
   * decoded once onto its own small canvas and repeated from there with a
   * canvas pattern: repeating the SVG image directly would re-run the filter
   * on every draw, and WebKit taints a canvas patterned from an SVG image.
   * Measured 34 ms Chromium / 62 ms WebKit for the same screen. The tile is
   * in CSS px, so retina still gets device-resolution noise.
   *
   * feTurbulence is deterministic for a fixed seed (the default, 0 — never
   * set here) and a fixed region size, so the tile is the same on every
   * load and every screen. The noise lattice is re-fitted to the tile, so
   * individual pixels differ from the full-viewport render, but by less
   * than the fidelity gate's colour threshold: every screen passed its
   * existing baseline and its mockup unchanged when the tile landed.
   *
   * The SVG decode lives in $lib/raster.js (#501): this file only builds the
   * filter-graph SVG, since #501 needed the identical mechanism for the
   * dawn/dusk glows and a second copy would have drifted from this one the
   * way the grain drifted across screens before #445.
   */
  let { slope = 0.08 } = $props();
  const TILE_PX = 256;
  /** @type {HTMLDivElement} */
  let host;
  /** @type {HTMLCanvasElement} */
  let canvas;

  /**
   * The exact filter graph, verbatim, wrapped in an SVG sized so its own
   * user-space matches the live element's CSS box (w × h) while its
   * intrinsic raster matches the device pixel grid (w × h × dpr).
   * @param {string} freq @param {string} slope
   * @param {number} w @param {number} h @param {number} dpr
   */
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

  onMount(() => {
    const style = getComputedStyle(host);
    const freq = style.getPropertyValue("--grain-freq").trim() || "0.9";
    const packSlope = style.getPropertyValue("--grain-slope").trim();
    const effectiveSlope = packSlope || String(slope);

    let cancelled = false;
    /** @type {ReturnType<typeof setTimeout>} */
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
      const img = await decodeSvg(svgFor(freq, effectiveSlope, TILE_PX, TILE_PX, dpr));
      if (cancelled) return;

      /* The draw and the readiness flag land in the same tick, with nothing
         async between them, so a poller can never observe "ready" before
         the grain is actually painted. The tile is blitted 1:1 onto its own
         canvas — the image's intrinsic size is the canvas's — and the
         pattern repeats it in device pixels, so every TILE_PX CSS px. */
      const tw = Math.max(1, Math.round(TILE_PX * dpr));
      const tile = document.createElement("canvas");
      tile.width = tw;
      tile.height = tw;
      /** @type {CanvasRenderingContext2D} */ (tile.getContext("2d")).drawImage(img, 0, 0, tw, tw);
      const rw = Math.max(1, Math.round(w * dpr));
      const rh = Math.max(1, Math.round(h * dpr));
      canvas.width = rw;
      canvas.height = rh;
      const ctx = /** @type {CanvasRenderingContext2D} */ (canvas.getContext("2d"));
      ctx.fillStyle = /** @type {CanvasPattern} */ (ctx.createPattern(tile, "repeat"));
      ctx.fillRect(0, 0, rw, rh);
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

<div class="grain" bind:this={host} aria-hidden="true"><canvas bind:this={canvas}></canvas></div>
