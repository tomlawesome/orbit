<script>
  import Grain from "$lib/Grain.svelte";
  import { onMount } from "svelte";
  import { page } from "$app/state";
  import { resolve } from "$app/paths";
  import { createSky, paintCopy, renewCopy } from "./gravity-well.js";
  import { rasteriseSvg } from "$lib/raster.js";

  /**
   * Not found — the gravity well (CON-14). The black hole *is* the 0, with the
   * two 4s caught in the well either side. Owner decision 2026-08-12: this is
   * the one served 404; design/family/404-conjunction.html and 404-uncharted.html
   * stay in the repo, unrouted — "you never know".
   *
   * Built from design/family/404-gravity.html and owned here from that point on.
   *
   * The stylesheets are linked from the head rather than imported. SvelteKit
   * ships the error boundary's CSS with *every* route, so a JS import here
   * would apply this screen's global body rules — including
   * `body{overflow:hidden}` — to the whole app, which is exactly what stopped
   * home scrolling.
   *
   * Only 404 has a drawn design. Any other status renders the bare fact rather
   * than borrowing this page's copy, which would tell the user something untrue
   * ("this page fell into a gravity well" for a failed request). Raised on #410.
   */
  const isNotFound = $derived(page.status === 404);

  /**
   * #764 step 2 — the same rasterise-once mechanism as Grain/Dawn/Dusk
   * (#499/#501, $lib/raster.js), applied to the one part of this screen's
   * filtered group that never moves.
   *
   * Checked first, per that precedent's own rule: what actually animates
   * inside the filtered <svg>. Six of notfound.css's nine keyframes do —
   * precess (the whole well rotates), dbreathe (.disc-glow), pflick/pflick2
   * (the photon rings), lens (the lensed arcs/arch), and smear (the near-side
   * disc and the tidal stream).
   *
   * Of what is left, only ONE element actually carries a live filter: the
   * inner "4"'s b6-blurred afterimage (feGaussianBlur, never animated). The
   * outer "4" and the inner "4"'s own crisp glyph are plain gradient-filled
   * text with no filter at all — the GPU law (#499's ledger) is about live
   * SVG *filters* forcing a software repaint, not about live SVG as such, so
   * rasterising them would spend a canvas decode removing a cost that was
   * never there, for two crisp text edges a raster is the harder thing to
   * match exactly (tried first: rasterising both glyphs together measured
   * pixel-identical in review but drifted the fidelity gate 0.28% on crisp
   * glyph edges — text hits a canvas/SVG antialiasing seam a blurred shape
   * does not, because blur is exactly what hides sub-pixel edge noise).
   * Rasterising only the blur keeps both crisp glyphs byte-identical to
   * before and still removes the one actual live filter from the paint
   * tree. The raster is built in frame coordinates (cropped to CROP_TEXT
   * below, #798), the same technique Dawn/Dusk use for a single shape, with
   * the glyph's own transform baked into the SVG string so the <image>
   * needs no transform of its own.
   */
  const F_B6 =
    '<filter id="b6" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="6"/></filter>';
  const STATIC_BODY =
    '<g transform="translate(1092 460) rotate(8) skewX(-14) scale(1.24,.9)">' +
    '<text x="0" y="52" text-anchor="middle" font-family="\'Space Grotesk\',sans-serif" ' +
    'font-weight="600" font-size="168" fill="#e8dcbc" opacity=".3" filter="url(#b6)" ' +
    'transform="scale(1.35,1)">4</text></g>';

  /**
   * #764 step 4 — measurement (the webkit-frames.mjs sampler, tests/perf/)
   * showed the six live animations themselves, not any leftover static
   * graph, are now the dominant WebKit repaint cost: freezing them cut mean
   * frame time on this screen by roughly 3×.
   *
   * The rule applied per animated, filtered element: a rotate/scale/move or
   * an opacity fade never changes what a filter computes — a filter's own
   * region and inputs are resolved in the element's local user space,
   * before any ancestor transform, and opacity is a compositing step that
   * happens after the filter chain — so that pair (transform-or-fade riding
   * a filter that never has to re-run) can be rasterised once, with the
   * class carrying the CSS animation moved onto the raster's own <image>,
   * exactly as #501 moved sway1/sway2 onto Dawn's rasterised ray fans.
   *
   * Applied to five of the six:
   *   - `.lensed` (2 elements: the generated lensarcs, the static arch) —
   *     opacity fade over a b1/b3-filtered shape. lensarcs is built by
   *     gravity-well.js's seeded RNG (same seed every load, so its output is
   *     as deterministic as anything hand-written) rather than duplicating
   *     that generator, its live output is captured ONCE via outerHTML —
   *     the literal markup gravity-well.js already produced — and rebuilt
   *     into a standalone SVG document for the raster. The live source
   *     stays in the DOM afterwards (display:none, not removed) so
   *     `#lensarcs path` — the gate's own settle condition and this file's
   *     animation test — still finds it.
   *   - `.photon` (2 circles, b6/b1) — merged into ONE raster, since both
   *     already ride the identical `pflick` timing and were always adjacent
   *     in paint order; Dawn's own "scatter" group merges its five rings
   *     the same way when they share one animation.
   *   - `.smear` (2 elements: the near-side disc under `.disc-precess`, b6;
   *     the tidal stream by the inner 4, b3) — kept as two separate rasters,
   *     not merged, because they sit in two different, non-adjacent places
   *     in paint order — the same reason Dawn never merges shapes that need
   *     independent stacking.
   *
   * `.disc-precess` itself is the sixth: it only rotates the whole well,
   * which is exactly the transform case above, but it wraps several of the
   * OTHER five (each now independently rastered, each keeping its own fade)
   * plus a few statics out of this step's scope (the haze ellipse, the
   * event horizon, the hotrough smear-path, one more b1 highlight — none of
   * them animated on their own, so #764 step 2 already left them live and
   * this step does not revisit them). Rasterising `.disc-precess` as one
   * more flat image would have baked those independent fades into a single
   * frozen picture, so instead its rotation stays exactly where it always
   * was, on the same live `<g>`, now wrapping a mix of the new rasters and
   * the remaining live shapes — a CSS transform on an ancestor doesn't care
   * whether its children are vectors or `<image>`s.
   *
   * `.disc-glow` and `.photon-hot` are the two that stay live and unrastered
   * for a different reason: neither carries a filter at all (disc-glow is a
   * plain gradient-filled circle; photon-hot is a plain stroked one), so
   * there is no software-rasterisation cost on them to remove — the same
   * "no filter, nothing to gain" call step 2 made for the two crisp "4"s.
   *
   * Nothing here changes a filter's own inputs — no dash-offset, no morph,
   * no animated blur radius — so nothing had to stay live for THAT reason.
   */
  const F_B1 =
    '<filter id="b1" filterUnits="userSpaceOnUse" x="300" y="80" width="1000" height="640">' +
    "<feGaussianBlur stdDeviation=\"1\"/></filter>";
  const F_B3 =
    '<filter id="b3" filterUnits="userSpaceOnUse" x="300" y="80" width="1000" height="640">' +
    "<feGaussianBlur stdDeviation=\"3\"/></filter>";
  const G_DOPPLER =
    '<linearGradient id="doppler" x1="0" y1="0" x2="1" y2="0">' +
    '<stop offset="0%" stop-color="#fff7e4"/><stop offset="28%" stop-color="#ffd489" stop-opacity=".9"/>' +
    '<stop offset="62%" stop-color="#e2772b" stop-opacity=".7"/><stop offset="100%" stop-color="#6e2a14" stop-opacity=".45"/>' +
    "</linearGradient>";
  const G_DOPPLER_SOFT =
    '<linearGradient id="doppler-soft" x1="0" y1="0" x2="1" y2="0">' +
    '<stop offset="0%" stop-color="#ffedc4" stop-opacity=".5"/><stop offset="55%" stop-color="#e2772b" stop-opacity=".22"/>' +
    '<stop offset="100%" stop-color="#5a2010" stop-opacity=".1"/></linearGradient>';
  const G_STREAMG =
    '<linearGradient id="streamg" x1="1" y1="0" x2="0" y2="0">' +
    '<stop offset="0%" stop-color="#ffd489" stop-opacity=".7"/><stop offset="100%" stop-color="#ffd489" stop-opacity="0"/>' +
    "</linearGradient>";

  /**
   * #798: each raster covers only the part of the frame its filter can
   * touch, not the whole 1600×1000. A filter paints nothing outside its
   * region, so a raster cropped to that region is the same pixels with the
   * rest of the frame — most of it — simply not rendered, not encoded and
   * not decoded. Rendering all six at full frame was the bulk of the first
   * load's hang, before any star fell.
   *
   * Boxes are in viewBox units, [x, y, width, height]. MID is b1/b3's own
   * pinned region (see the <defs>): lensarcs, the arch, the photon ring and
   * the tidal stream draw nothing outside it. The other two use b6, whose
   * region is relative to its user's bbox (−50%/200%), so their boxes are
   * drawn generously around that: the near-side disc's path spans
   * x452–1148 with a 62-unit-tall arc, the afterimage "4" sits around
   * 1092,460 at 168px scaled 1.35×1.24 wide. Both leave well over 100 units
   * of margin beyond where the blur has faded to nothing.
   */
  const CROP_MID = /** @type {const} */ ([300, 80, 1000, 640]);
  const CROP_NEAR = /** @type {const} */ ([60, 360, 1480, 260]);
  const CROP_TEXT = /** @type {const} */ ([780, 180, 640, 560]);

  /**
   * Snaps a crop box to the device-pixel grid at this scale, so the raster's
   * first pixel lands exactly on a frame pixel: the same grid the full-frame
   * raster used, just starting later. Returns the box in both units.
   * @param {readonly [number, number, number, number]} crop @param {number} scale
   */
  function frameOf(crop, scale) {
    const [x, y, w, h] = crop;
    const px = Math.floor(x * scale), py = Math.floor(y * scale);
    const pw = Math.ceil((x + w) * scale) - px, ph = Math.ceil((y + h) * scale) - py;
    return { pw, ph, x: px / scale, y: py / scale, w: pw / scale, h: ph / scale };
  }

  /**
   * Captures a live source element's CURRENT markup (verbatim, via
   * outerHTML — so the source's own tag, attributes and children all come
   * along, exactly as rendered) into a standalone, self-contained SVG
   * showing just its crop box, and hands back its raster together with the
   * box the <image> must occupy. Called before the source is hidden — never
   * after, or the capture would carry `display:none` into the document
   * being rasterised and decode to nothing.
   * @param {string} key @param {string} body @param {string} defs
   * @param {readonly [number, number, number, number]} crop @param {number} scale
   */
  async function rasteriseCrop(key, body, defs, crop, scale) {
    const f = frameOf(crop, scale);
    const svg =
      `<svg xmlns="http://www.w3.org/2000/svg" width="${f.pw}" height="${f.ph}" viewBox="${f.x} ${f.y} ${f.w} ${f.h}">` +
      `<defs>${defs}</defs>${body}</svg>`;
    return { url: await rasteriseSvg(key, svg, f.pw, f.ph), f };
  }

  /**
   * Lands a finished raster: the <image> takes the crop box and the URL,
   * and its live source is hidden — never removed, so `#lensarcs path` (the
   * gate's settle condition, and this file's own animation test) keeps
   * finding what gravity-well.js drew.
   * @param {SVGImageElement | null} img @param {SVGElement | null} src
   * @param {{ url: string, f: ReturnType<typeof frameOf> }} r
   */
  function land(img, src, { url, f }) {
    img?.setAttribute("x", String(f.x));
    img?.setAttribute("y", String(f.y));
    img?.setAttribute("width", String(f.w));
    img?.setAttribute("height", String(f.h));
    img?.setAttribute("href", url);
    if (src) src.style.display = "none";
  }

  /** A frame's rest between rasters, so each one is its own short task. */
  const breathe = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));

  /** @type {HTMLDivElement | null} */
  let world;
  /** @type {SVGImageElement | null} */
  let imgStatic;
  /** @type {SVGGElement | null} */
  let srcLensarcs;
  /** @type {SVGImageElement | null} */
  let imgLensarcs;
  /** @type {SVGGElement | null} */
  let srcLensedArch;
  /** @type {SVGImageElement | null} */
  let imgLensedArch;
  /** @type {SVGGElement | null} */
  let srcPhoton;
  /** @type {SVGImageElement | null} */
  let imgPhoton;
  /** @type {SVGGElement | null} */
  let srcSmearNear;
  /** @type {SVGImageElement | null} */
  let imgSmearNear;
  /** @type {SVGGElement | null} */
  let srcSmearTidal;
  /** @type {SVGImageElement | null} */
  let imgSmearTidal;

  /** #790: the falling star bands' host, see the markup. @type {HTMLDivElement | null} */
  let infall;

  /**
   * #790: the sky, seeded here — on the server too — so the HTML arrives
   * with the stars already in it (the `.first` <svg> in the markup) and the
   * canvases, painted at mount from the very same seed, take over without
   * moving a star. Copies 1 and 2 are the ones a fresh cycle shows; copy 0
   * opens at opacity 0 and fades in from beyond the frame.
   */
  const sky = createSky();
  const FIRST = /** @type {const} */ ([[1, 1], [2, 0.5]]);
  /* False until every copy is painted: the still sky shows, the canvases
     are hidden and not yet animating (notfound.css). Flipping it swaps the
     two in one step, so the handover moves nothing. */
  let live = $state(false);

  onMount(() => {
    if (!isNotFound) return;
    /* Populates #lensarcs synchronously, before the first build() below
       ever reads it. */
    sky.mountArcs();

    let cancelled = false;
    /** @type {ReturnType<typeof setTimeout> | undefined} */
    let timer;

    /* The canvases, painted one per task behind the still sky (#798: six at
       once was the first thing a visitor waited on) at the density the
       screen shows it (2200 units at this scale, capped at 2k a side: six
       canvases at 16 MB each, and a sub-pixel star does not get crisper for
       being sampled finer). Copies 1 and 2 — the ones the still sky shows —
       go first; copy 0 opens at opacity 0 and has seconds before it is seen.
       Each copy takes fresh stars every time it wraps unseen, so no pattern
       ever comes round again (gravity-well.js, renewCopy). */
    let side = 0;
    async function paint() {
      if (!infall) return;
      const rect = infall.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      side = Math.min(2048, Math.max(1, Math.round(2200 * Math.max(rect.width / 1600, rect.height / 1000) * dpr)));
      const copies = /** @type {HTMLCanvasElement[]} */ ([...infall.querySelectorAll("canvas.fall")]);
      copies.sort((a, b) => Number(a.style.getPropertyValue("--i") === "0") - Number(b.style.getPropertyValue("--i") === "0"));
      for (const c of copies) {
        paintCopy(c, sky, side);
        await breathe();
        if (cancelled) return;
      }
      live = true;
    }
    /** @param {AnimationEvent} e */
    function onWrap(e) {
      if (e.animationName === "infall" && e.target instanceof HTMLCanvasElement) renewCopy(e.target, sky, side);
    }
    infall?.addEventListener("animationiteration", onWrap);
    /* A resize during the six-frame build starts a new one; the older
       build must then stop landing rasters at the old scale between the
       new one's. Each build takes a number and yields when it is stale. */
    let generation = 0;

    async function build() {
      const mine = ++generation;
      const stale = () => cancelled || mine !== generation;
      if (!world || !srcLensarcs || !srcLensedArch || !srcPhoton || !srcSmearNear || !srcSmearTidal) return;
      const rect = world.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      /* Unlike Grain/Dawn/Dusk, this raster's body is set text (the two
         "4"s), so its shape depends on Space Grotesk having actually
         loaded — the SVG-to-<img> decode below rasterises with whatever
         font is available at that moment and, unlike a live DOM element,
         never re-renders once the webfont swaps in. Wait for it explicitly
         rather than race it, the same wait the fidelity gate itself takes
         before screenshotting this page (screens.spec.js). */
      await document.fonts.ready;
      if (stale()) return;
      /* Capped at 2, as Grain/Dawn/Dusk cap it: retina stays crisp without a
         3x+ display doubling the raster for no visible gain. */
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const scale = Math.max(rect.width / 1600, rect.height / 1000) * dpr;
      const k = `|${Math.round(1600 * scale)}|${Math.round(1000 * scale)}`;

      /* Marks this surface for the fidelity gate (screens.spec.js), which
         waits for `.world[data-rasterised]` before screenshotting so the
         async decodes below can never race a capture. */
      world.dataset.rasterised = "pending";
      /* Un-hide every source before capturing. On the first build this is a
         no-op (nothing has been hidden yet); on a resize-triggered rebuild
         each source is already display:none from the previous pass, and
         outerHTML would otherwise carry that into the new raster's own
         document and decode to nothing. */
      srcLensarcs.style.display = "";
      srcLensedArch.style.display = "";
      srcPhoton.style.display = "";
      srcSmearNear.style.display = "";
      srcSmearTidal.style.display = "";

      /* One raster per frame, not all six in one task (#798): each is
         rendered, encoded and landed on its own, with a frame's rest before
         the next, so the page keeps painting through the build instead of
         hanging until the last one is done. Landing each as it arrives
         also retires its live filter that much sooner. */
      const jobs = /** @type {const} */ ([
        [imgStatic, null, `notfound-static${k}`, STATIC_BODY, F_B6, CROP_TEXT],
        [imgLensarcs, srcLensarcs, `notfound-lensarcs${k}`, srcLensarcs.outerHTML, F_B1, CROP_MID],
        [imgLensedArch, srcLensedArch, `notfound-lensed-arch${k}`, srcLensedArch.outerHTML, F_B1 + F_B3 + G_DOPPLER, CROP_MID],
        [imgPhoton, srcPhoton, `notfound-photon${k}`, srcPhoton.outerHTML, F_B6 + F_B1, CROP_MID],
        [imgSmearNear, srcSmearNear, `notfound-smear-near${k}`, srcSmearNear.outerHTML, F_B6 + G_DOPPLER_SOFT, CROP_NEAR],
        [imgSmearTidal, srcSmearTidal, `notfound-smear-tidal${k}`, srcSmearTidal.outerHTML, F_B3 + G_STREAMG, CROP_MID],
      ]);
      for (const [img, src, key, body, defs, crop] of jobs) {
        const r = await rasteriseCrop(key, body, defs, crop, scale);
        if (stale()) return;
        land(img, src, r);
        await breathe();
        if (stale()) return;
      }
      world.dataset.rasterised = "ready";
    }

    function onResize() {
      clearTimeout(timer);
      timer = setTimeout(() => { paint(); build(); }, 120);
    }

    /* Sky first, then the well: the stars are what the still frame shows
       moving soonest, and the rasters only retire filters that already
       paint. The well is marked pending now, though, not when its turn
       comes: the fidelity gate (and notfound-motion.spec.js) waits on
       `.world[data-rasterised]`, and an element it cannot see yet is one it
       will not wait for. */
    if (world) world.dataset.rasterised = "pending";
    paint().then(build);
    window.addEventListener("resize", onResize);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      window.removeEventListener("resize", onResize);
      infall?.removeEventListener("animationiteration", onWrap);
    };
  });
</script>

<svelte:head>
  <link rel="stylesheet" href="/screens/family.css" />
  <link rel="stylesheet" href="/screens/notfound.css" />
  <title>{isNotFound ? "Orbit — off the chart" : `Orbit — ${page.status}`}</title>
</svelte:head>

{#if isNotFound}
<!--
  The sky falls in (#790, owner's pick: the spiral). Each star layer is one
  band of stars that starts beyond the frame, painted onto three <canvas>
  copies (gravity-well.js, paintCopy), each turned a third of a turn and each
  with its own stars. They spiral in toward the hole a third of a cycle apart
  and hand over to each other (notfound.css, .fall), so the field never
  empties, nothing spawns in view, and the horizon's own black disc swallows
  what is left; a copy takes fresh stars each time it wraps, unseen, so it
  never reads as a loop.

  Canvases, not groups in the sky <svg>, because of what the first cut did to
  a laptop: Safari gives a scaled SVG group a bitmap the size of its whole
  extent and redraws it as the scale changes, and six bands at twice the
  frame is gigabytes. A canvas is composited straight from its own pixels,
  whatever transform it wears — and unlike a rasterised <img> it costs no PNG
  encode and decode, which took whole seconds of blank sky. Nothing here is
  filtered, so #764's rule holds: nothing filtered gains motion.

  A canvas is blank until the script runs, and that is a few hundred
  milliseconds of empty sky before the stars pop in. So the server draws the
  same stars first, as one still <svg> in the HTML (static groups only —
  nothing scaled by CSS, which is the Safari trap above): on screen with the
  first paint, and replaced once all six canvases are painted — hidden and
  unmoving until then (notfound.css) — by the same stars in the same places.
-->
<div class="infall" class:live aria-hidden="true" bind:this={infall}>
  {#if !live}
  <svg class="first" viewBox="-1100 -1100 2200 2200">
    <defs>
      <radialGradient id="stargl" cx="50%" cy="50%" r="50%">
        <stop offset="0%" stop-color="#e8edff" stop-opacity=".45"/>
        <stop offset="100%" stop-color="#e8edff" stop-opacity="0"/>
      </radialGradient>
    </defs>
    {#each FIRST as [i, s]}
      <g transform="scale({s})" fill="#dbe2f5">
        {#each sky.first.far[i] as st}<circle cx={st.x.toFixed(1)} cy={st.y.toFixed(1)} r={st.r.toFixed(2)} opacity={st.o.toFixed(2)}/>{/each}
      </g>
    {/each}
    {#each FIRST as [i, s]}
      <g transform="scale({s})" fill="#e8edff">
        {#each sky.first.near[i] as st}<circle cx={st.x.toFixed(1)} cy={st.y.toFixed(1)} r={(st.r * 3.6).toFixed(1)} fill="url(#stargl)"/><circle cx={st.x.toFixed(1)} cy={st.y.toFixed(1)} r={st.r.toFixed(2)} opacity={st.o.toFixed(2)}/>{/each}
      </g>
    {/each}
  </svg>
  {/if}
  <canvas class="fall fall-far" style="--i:0;--s0:2"></canvas>
  <canvas class="fall fall-far" style="--i:1;--s0:1"></canvas>
  <canvas class="fall fall-far" style="--i:2;--s0:.5"></canvas>
  <canvas class="fall fall-near" style="--i:0;--s0:2"></canvas>
  <canvas class="fall fall-near" style="--i:1;--s0:1"></canvas>
  <canvas class="fall fall-near" style="--i:2;--s0:.5"></canvas>
</div>

<div class="world" style="position:fixed;inset:0;z-index:1" bind:this={world}><svg viewBox="0 0 1600 1000" preserveAspectRatio="xMidYMid slice" style="width:100%;height:100%">
  <defs>
    <!-- doppler: the approaching side of the disc burns white, the receding side dims -->
    <linearGradient id="doppler" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0%" stop-color="#fff7e4"/>
      <stop offset="28%" stop-color="#ffd489" stop-opacity=".9"/>
      <stop offset="62%" stop-color="#e2772b" stop-opacity=".7"/>
      <stop offset="100%" stop-color="#6e2a14" stop-opacity=".45"/>
    </linearGradient>
    <linearGradient id="doppler-soft" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0%" stop-color="#ffedc4" stop-opacity=".5"/>
      <stop offset="55%" stop-color="#e2772b" stop-opacity=".22"/>
      <stop offset="100%" stop-color="#5a2010" stop-opacity=".1"/>
    </linearGradient>
    <radialGradient id="wellglow" cx="50%" cy="50%" r="50%">
      <stop offset="30%" stop-color="#f0a35a" stop-opacity=".16"/>
      <stop offset="65%" stop-color="#c25a24" stop-opacity=".07"/>
      <stop offset="100%" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="streamg" x1="1" y1="0" x2="0" y2="0">
      <stop offset="0%" stop-color="#ffd489" stop-opacity=".7"/>
      <stop offset="100%" stop-color="#ffd489" stop-opacity="0"/>
    </linearGradient>
    <linearGradient id="glyphg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#f2ecdd"/>
      <stop offset="100%" stop-color="#b8ac8e"/>
    </linearGradient>
    <!-- #764: b1/b3 declared no region at all (default -10% -10% 120% 120% of
         each user's OWN bbox), exactly #498's first finding. Pinned to one
         shared absolute (userSpaceOnUse) region that comfortably contains
         every use of each filter — the disc-precess arcs/circles at their
         raw viewBox coordinates (roughly x:650-1130, y:260-640) and the
         inner-4 group's paths, whose local (pre-transform) coordinates also
         happen to fall in that same numeric range. b16 has a single user
         (the haze ellipse, bbox x:370-1230 y:356-548) so its region is
         pinned tightly around that shape instead. b6 is used by three
         elements in TWO different local coordinate spaces (disc-precess vs.
         the inner-4 group's transform), so one shared absolute box would
         have to be as large as the percentage default to stay safe for all
         three — left alone as already reasonable. -->
    <filter id="b1" filterUnits="userSpaceOnUse" x="300" y="80" width="1000" height="640"><feGaussianBlur stdDeviation="1"/></filter>
    <filter id="b3" filterUnits="userSpaceOnUse" x="300" y="80" width="1000" height="640"><feGaussianBlur stdDeviation="3"/></filter>
    <filter id="b6" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="6"/></filter>
    <filter id="b16" filterUnits="userSpaceOnUse" x="300" y="280" width="1000" height="300"><feGaussianBlur stdDeviation="16"/></filter>
    <filter id="hotrough" x="-30%" y="-30%" width="160%" height="160%">
      <feTurbulence type="fractalNoise" baseFrequency="0.02 0.09" numOctaves="2" seed="6" result="n"/>
      <feDisplacementMap in="SourceGraphic" in2="n" scale="10"/>
      <feGaussianBlur stdDeviation="1.6"/>
    </filter>
  </defs>

  <!-- ambient warmth of the well -->
  <circle class="disc-glow" cx="800" cy="450" r="520" fill="url(#wellglow)"/>

  <g class="disc-precess">
    <!-- lensed starlight: stars behind the hole smeared into tangential arcs.
         #764 step 4: `#lensarcs` stays exactly as gravity-well.js built it —
         nothing here duplicates its seeded generator — but once its raster
         (below) is ready it is hidden (display:none), not removed, so
         `#lensarcs path` still finds what was drawn. -->
    <g id="lensarcs" class="lensed" fill="none" bind:this={srcLensarcs}></g>
    <image bind:this={imgLensarcs} x="0" y="0" width="1600" height="1000" preserveAspectRatio="none" class="lensed"/>

    <!-- the far side of the disc, lensed into an arch OVER the hole (and a
         fainter one under). #764 step 4: rasterised once, same reasoning. -->
    <g class="lensed" bind:this={srcLensedArch}>
      <path d="M 649 460 A 152 152 0 1 1 951 460" fill="none" stroke="url(#doppler)"
            stroke-width="17" stroke-linecap="round" filter="url(#b3)" opacity=".9"/>
      <path d="M 655 452 A 150 150 0 1 1 945 452" fill="none" stroke="#fff3d6"
            stroke-width="4" stroke-linecap="round" filter="url(#b1)" opacity=".75"/>
      <path d="M 668 508 A 140 140 0 0 0 932 508" fill="none" stroke="url(#doppler)"
            stroke-width="9" stroke-linecap="round" filter="url(#b3)" opacity=".5"/>
    </g>
    <image bind:this={imgLensedArch} x="0" y="0" width="1600" height="1000" preserveAspectRatio="none" class="lensed"/>

    <!-- disc haze behind everything: static, unanimated, out of this step's
         scope (#764 step 2 already left it live). -->
    <ellipse cx="800" cy="452" rx="430" ry="96" fill="url(#doppler-soft)" filter="url(#b16)" opacity=".6"/>

    <!-- event horizon: no filter, unanimated — unchanged. -->
    <circle cx="800" cy="450" r="112" fill="#000000"/>

    <!-- photon ring: two circles, one `pflick` animation between them —
         #764 step 4: merged into ONE raster, since they already shared a
         timing and a place in paint order (Dawn's "scatter" group merges
         its five static rings the same way). -->
    <g bind:this={srcPhoton}>
      <circle class="photon" cx="800" cy="450" r="119" fill="none" stroke="#ff9a4a" stroke-width="7" opacity=".4" filter="url(#b6)"/>
      <circle class="photon" cx="800" cy="450" r="118" fill="none" stroke="#ffce8a" stroke-width="2.6" filter="url(#b1)"/>
    </g>
    <image bind:this={imgPhoton} x="0" y="0" width="1600" height="1000" preserveAspectRatio="none" class="photon"/>
    <!-- photon-hot: no filter — stays live, same reason as disc-glow. -->
    <circle class="photon-hot" cx="800" cy="450" r="117" fill="none" stroke="#fffaf0" stroke-width="1.1"/>

    <!-- the near side of the disc, crossing IN FRONT below the hole. #764
         step 4: rasterised once — kept as its OWN raster, not merged with
         the tidal-stream `.smear` below, since the two sit in different,
         non-adjacent places in paint order. -->
    <g class="smear" bind:this={srcSmearNear}>
      <path d="M 452 452 A 348 62 0 0 0 1148 452" fill="none" stroke="url(#doppler-soft)"
            stroke-width="34" filter="url(#b6)"/>
    </g>
    <image bind:this={imgSmearNear} x="0" y="0" width="1600" height="1000" preserveAspectRatio="none" class="smear"/>
    <path d="M 452 452 A 348 62 0 0 0 1148 452" fill="none" stroke="url(#doppler)"
          stroke-width="13" filter="url(#hotrough)"/>
    <path d="M 470 458 A 346 58 0 0 0 1130 458" fill="none" stroke="#fff3d6"
          stroke-width="2.6" filter="url(#b1)" opacity=".8"/>
  </g>

  <!-- the outer 4: caught, but still itself. Plain gradient fill, no
       filter — stays live, byte-identical to before. -->
  <text x="505" y="512" text-anchor="middle" font-family="'Space Grotesk',sans-serif"
        font-weight="600" font-size="168" fill="url(#glyphg)"
        transform="rotate(-5 505 460)">4</text>

  <!-- the inner 4's b6-blurred afterimage: the one filtered, static, never-
       animated element left in the graph — rasterised once (#764 step 2,
       see the script block) in place of the live text it replaces. Same
       position in paint order: after the outer 4, before the inner 4's own
       crisp glyph. -->
  <image bind:this={imgStatic} x="0" y="0" width="1600" height="1000" preserveAspectRatio="none"/>

  <!-- the inner 4: mid-spaghettification, shearing toward the horizon -->
  <g>
    <!-- the glyph itself, stretched and tilted into the fall. Plain
         gradient fill, no filter — stays live, byte-identical to before. -->
    <g transform="translate(1092 460) rotate(8) skewX(-14) scale(1.24,.9)">
      <text x="0" y="52" text-anchor="middle" font-family="'Space Grotesk',sans-serif"
            font-weight="600" font-size="168" fill="url(#glyphg)">4</text>
    </g>
    <!-- the tidal stream: its substance drawn off into the photon ring.
         #764 step 4: rasterised once, kept as its own raster (see the
         near-side disc above for why it isn't merged with that one). -->
    <g bind:this={srcSmearTidal}>
      <path class="smear" d="M 1030 448 C 985 442, 950 442, 916 446 L 916 470 C 950 468, 985 470, 1030 480 Z"
            fill="url(#streamg)" filter="url(#b3)"/>
    </g>
    <image bind:this={imgSmearTidal} x="0" y="0" width="1600" height="1000" preserveAspectRatio="none" class="smear"/>
    <path d="M 1026 456 C 978 450, 946 452, 918 456" fill="none" stroke="#ffe9bd"
          stroke-width="1.4" opacity=".55" filter="url(#b1)"/>
  </g>

  <!-- debris: fragments of the lost page spiralling in, stretching as they go -->
  <g fill="#cdd6ee" font-family="'JetBrains Mono',monospace" font-size="15">
    <g opacity=".8">
      <animateMotion dur="13s" repeatCount="indefinite" rotate="auto"
        path="M 1420 170 C 1180 210, 1010 280, 940 360 C 900 406, 872 430, 850 442"/>
      <animateTransform attributeName="transform" type="scale" additive="sum"
        values="1 1;1 1;2.4 .5;3.6 .25" keyTimes="0;.72;.94;1" dur="13s" repeatCount="indefinite"/>
      <animate attributeName="opacity" values=".8;.8;.7;0" keyTimes="0;.8;.96;1" dur="13s" repeatCount="indefinite"/>
      <text>/</text>
    </g>
    <g opacity=".7">
      <animateMotion dur="17s" begin="-6s" repeatCount="indefinite" rotate="auto"
        path="M 150 780 C 380 740, 560 660, 660 560 C 716 506, 748 478, 766 464"/>
      <animateTransform attributeName="transform" type="scale" additive="sum"
        values="1 1;1 1;2.6 .45;3.8 .2" keyTimes="0;.74;.94;1" dur="17s" repeatCount="indefinite"/>
      <animate attributeName="opacity" values=".7;.7;.6;0" keyTimes="0;.8;.96;1" dur="17s" repeatCount="indefinite"/>
      <text>~</text>
    </g>
    <g opacity=".6">
      <animateMotion dur="21s" begin="-13s" repeatCount="indefinite" rotate="auto"
        path="M 1500 820 C 1260 800, 1060 720, 960 610 C 906 550, 872 500, 852 470"/>
      <animateTransform attributeName="transform" type="scale" additive="sum"
        values="1 1;1 1;2.2 .5;3.4 .25" keyTimes="0;.75;.95;1" dur="21s" repeatCount="indefinite"/>
      <animate attributeName="opacity" values=".6;.6;.5;0" keyTimes="0;.82;.97;1" dur="21s" repeatCount="indefinite"/>
      <text>.html</text>
    </g>
  </g>
</svg></div>

<div class="line-a">This page fell into a gravity well.</div>
<div class="line-b"><a href={resolve("/")}>plot a course home &rarr;</a></div>

<Grain slope={0.09} />

<div class="vignette" style="background:radial-gradient(ellipse at 50% 45%,transparent 42%,rgba(0,0,0,.5) 100%)"></div>
{:else}
  <div class="stage">
    <div class="lockup">
      <div class="name mono">{page.status}</div>
      <p><a href={resolve("/")}>return home</a></p>
    </div>
  </div>
{/if}
