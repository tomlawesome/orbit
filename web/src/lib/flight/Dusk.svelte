<script>
  import { onMount } from "svelte";
  import { DUSK_FAR, DUSK_NEAR } from "./starfields.js";
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
   * (zbreathe), both opacity, and the shimmer's dash sweep. The frame is laid
   * from the bottom (xMidYMax slice), as the dawn and the canvas world are.
   * `data-rasterised` is "pending" until every picture has loaded (or failed
   * to), then "ready", for the fidelity gate.
   */
  let { children = undefined } = $props();
  /** @type {HTMLDivElement} */
  let world;

  onMount(() => {
    let cancelled = false;
    world.dataset.rasterised = "pending";
    const images = /** @type {SVGImageElement[]} */ ([...world.querySelectorAll("image[data-href]")]);
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
    return () => { cancelled = true; cancelAnimationFrame(frame); };
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
  <div class="world" aria-hidden="true" bind:this={world}><svg viewBox="0 0 1600 1000" preserveAspectRatio="xMidYMax slice">
    <defs>
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
    </defs>
    <rect x="0" y="0" width="1600" height="1000" fill="url(#d-wash)"/>
    <!-- #501: a picture (glow-glow.webp). -->
    <image data-href="/flight/dusk/glow-glow.webp" x="0" y="0" width="1600" height="1000" preserveAspectRatio="none"/>
    <!-- #501: a picture (glow-belt.webp); class stays here since .belt's
         opacity/blend animation is display-time CSS, not baked in. -->
    <image class="belt" data-href="/flight/dusk/glow-belt.webp" x="0" y="0" width="1600" height="1000" preserveAspectRatio="none"/>
    <!-- afterglow hugging the limb: no white core, the sun is already under.
         It breathes, as the dawn's scattering does — slower and cooler.
         #501: a picture as one image (glow-afterglow.webp) so .afterglow's own
         breathe-ember animation still applies to the whole ring stack. -->
    <g class="afterglow">
      <image data-href="/flight/dusk/glow-afterglow.webp" x="0" y="0" width="1600" height="1000" preserveAspectRatio="none"/>
    </g>
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
      <div class="gate-wrap">{@render children?.()}</div>
    </div>
    <div class="farewell">
      <div class="said">You are signed out.</div>
      <div class="sub">the sky keeps turning &middot; your systems keep their orbits</div>
    </div>
  </div>
</div>
