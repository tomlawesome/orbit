<script>
  import { onMount } from "svelte";
  import { DAWN_FAR, DAWN_NEAR } from "./starfields.js";
  import { rasteriseSvg } from "$lib/raster.js";

  /**
   * THE DAWN — the sky the launch leaves from, and the sign-in's own surface.
   * Markup verbatim from design/v19/first-run.html (which carries
   * design/family/login.html's world across): the skywash, the zodiacal cone,
   * the two swaying fans of crepuscular rays, the scattering rings hugging the
   * limb, the point of first light, and the night side below it.
   *
   * THE SKY is that sheet's, unchanged. THE CHROME on top of it is the
   * 2026-08-14 login, not the sheet's — the sheet reproduced
   * design/family/login.html's older v18 lockup, pill and ribbon, and the
   * owner struck that on 2026-08-17: "the flight's login screen uses THE MOST
   * RECENT APPROVED LOGIN... there shouldnt be a footer". Both sheet and app
   * were fixed together; see flight.css for the ruling in full.
   *
   * The canvas flight is drawn to this exact geometry at atm = 0 — limb top on
   * y = 920 of a 1600×1000 slice, radius 3000, sunrise at (800, 920) — so the
   * handoff from this DOM into the canvas has nothing to give it away.
   *
   * The ARTWORK is aria-hidden, not the whole surface: the mockup marks the
   * entire #dawn hidden because on that sheet it is scenery, but here the
   * lockup and the gate ARE the sign-in. Hiding them would leave a screen
   * reader on a page with nothing on it, and no way in.
   *
   * `children` is the ask: the sign-in renders its gate into it, and the
   * launch overlay on the landing renders nothing at all — the same dawn,
   * with no button on it, because by then the button has been pressed.
   *
   * #501: the seven feGaussianBlur glows #498 pinned to a userSpaceOnUse
   * region were still LIVE filters — Safari software-rasterises them on
   * every repaint even though every one of these shapes is static (never
   * changes) frame to frame. Per the GPU law and the grain precedent
   * (Grain.svelte, #499), each is rasterised once, offscreen, at load, using
   * the identical filter graph, and composited back as a plain <image> —
   * $lib/raster.js does the decode/draw/cache mechanics Grain.svelte also
   * uses, so the technique is shared, not duplicated a third time.
   *
   * Checked first, per the owner's own condition on this fix: what actually
   * ANIMATES here. `.rays` rotates (sway1/sway2, a transform) and — until
   * #502 — kept its own live "rayrough" filter on the theory that genuine
   * shape motion needed a live filter to ride. Measured instead of assumed
   * (#498's parked plan, owner ruling 2026-08-17): profiling the login on
   * WebKit with animations running and toggling suspects one at a time found
   * that filter alone responsible for ~47% of the screenshot-forced paint
   * cost — by far the largest remaining lever, because a CSS `transform`
   * does not require the filter under it to be recomputed. Rotation is
   * rigid: every pixel of the swaying fan keeps the same relationship to
   * every other pixel, so a raster of the filtered shape rotated by CSS is
   * the identical picture a live filter recomputing the turbulence and
   * displacement on the rotated geometry would have produced, and the
   * rotation itself is then a GPU compositing operation instead of a
   * software re-rasterisation. So sway1 and sway2 are rasterised once each
   * (kept separate, not merged, so each keeps its own rotation period) and
   * the `sway1`/`sway2` classes move from the live filtered <g> onto the
   * resulting <image> — same transform-origin, same keyframes, same
   * rotation, now riding a picture instead of recomputing one.
   *
   * Everything else that moves — .zodiacal, .scatter, .sunpt-breathe, .rim's
   * fade-in — animates opacity only, via CSS on an ancestor or the element
   * itself, and opacity composites over a static raster exactly as it would
   * over a live filter: nothing here needed to stay live to keep breathing.
   * The profile agrees: toggling the starfield's drift/twinkle or these
   * breathing layers moved the paint cost by ~2% or less, inside the run's
   * own noise floor, because none of them sit under a filter or a blend that
   * their motion would force to re-evaluate.
   *
   * Seven raster targets, one per contiguous group of filtered elements (kept
   * separate, not merged, precisely so each keeps its own opacity animation,
   * its own rotation and its own place in paint order): the zodiacal cone
   * (b20l), the five limb scattering rings (b20l/b12l/b6l/b2l), the sun's
   * soft white core (b6l), the scattering arc over the limb (b2l), the
   * blurred half of the rim (b6l), and — since #502 — the two swaying fans of
   * crepuscular rays (rayrough). Each raster is built at the FULL 1600×1000
   * viewBox frame (not cropped to the filter's own region) at
   * devicePixelRatio-native resolution, exactly as Grain.svelte rasterises
   * its own full-surface frame — so it drops into the SAME
   * <svg viewBox="0 0 1600 1000"> that already carries the live shapes, at
   * the same x/y/width/height (0,0,1600,1000) as an <image>, and the outer
   * svg's own slice transform scales it exactly once, the same as it always
   * scaled the vector shapes it replaces.
   *
   * Unlike Grain (which starts blank until its raster lands), there is no
   * kept live fallback here: the decode of a same-document data URI resolves
   * in the same frame in practice, and the fidelity gate's data-rasterised
   * wait (screens.spec.js) means a capture can never race the async build
   * regardless. That is the "replace synchronously" call #501 leaves to the
   * implementer, taken because a live-filter fallback would have reproduced
   * the exact cost this fix exists to remove, for however briefly it hung
   * around.
   */
  let { children = undefined, shown = false } = $props();
  let world;
  let imgZod, imgScatter, imgSunpt, imgSunarc, imgRim, imgSway1, imgSway2;

  const F_B2L =
    '<filter id="b2l" filterUnits="userSpaceOnUse" x="-20" y="-20" width="1640" height="1040"><feGaussianBlur stdDeviation="2"/></filter>';
  const F_B6L =
    '<filter id="b6l" filterUnits="userSpaceOnUse" x="-40" y="-40" width="1680" height="1080"><feGaussianBlur stdDeviation="6"/></filter>';
  const F_B12L =
    '<filter id="b12l" filterUnits="userSpaceOnUse" x="-60" y="-60" width="1720" height="1120"><feGaussianBlur stdDeviation="12"/></filter>';
  const F_B20L =
    '<filter id="b20l" filterUnits="userSpaceOnUse" x="-100" y="-100" width="1800" height="1200"><feGaussianBlur stdDeviation="20"/></filter>';
  const G_ZOD =
    '<radialGradient id="zod" cx="50%" cy="88%" r="75%"><stop offset="0%" stop-color="#f6d489" stop-opacity=".13"/><stop offset="55%" stop-color="#e8b25e" stop-opacity=".045"/><stop offset="100%" stop-opacity="0"/></radialGradient>';
  const G_RIMG =
    '<linearGradient id="rimg" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#ffd989"/><stop offset="100%" stop-color="#e2772b"/></linearGradient>';
  /* #502: entropy — rays are light through air, not vector wedges. Verbatim
     copy of the live filter this replaces (same id-worthy graph, no
     userSpaceOnUse pin needed: its default objectBoundingBox region already
     resolves against the SAME path geometry inside this raster body that it
     resolved against live, so the region is identical either way). */
  const F_RAYROUGH =
    '<filter id="rayrough" x="-30%" y="-30%" width="160%" height="160%"><feTurbulence type="fractalNoise" baseFrequency="0.004 0.03" numOctaves="2" seed="9" result="n"/><feDisplacementMap in="SourceGraphic" in2="n" scale="22"/><feGaussianBlur stdDeviation="17"/></filter>';
  const G_RAYG =
    '<linearGradient id="rayg" x1="0" y1="1" x2="0" y2="0"><stop offset="0%" stop-color="#ffe4a8" stop-opacity=".26"/><stop offset="55%" stop-color="#f4c05a" stop-opacity=".07"/><stop offset="100%" stop-opacity="0"/></linearGradient>';

  /* Each group's verbatim shape markup — same coordinates, same fills, same
     filter references — plus only the defs that group needs. class= is
     deliberately absent from the raster body: opacity/blend/animation are
     display-time CSS, applied to the live <image> below, not baked in. */
  const GROUPS = {
    zod: {
      defs: F_B20L + G_ZOD,
      body: '<ellipse cx="800" cy="640" rx="300" ry="480" fill="url(#zod)" filter="url(#b20l)"/>',
    },
    scatter: {
      defs: F_B2L + F_B6L + F_B12L + F_B20L,
      body:
        '<circle cx="800" cy="3920" r="3122" fill="none" stroke="#7a2c18" stroke-opacity=".1" stroke-width="150" filter="url(#b20l)"/>' +
        '<circle cx="800" cy="3920" r="3060" fill="none" stroke="#e2772b" stroke-opacity=".16" stroke-width="84" filter="url(#b20l)"/>' +
        '<circle cx="800" cy="3920" r="3026" fill="none" stroke="#f0b429" stroke-opacity=".28" stroke-width="34" filter="url(#b12l)"/>' +
        '<circle cx="800" cy="3920" r="3010" fill="none" stroke="#ffd989" stroke-opacity=".4" stroke-width="12" filter="url(#b6l)"/>' +
        '<circle cx="800" cy="3920" r="3003" fill="none" stroke="#fff3d6" stroke-opacity=".65" stroke-width="4" filter="url(#b2l)"/>',
    },
    sunpt: {
      defs: F_B6L,
      body: '<circle cx="800" cy="919" r="20" fill="#fffdf6" filter="url(#b6l)"/>',
    },
    sunarc: {
      defs: F_B2L,
      body:
        '<path d="M 560 934 A 3000 3000 0 0 1 1040 934" fill="none" stroke="#ffedc2"' +
        ' stroke-width="3" stroke-linecap="round" opacity=".7" filter="url(#b2l)"/>',
    },
    rim: {
      defs: F_B6L + G_RIMG,
      body:
        '<circle cx="800" cy="3920" r="3000" fill="none" stroke="url(#rimg)"' +
        ' stroke-width="6" stroke-opacity=".35" filter="url(#b6l)"/>',
    },
    /* #502: the two swaying fans of crepuscular rays, rasterised separately
       so each keeps ITS OWN rotation (sway1/sway2 run different periods and
       ranges) — the class moves onto the <image> below unchanged, the same
       way .zodiacal's and .rim's classes ride their own <image> already. */
    sway1: {
      defs: F_RAYROUGH + G_RAYG,
      body:
        '<g fill="url(#rayg)" filter="url(#rayrough)">' +
        '<path d="M 800 924 L 736 356 L 772 362 Z"/>' +
        '<path d="M 800 924 L 852 528 L 892 548 Z"/>' +
        '<path d="M 800 924 L 508 620 L 556 588 Z"/>' +
        '<path d="M 800 924 L 1096 448 L 1052 428 Z"/>' +
        '<path d="M 800 924 L 320 690 L 360 646 Z" opacity=".8"/>' +
        '<path d="M 800 924 L 1290 670 L 1244 630 Z" opacity=".8"/>' +
        '</g>',
    },
    sway2: {
      defs: F_RAYROUGH + G_RAYG,
      body:
        '<g fill="url(#rayg)" filter="url(#rayrough)" opacity=".7">' +
        '<path d="M 800 924 L 646 404 L 680 390 Z"/>' +
        '<path d="M 800 924 L 962 560 L 928 544 Z"/>' +
        '<path d="M 800 924 L 404 610 L 448 574 Z"/>' +
        '<path d="M 800 924 L 1200 596 L 1156 562 Z"/>' +
        '</g>',
    },
  };

  function frame(defs, body, w, h) {
    return (
      `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 1600 1000">` +
      `<defs>${defs}</defs>${body}</svg>`
    );
  }

  onMount(() => {
    let cancelled = false;
    let timer;

    async function build() {
      const rect = world.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      /* Capped at 2, as Grain.svelte caps it: retina stays crisp without a
         3x+ display doubling the raster for no visible gain. The scale is
         the SAME one the outer svg's own xMidYMid-slice transform will
         apply — max(width, height) against the 1600×1000 viewBox — so the
         raster lands at the exact device-pixel resolution it will be shown
         at, and compositing it back is a 1:1 blit, not a resample. */
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const scale = Math.max(rect.width / 1600, rect.height / 1000) * dpr;
      const w = Math.max(1, Math.round(1600 * scale));
      const h = Math.max(1, Math.round(1000 * scale));

      /* Marks this surface for the fidelity gate (screens.spec.js), which
         waits for it before screenshotting so the async decode below can
         never race a capture. */
      world.dataset.rasterised = "pending";
      const built = await Promise.all(
        Object.entries(GROUPS).map(async ([name, { defs, body }]) => {
          const key = `dawn-${name}|${w}|${h}`;
          const url = await rasteriseSvg(key, frame(defs, body, w, h), w, h);
          return [name, url];
        }),
      );
      if (cancelled) return;

      /* Imperative, same as Grain.svelte: every href lands in the same tick
         as the readiness flag below, with nothing async between them. */
      const targets = {
        zod: imgZod, scatter: imgScatter, sunpt: imgSunpt, sunarc: imgSunarc, rim: imgRim,
        sway1: imgSway1, sway2: imgSway2,
      };
      for (const [name, url] of built) targets[name]?.setAttribute("href", url);
      world.dataset.rasterised = "ready";
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

<div id="dawn" class:shown>
  <div class="sky" aria-hidden="true"><svg viewBox="0 0 1600 1000" preserveAspectRatio="xMidYMid slice">
    <!-- #444: the star fills follow the packs. cfa8388 made every screen's
         starfield read --star-far/--star-near, login's included, and the
         refactor that lifted this sky out of login/+page.svelte into a shared
         component brought the literals back with it. Restored here: on the dark
         packs the tokens ARE these values, so nothing moves; on a daylight pack
         the stars invert to ink instead of vanishing. -->
    <g class="far" fill="var(--star-far, #e9edf8)"><g id="lg-far">
      {#each DAWN_FAR as s, i (i)}
        {#if s.delay}<circle class="tw" style="animation-delay:{s.delay}s" cx={s.cx} cy={s.cy} r={s.r} opacity={s.opacity}/>
        {:else}<circle cx={s.cx} cy={s.cy} r={s.r} opacity={s.opacity}/>{/if}
      {/each}
    </g><use href="#lg-far" x="1600"/></g>
    <g class="near" fill="var(--star-near, #f4f0ff)"><g id="lg-near">
      {#each DAWN_NEAR as s, i (i)}
        <circle cx={s.cx} cy={s.cy} r={s.r} opacity={s.opacity}/>
      {/each}
    </g><use href="#lg-near" x="1600"/></g>
  </svg></div>
  <div class="world" aria-hidden="true" bind:this={world}><svg viewBox="0 0 1600 1000" preserveAspectRatio="xMidYMid slice">
    <defs>
      <!-- rimg stays live: the CRISP rim circle below (no filter) still
           reads it. Its blurred sibling is rasterised (#501) and carries its
           own copy of this gradient inside the offscreen SVG (GROUPS.rim). -->
      <linearGradient id="rimg" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="#ffd989"/><stop offset="100%" stop-color="#e2772b"/>
      </linearGradient>
      <!-- the sun about to break the limb: white heart, gold bloom, ember haze -->
      <radialGradient id="sun-core" cx="50%" cy="50%" r="50%">
        <stop offset="0%" stop-color="#ffffff"/>
        <stop offset="35%" stop-color="#ffedc2" stop-opacity=".85"/>
        <stop offset="100%" stop-color="#ffe9c4" stop-opacity="0"/>
      </radialGradient>
      <radialGradient id="sun-mid" cx="50%" cy="50%" r="50%">
        <stop offset="0%" stop-color="#f8c95e" stop-opacity=".55"/>
        <stop offset="60%" stop-color="#f0b429" stop-opacity=".18"/>
        <stop offset="100%" stop-opacity="0"/>
      </radialGradient>
      <radialGradient id="sun-wide" cx="50%" cy="50%" r="50%">
        <stop offset="0%" stop-color="#e2772b" stop-opacity=".3"/>
        <stop offset="55%" stop-color="#c2571f" stop-opacity=".12"/>
        <stop offset="100%" stop-opacity="0"/>
      </radialGradient>
      <!-- "zod" and "rayg" no longer live here: their only users (.zodiacal,
           #502's sway1/sway2) are rasterised and each carries its own copy
           (GROUPS.zod, GROUPS.sway1, GROUPS.sway2). -->
      <linearGradient id="skywash" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-opacity="0"/>
        <stop offset="62%" stop-color="#3d2a4d" stop-opacity=".12"/>
        <stop offset="86%" stop-color="#a2492a" stop-opacity=".2"/>
        <stop offset="100%" stop-color="#e2772b" stop-opacity=".26"/>
      </linearGradient>
      <!-- #498 pinned b2l/b6l/b12l/b20l to a userSpaceOnUse region matching
           the viewBox — #501 rasterises every element that referenced them
           (.zodiacal, .scatter, the sun's core dot, the scattering arc, the
           blurred half of .rim) and removes the live defs entirely: each
           raster carries its own copy of whichever of these four it needs
           (GROUPS above). Nothing here still points at "b2l"/"b6l"/"b12l"/
           "b20l" live. "rayrough" is gone the same way (#502, GROUPS.sway1/
           GROUPS.sway2) — the profile that led to it is in Dawn.svelte's own
           top-of-file note. -->
    </defs>
    <g class="dawnlayer">
      <rect x="0" y="0" width="1600" height="1000" fill="url(#skywash)"/>
      <!-- #501: rasterised (GROUPS.zod); class stays here since blend/opacity
           are display-time CSS, not baked into the raster. -->
      <image class="zodiacal" bind:this={imgZod} x="0" y="0" width="1600" height="1000" preserveAspectRatio="none"/>
      <!-- #502: the two swaying fans, rasterised (GROUPS.sway1/GROUPS.sway2)
           — sway1/sway2 move from the live filtered <g> onto these <image>s
           unchanged, so the CSS rotation (flight.css's sway1/sway2 keyframes,
           same transform-origin) rides the picture instead of recomputing
           the turbulence/displacement/blur filter underneath it every frame. -->
      <g class="rays">
        <image class="sway1" bind:this={imgSway1} x="0" y="0" width="1600" height="1000" preserveAspectRatio="none"/>
        <image class="sway2" bind:this={imgSway2} x="0" y="0" width="1600" height="1000" preserveAspectRatio="none"/>
      </g>
      <!-- #501: the five limb scattering rings, rasterised as one image
           (GROUPS.scatter) so .scatter's own breathe-band opacity animation
           still applies to the whole ring stack via this <g>. -->
      <g class="scatter">
        <image bind:this={imgScatter} x="0" y="0" width="1600" height="1000" preserveAspectRatio="none"/>
      </g>
      <g class="sunpt">
        <g class="sunpt-breathe">
          <circle cx="800" cy="922" r="520" fill="url(#sun-wide)"/>
          <circle cx="800" cy="922" r="240" fill="url(#sun-mid)"/>
          <circle cx="800" cy="920" r="86" fill="url(#sun-core)"/>
          <!-- #501: rasterised (GROUPS.sunpt) — the only one of these four
               that carried a filter; the other three stay live vectors. -->
          <image bind:this={imgSunpt} x="0" y="0" width="1600" height="1000" preserveAspectRatio="none"/>
        </g>
        <!-- #501: rasterised (GROUPS.sunarc). -->
        <image bind:this={imgSunarc} x="0" y="0" width="1600" height="1000" preserveAspectRatio="none"/>
      </g>
    </g>
    <!-- the planet: everything below the limb is night -->
    <circle cx="800" cy="3920" r="3000" fill="#04060e"/>
    <!-- #501: rasterised (GROUPS.rim) — the blurred half of the rim; class
         stays here since .rim's fade-in transition is display-time CSS. -->
    <image class="rim" bind:this={imgRim} x="0" y="0" width="1600" height="1000" preserveAspectRatio="none"/>
    <circle class="rim" cx="800" cy="3920" r="3000" fill="none" stroke="url(#rimg)"
            stroke-width="2.4" stroke-opacity=".85"/>
    <circle class="shimmer" pathLength="100" cx="800" cy="3920" r="3000" fill="none"
            stroke="#fff6e6" stroke-width="3.4" stroke-linecap="round"/>
  </svg></div>

  <!-- The 08-14 hero (§15, owner 2026-08-17): the ring at 420px, the word set
       plain inside it with no filled centre, the ratified pill inside the ring
       beneath the word. No ribbon, no footer. Drawn for THIS size rather than
       scaled up from the favicon geometry — at 420px the mark's own 9-unit
       stroke renders ~19px and its 20-unit planet an 84px disc, which reads as
       a heavy badge instead of a slim ring with a small body riding it. 2
       units = ~4px of line, 7 units = a ~29px planet; the planet still sits on
       the ring at radius 72. -->
  <div class="loginchrome">
    <div class="lockup">
      <div class="glyph" id="login-glyph"><svg width="420" height="420" viewBox="0 0 200 200">
        <circle cx="100" cy="100" r="72" fill="none" stroke="#8791b3" stroke-width="2"/>
        <g class="tr"><circle cx="163" cy="63.5" r="7" fill="#d8b45a"/></g></svg></div>
      <div class="name">orbit</div>
      <div class="gate-wrap">{@render children?.()}</div>
    </div>
  </div>
</div>
