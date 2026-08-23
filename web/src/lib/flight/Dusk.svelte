<script>
  import { onMount } from "svelte";
  import { DUSK_FAR, DUSK_NEAR } from "./starfields.js";
  import { rasteriseSvg } from "$lib/raster.js";

  /**
   * THE DUSK — where the descent sets down, and, since §15's 2026-08-17
   * batch, the whole of what logging out means: the owner re-confirmed that
   * the descent IS the default logout and retired the old /logout sunset in
   * its favour. Markup from design/v19/first-run.html: the earth-shadow stack
   * (violet above, the Belt of Venus, then ember), the afterglow hugging the
   * limb with no white core because the sun is already under, and the same
   * lockup the dawn wears, so both ends of a session show one face.
   *
   * Dawn to log in, dusk to log out — the family rule the owner kept in the
   * same breath as the launch (§15).
   *
   * TWO THINGS THE SAME BATCH ADDED. The goodbye's sky was a still frame while
   * the login surface it mirrors breathed, swayed, drifted and swept; it now
   * carries every one of those motions, running the other way (flight.css,
   * "THE GOODBYE'S SKY LIVES"). And the way back in is the LOGIN'S OWN GATE —
   * the `children` snippet is rendered into the lockup's gate-wrap, in the
   * ring beneath the word, wearing the .gate rule unchanged, because the owner
   * ruled the sign-in button identical on both surfaces.
   *
   * As on the dawn, only the ARTWORK is aria-hidden: the farewell and the way
   * back in are the screen's whole point and must be readable.
   *
   * #501 — the same fix as Dawn.svelte, for the same reason: d-b6/d-b14/
   * d-b24 were still LIVE feGaussianBlur filters on static shapes, so Safari
   * paid to software-rasterise them every repaint. Checked first: what
   * animates here is `.afterglow` (breathe-ember) and `.belt` (zbreathe),
   * both opacity-only, plus the shimmer's dash-offset sweep — which carries
   * no filter at all, live or otherwise, so it is untouched either way.
   * Everything else — d-glow, .belt's own shape, .afterglow's four rings,
   * the blurred half of the rim — is a static shape, rasterised once at
   * mount via $lib/raster.js (the same mechanism Grain.svelte and
   * Dawn.svelte use) and composited back as a plain <image>, at the full
   * 1600×1000 viewBox frame so it drops into the same slice-scaled <svg>
   * the live shapes it replaces sit in. See Dawn.svelte's own note for the
   * full reasoning; it applies here unchanged.
   */
  let { children = undefined } = $props();
  let world;
  let imgGlow, imgBelt, imgAfterglow, imgRim;

  const F_DB6 =
    '<filter id="d-b6" filterUnits="userSpaceOnUse" x="-40" y="-40" width="1680" height="1080"><feGaussianBlur stdDeviation="6"/></filter>';
  const F_DB14 =
    '<filter id="d-b14" filterUnits="userSpaceOnUse" x="-70" y="-70" width="1740" height="1140"><feGaussianBlur stdDeviation="14"/></filter>';
  const F_DB24 =
    '<filter id="d-b24" filterUnits="userSpaceOnUse" x="-100" y="-100" width="1800" height="1200"><feGaussianBlur stdDeviation="24"/></filter>';
  const G_DGLOW =
    '<radialGradient id="d-glow" cx="50%" cy="50%" r="50%"><stop offset="0%" stop-color="#e08a3c" stop-opacity=".34"/><stop offset="55%" stop-color="#a2492a" stop-opacity=".12"/><stop offset="100%" stop-opacity="0"/></radialGradient>';
  const G_DBELT =
    '<radialGradient id="d-belt" cx="50%" cy="50%" r="50%"><stop offset="0%" stop-color="#d98fae" stop-opacity=".2"/><stop offset="100%" stop-opacity="0"/></radialGradient>';
  const G_DRIM =
    '<linearGradient id="d-rim" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#f0a35a"/><stop offset="100%" stop-color="#7a2c18"/></linearGradient>';

  /* Verbatim shape markup per group, plus only the defs that group needs.
     class= stays off the raster body — opacity/blend/animation are
     display-time CSS applied to the live <image> below, not baked in. */
  const GROUPS = {
    glow: {
      defs: F_DB24 + G_DGLOW,
      body: '<ellipse cx="800" cy="960" rx="900" ry="300" fill="url(#d-glow)" filter="url(#d-b24)"/>',
    },
    belt: {
      defs: F_DB24 + G_DBELT,
      body: '<ellipse cx="800" cy="700" rx="1000" ry="180" fill="url(#d-belt)" filter="url(#d-b24)"/>',
    },
    afterglow: {
      defs: F_DB24 + F_DB14 + F_DB6,
      body:
        '<circle cx="800" cy="3920" r="3086" fill="none" stroke="#5e2418" stroke-opacity=".12" stroke-width="130" filter="url(#d-b24)"/>' +
        '<circle cx="800" cy="3920" r="3038" fill="none" stroke="#c2571f" stroke-opacity=".2" stroke-width="60" filter="url(#d-b24)"/>' +
        '<circle cx="800" cy="3920" r="3014" fill="none" stroke="#e08a3c" stroke-opacity=".26" stroke-width="20" filter="url(#d-b14)"/>' +
        '<circle cx="800" cy="3920" r="3004" fill="none" stroke="#ffd9a0" stroke-opacity=".3" stroke-width="5" filter="url(#d-b6)"/>',
    },
    rim: {
      defs: F_DB6 + G_DRIM,
      body:
        '<circle cx="800" cy="3920" r="3000" fill="none" stroke="url(#d-rim)"' +
        ' stroke-width="5" stroke-opacity=".28" filter="url(#d-b6)"/>',
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
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const scale = Math.max(rect.width / 1600, rect.height / 1000) * dpr;
      const w = Math.max(1, Math.round(1600 * scale));
      const h = Math.max(1, Math.round(1000 * scale));

      world.dataset.rasterised = "pending";
      const built = await Promise.all(
        Object.entries(GROUPS).map(async ([name, { defs, body }]) => {
          const key = `dusk-${name}|${w}|${h}`;
          const url = await rasteriseSvg(key, frame(defs, body, w, h), w, h);
          return [name, url];
        }),
      );
      if (cancelled) return;

      const targets = { glow: imgGlow, belt: imgBelt, afterglow: imgAfterglow, rim: imgRim };
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

<div id="dusk">
  <div class="sky" aria-hidden="true"><svg viewBox="0 0 1600 1000" preserveAspectRatio="xMidYMid slice">
    <!-- #444: the star fills follow the packs, as cfa8388 made them everywhere
         else. The literals came back when this sky moved out of
         logout/+page.svelte into a shared component; the tokens equal these
         values on the dark packs, so nothing moves, and a daylight pack finally
         gets stars it can see. -->
    <g class="far" fill="var(--star-far, #e9edf8)"><g id="dk-far">
      {#each DUSK_FAR as s, i (i)}
        {#if s.delay}<circle class="tw" style="animation-delay:{s.delay}s" cx={s.cx} cy={s.cy} r={s.r} opacity={s.opacity}/>
        {:else}<circle cx={s.cx} cy={s.cy} r={s.r} opacity={s.opacity}/>{/if}
      {/each}
    </g><use href="#dk-far" x="1600"/></g>
    <g class="near" fill="var(--star-near, #f4f0ff)"><g id="dk-near">
      {#each DUSK_NEAR as s, i (i)}
        <circle cx={s.cx} cy={s.cy} r={s.r} opacity={s.opacity}/>
      {/each}
    </g><use href="#dk-near" x="1600"/></g>
  </svg></div>
  <div class="world" aria-hidden="true" bind:this={world}><svg viewBox="0 0 1600 1000" preserveAspectRatio="xMidYMid slice">
    <defs>
      <!-- d-rim stays live: the CRISP rim circle below (no filter) still
           reads it. Its blurred sibling is rasterised (#501, GROUPS.rim)
           and carries its own copy inside the offscreen SVG. -->
      <linearGradient id="d-rim" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="#f0a35a"/><stop offset="100%" stop-color="#7a2c18"/>
      </linearGradient>
      <!-- the earth-shadow stack: violet above, Belt of Venus, then ember -->
      <linearGradient id="d-wash" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-opacity="0"/>
        <stop offset="40%" stop-color="#1e1838" stop-opacity=".30"/>
        <stop offset="62%" stop-color="#3b2450" stop-opacity=".34"/>
        <stop offset="78%" stop-color="#83354f" stop-opacity=".26"/>
        <stop offset="91%" stop-color="#a2492a" stop-opacity=".22"/>
        <stop offset="100%" stop-color="#c2571f" stop-opacity=".22"/>
      </linearGradient>
      <!-- "d-glow" and "d-belt" no longer live here: their only users are
           rasterised (#501, GROUPS.glow / GROUPS.belt) and each carries its
           own copy of its gradient. -->
      <!-- #498 pinned d-b6/d-b14/d-b24 to a userSpaceOnUse region matching
           the viewBox — #501 rasterises every element that referenced them
           (d-glow, .belt, .afterglow's four rings, the blurred half of the
           rim) and removes the live defs entirely: each raster carries its
           own copy of whichever of these three it needs (GROUPS above). -->
    </defs>
    <rect x="0" y="0" width="1600" height="1000" fill="url(#d-wash)"/>
    <!-- #501: rasterised (GROUPS.glow). -->
    <image bind:this={imgGlow} x="0" y="0" width="1600" height="1000" preserveAspectRatio="none"/>
    <!-- #501: rasterised (GROUPS.belt); class stays here since .belt's
         opacity/blend animation is display-time CSS, not baked in. -->
    <image class="belt" bind:this={imgBelt} x="0" y="0" width="1600" height="1000" preserveAspectRatio="none"/>
    <!-- afterglow hugging the limb: no white core, the sun is already under.
         It breathes, as the dawn's scattering does — slower and cooler.
         #501: rasterised as one image (GROUPS.afterglow) so .afterglow's own
         breathe-ember animation still applies to the whole ring stack. -->
    <g class="afterglow">
      <image bind:this={imgAfterglow} x="0" y="0" width="1600" height="1000" preserveAspectRatio="none"/>
    </g>
    <circle cx="800" cy="3920" r="3000" fill="#03050b"/>
    <!-- #501: rasterised (GROUPS.rim) — the blurred half of the rim. No
         class here, matching the original: unlike Dawn's rim this one never
         had a fade-in transition. -->
    <image bind:this={imgRim} x="0" y="0" width="1600" height="1000" preserveAspectRatio="none"/>
    <circle cx="800" cy="3920" r="3000" fill="none" stroke="url(#d-rim)"
            stroke-width="1.8" stroke-opacity=".6"/>
    <!-- the dawn's travelling shimmer, cooled to an ember and running the
         other way round the limb -->
    <circle class="shimmer" pathLength="100" cx="800" cy="3920" r="3000" fill="none"
            stroke="#ffb37a" stroke-width="3" stroke-linecap="round"/>
  </svg></div>
  <!-- the login's own lockup, so both ends of a session show one face, and so
       the descent's mark sets down on the shape the climb lifted off -->
  <div class="loginchrome">
    <div class="lockup">
      <div class="glyph" id="dusk-glyph"><svg width="420" height="420" viewBox="0 0 200 200">
        <circle cx="100" cy="100" r="72" fill="none" stroke="#8791b3" stroke-width="2"/>
        <g class="tr"><circle cx="163" cy="63.5" r="7" fill="#d8b45a"/></g></svg></div>
      <div class="name">orbit</div>
      <div class="gate-wrap">{@render children?.()}</div>
    </div>
    <div class="farewell">
      <div class="said">You are signed out.</div>
      <div class="sub">the sky keeps turning &middot; your systems keep their orbits</div>
    </div>
  </div>
</div>
