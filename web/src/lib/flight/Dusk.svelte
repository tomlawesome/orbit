<script>
  import { onMount } from "svelte";
  import { DUSK_FAR, DUSK_NEAR } from "./starfields.js";
  import { decodeAhead } from "./decode-ahead.js";
  import "./flight.css";
  import "./door-phone.css";

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
   * #501/#1253 — the glow, the belt, the afterglow's rings and the blurred
   * half of the rim are pictures (static/flight/dusk/), drawn once from their
   * filter graphs by orbit-site's tools/glows.cjs, the same pictures the
   * site's dusk shows; nothing is rasterised in the browser any more. What
   * animates is still only `.afterglow` (breathe-ember) and `.belt`
   * (zbreathe), both opacity, and the shimmer's dash sweep, each on a layer of
   * its own since #1299 (see the markup). The frame is laid
   * from the bottom (xMidYMax slice), as the dawn and the canvas world are.
   * `data-rasterised` is "pending" until every picture has loaded (or failed
   * to), then "ready", for the fidelity gate.
   */
  /* `landmark`: the goodbye played in place over another page (Leave.svelte,
     #1253) is that page's last screen, and the page's own <main> and <h1>
     have withdrawn by then. The dusk then carries the one landmark and the
     one heading the screen-reader walk (#496, #843) expects of the sign-out
     screen, exactly as /logout's own page does around it. */
  let { children = undefined, landmark = false } = $props();
  /** @type {HTMLDivElement} */
  let world;
  /** @type {HTMLDivElement} */
  let sky;
  /* the far stars that twinkle, and those that do not, each set its own
     layer (#1299); the field and its order are starfields.js's */
  const STILL = DUSK_FAR.filter((s) => !s.delay);
  const TWINKLERS = DUSK_FAR.filter((s) => s.delay);

  /* #1299: the sky's layers drift a whole tile, 1600 of the picture's units,
     in screen pixels (orbit-site's sky.js measureTile, unrounded): the
     picture is scaled to cover the sky, so a unit is the larger of the two
     ratios */
  onMount(() => {
    const measure = () => {
      const box = sky.getBoundingClientRect();
      sky.style.setProperty("--tile", `${1600 * Math.max(box.width / 1600, box.height / 1000)}px`);
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const watch = new ResizeObserver(measure);
    watch.observe(sky);
    return () => watch.disconnect();
  });

  onMount(() => {
    let cancelled = false;
    world.dataset.rasterised = "pending";
    const images = /** @type {SVGImageElement[]} */ ([...world.querySelectorAll("image[data-href]")]);
    /* #1299: this mounts as the sign-out starts and is not seen until the
       dusk beat; decoded now, its pictures are ready by then (decode-ahead.js) */
    const pictures = decodeAhead(images.map((im) => /** @type {string} */ (im.dataset.href))).held;
    /** @param {SVGImageElement} im */
    const arrive = (im) => new Promise((resolve) => {
      /** @type {(e: Event) => void} */
      const done = (e) => {
        /* the Earth fades in as the dawn's does, and the crisp rim gives way to it (#1253) */
        if (!cancelled && e.type === "load" && im.closest(".earth")) {
          im.classList.add("in");
          if (im.classList.contains("pre")) world.classList.add("earthy");
        }
        resolve(undefined);
      };
      im.addEventListener("load", done, { once: true });
      im.addEventListener("error", done, { once: true });
      im.setAttribute("href", /** @type {string} */ (im.dataset.href));
    });
    const frame = requestAnimationFrame(() => {
      Promise.all(images.map(arrive)).then(() => { if (!cancelled) world.dataset.rasterised = "ready"; });
    });
    return () => { cancelled = true; cancelAnimationFrame(frame); pictures.length = 0; };
  });
</script>

<div id="dusk" role={landmark ? "main" : undefined}>
  {#if landmark}<h1 class="sr-only">Orbit — signed out</h1>{/if}
  <!-- #1299: each moving part of the sky is a picture of its own, moved whole
       (orbit-site's sky.js mountFlightSky): the still far stars, each
       twinkler, and the near stars. A layer that only slides or fades is the
       GPU's to move; a star moving inside one shared picture had the page
       repaint the whole of it every frame. -->
  <div class="sky" aria-hidden="true" bind:this={sky}>
    <!-- #444: the star fills follow the packs, as cfa8388 made them everywhere
         else. The literals came back when this sky moved out of
         logout/+page.svelte into a shared component; the tokens equal these
         values on the dark packs, so nothing moves, and a daylight pack finally
         gets stars it can see. -->
    <svg class="far" viewBox="0 0 1600 1000" preserveAspectRatio="xMidYMid slice"><g fill="var(--star-far, #e9edf8)"><g id="dk-far">
      {#each STILL as s, i (i)}<circle cx={s.cx} cy={s.cy} r={s.r} opacity={s.opacity}/>{/each}
    </g><use href="#dk-far" x="1600"/></g></svg>
    <!-- a twinkler is drawn at full strength and its layer carries its
         opacity (--o, flight.css): its own resting value until its twinkle
         starts, then the twinkle's, exactly as the star's own opacity did -->
    {#each TWINKLERS as s, i (i)}
      <svg class="far tw" style="--o:{s.opacity};animation-delay:0s,{s.delay}s" viewBox="0 0 1600 1000" preserveAspectRatio="xMidYMid slice"><g fill="var(--star-far, #e9edf8)"><g id="dk-tw{i}"><circle cx={s.cx} cy={s.cy} r={s.r}/></g><use href="#dk-tw{i}" x="1600"/></g></svg>
    {/each}
    <svg class="near" viewBox="0 0 1600 1000" preserveAspectRatio="xMidYMid slice"><g fill="var(--star-near, #f4f0ff)"><g id="dk-near">
      {#each DUSK_NEAR as s, i (i)}<circle cx={s.cx} cy={s.cy} r={s.r} opacity={s.opacity}/>{/each}
    </g><use href="#dk-near" x="1600"/></g></svg>
  </div>
  <!-- #1299: the world is laid as orbit-site lays it (index.html, #dusk
       .world): one picture per moving part, so the belt's and the afterglow's
       breathing fade a layer the GPU holds, and the shimmer's sweep redraws
       only its own thin layer, never the full-screen pictures under it. The
       order of drawing is unchanged. -->
  <div class="world" aria-hidden="true" bind:this={world}>
    <svg class="defs" width="0" height="0"><defs>
      <!-- d-rim: the crisp rim circle below; its blurred sibling is a
           picture (glow-rim.webp) -->
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
      <!-- the glow, the belt, the afterglow and the blurred rim are pictures
           (static/flight/dusk/), drawn from their own gradients and blurs -->
    </defs></svg>
    <svg class="wash" viewBox="0 0 1600 1000" preserveAspectRatio="xMidYMax slice">
      <rect x="0" y="0" width="1600" height="1000" fill="url(#d-wash)"/>
      <!-- #501: a picture (glow-glow.webp). -->
      <image data-href="/flight/dusk/glow-glow.webp" x="0" y="0" width="1600" height="1000" preserveAspectRatio="none"/>
    </svg>
    <!-- #501: a picture (glow-belt.webp); .belt's opacity animation is
         display-time CSS, not baked in, and now fades its own layer. -->
    <svg class="belt" viewBox="0 0 1600 1000" preserveAspectRatio="xMidYMax slice">
      <image data-href="/flight/dusk/glow-belt.webp" x="0" y="0" width="1600" height="1000" preserveAspectRatio="none"/>
    </svg>
    <!-- afterglow hugging the limb: no white core, the sun is already under.
         It breathes, as the dawn's scattering does — slower and cooler.
         #501: a picture as one image (glow-afterglow.webp) so .afterglow's own
         breathe-ember animation still applies to the whole ring stack. -->
    <svg class="afterglow" viewBox="0 0 1600 1000" preserveAspectRatio="xMidYMax slice">
      <image data-href="/flight/dusk/glow-afterglow.webp" x="0" y="0" width="1600" height="1000" preserveAspectRatio="none"/>
    </svg>
    <svg class="limb" viewBox="0 0 1600 1000" preserveAspectRatio="xMidYMax slice">
      <circle cx="800" cy="3920" r="3000" fill="#03050b"/>
      <!-- the Earth, from orbit: the very one the dawn door shows (owner,
           2026-10-07: sign out and sign in use the same photo), both its
           pictures, at the same place and in the same order, under the ember
           rim and the dusk's own glow (#1253) -->
      <g class="earth">
        <image class="pre" data-href="/flight/door/dawn-pre.webp" x="0" y="640" width="1600" height="360" preserveAspectRatio="none"/>
        <image class="up" data-href="/flight/door/dawn.webp" x="0" y="640" width="1600" height="360" preserveAspectRatio="none"/>
      </g>
      <!-- #501: a picture (glow-rim.webp) — the blurred half of the rim. No
           class here, matching the original: unlike Dawn's rim this one never
           had a fade-in transition. -->
      <image data-href="/flight/dusk/glow-rim.webp" x="0" y="0" width="1600" height="1000" preserveAspectRatio="none"/>
      <circle class="crisp" cx="800" cy="3920" r="3000" fill="none" stroke="url(#d-rim)"
              stroke-width="1.8" stroke-opacity=".6"/>
    </svg>
    <!-- the dawn's travelling shimmer, cooled to an ember and running the
         other way round the limb -->
    <svg class="shimmerlayer" viewBox="0 0 1600 1000" preserveAspectRatio="xMidYMax slice">
      <circle class="shimmer" pathLength="100" cx="800" cy="3920" r="3000" fill="none"
              stroke="#ffb37a" stroke-width="3" stroke-linecap="round"/>
    </svg>
  </div>
  <!-- the login's own lockup, so both ends of a session show one face, and so
       the descent's mark sets down on the shape the climb lifted off -->
  <div class="loginchrome">
    <div class="lockup">
      <div class="glyph" id="dusk-glyph"><svg width="420" height="420" viewBox="0 0 200 200">
        <defs>
          <linearGradient id="d-ringlit" gradientUnits="userSpaceOnUse" x1="0" y1="26" x2="0" y2="174"><stop offset="0" stop-color="#6c76a0" stop-opacity=".6"/><stop offset=".5" stop-color="#aab2cf" stop-opacity=".85"/><stop offset=".86" stop-color="#ead2a4"/><stop offset="1" stop-color="#ffe2a8"/></linearGradient>
          <radialGradient id="d-disclit" cx="100" cy="100" r="72" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#03040a" stop-opacity=".55"/><stop offset=".8" stop-color="#05070f" stop-opacity=".35"/><stop offset="1" stop-color="#05070f" stop-opacity="0"/></radialGradient>
          <radialGradient id="d-discwarm" cx="100" cy="182" r="70" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#ffcf8a" stop-opacity=".16"/><stop offset="1" stop-color="#ffcf8a" stop-opacity="0"/></radialGradient>
          <linearGradient id="d-trail" gradientUnits="userSpaceOnUse" x1="46.5" y1="51.8" x2="163" y2="63.5"><stop offset="0" stop-color="#ffd68c" stop-opacity="0"/><stop offset=".46" stop-color="#ffd68c" stop-opacity=".08"/><stop offset="1" stop-color="#ffdea0" stop-opacity=".75"/></linearGradient>
        </defs>
        <g class="lux"><circle cx="100" cy="100" r="71" fill="url(#d-disclit)"/><circle cx="100" cy="100" r="71" fill="url(#d-discwarm)"/></g>
        <g class="lux"><circle cx="100" cy="100" r="72" fill="none" stroke="url(#d-ringlit)" stroke-width="9" stroke-opacity=".05"/>
        <circle cx="100" cy="100" r="72" fill="none" stroke="url(#d-ringlit)" stroke-width="3.6" stroke-opacity=".12"/></g>
        <circle class="ring" cx="100" cy="100" r="72" fill="none" stroke="url(#d-ringlit)" stroke-width="1.6"/>
        <g class="tr"><path d="M46.5 51.8 A72 72 0 0 1 163 63.5" fill="none" stroke="url(#d-trail)" stroke-width="3.2" stroke-linecap="round"/><image class="world" href="/flight/door/planet-gold.webp" x="145" y="45.5" width="36" height="36"/></g></svg></div>
      <div class="name">orbit</div>
      <!-- the farewell hangs off the way back in's own box (flight.css, "THE
           FAREWELL RIDES WITH THE WAY BACK IN"): out of flow, so the lockup
           is centred exactly as the door's is, and the same gap under the pill
           at any height -->
      <div class="gate-wrap">{@render children?.()}
        <div class="farewell">
          <div class="said">You are signed out.</div>
          <div class="sub">the sky keeps turning &middot; your systems keep their orbits</div>
        </div>
      </div>
    </div>
  </div>
</div>
