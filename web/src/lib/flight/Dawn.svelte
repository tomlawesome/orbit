<script>
  import { onMount } from "svelte";
  import { DAWN_FAR, DAWN_NEAR } from "./starfields.js";
  import "./flight.css";
  import "./door-phone.css";

  /**
   * THE DAWN — the sky the launch leaves from, and the sign-in's own surface.
   * Markup from design/v19/first-run.html (which carries
   * design/family/login.html's world across): the skywash, the zodiacal cone,
   * the two swaying fans of crepuscular rays, the point of first light, and
   * the night side below it.
   *
   * THE CHROME on top of it is the 2026-08-14 login, not the sheet's (owner,
   * 2026-08-17: "the flight's login screen uses THE MOST RECENT APPROVED
   * LOGIN... there shouldnt be a footer"); see flight.css for the ruling.
   *
   * THE EARTH (#1253, from orbit-site): the night side is the real one now --
   * the Earth from 800 km over the Atlantic, looking east over Europe as the
   * sun comes up, rendered once by orbit-site's tools/dawn.py from NASA's
   * Black Marble city lights and Blue Marble land and clouds: before the light
   * (dawn-pre) and with it (dawn), in this 1600×1000 frame, rows 640–1000. The
   * picture carries the limb's own scattered light, so the scattering rings,
   * the arc and the blurred rim this surface used to draw are gone, and the
   * crisp rim gives way once the picture is in (`earthy`). The frame is laid
   * from the bottom (xMidYMax slice), as the site lays it, so a wide screen
   * crops the sky, never the Earth; engine.js lays the canvas world the same
   * way, so the handoff into the flight has nothing to give it away.
   *
   * THE GLOWS (#501/#502) are pictures too: the zodiacal cone, the two fans
   * of rays and the sun's soft core, drawn once from the very filter graphs
   * this component used to rasterise in the browser (orbit-site's
   * tools/glows.cjs), so nothing is drawn here at load any more. What moves
   * is still only CSS opacity and rigid rotation over them (flight.css).
   *
   * `data-rasterised` keeps its meaning for the fidelity gate and the e2e
   * door specs: "pending" until every picture on this surface has loaded
   * (or failed to), then "ready". The pictures are asked for after the
   * surface's first frame, so the sky is up before they start.
   *
   * The ARTWORK is aria-hidden, not the whole surface: the lockup and the gate
   * ARE the sign-in.
   *
   * `children` is the ask: the sign-in renders its gate into it, and the
   * launch overlay on the landing renders nothing at all.
   */
  let {
    children = undefined,
    shown = false,
    /*
     * THE THREE STATES WHERE THE DOOR CANNOT OPEN (#788): fixed Orbit-owned
     * text, set by SignIn.svelte, that stands where the gate would. `.state`
     * is always in the DOM — never conditionally rendered — because it is an
     * `aria-live="polite"` region: a reader using a screen reader needs the
     * element to already exist for a later text change to announce.
     */
    statePrimary = "",
    stateSub = "",
  } = $props();
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
        /* the first light waits for the night side's picture, loaded or not
           (first-light.js); the day side's fade waits for its picture as well
           as for `lit` (flight.css) */
        if (im.classList.contains("pre")) world.dataset.earth = "settled";
        if (!cancelled && e.type === "load") {
          im.classList.add("in");
          if (im.classList.contains("pre")) world.classList.add("earthy");
        }
        resolve(undefined);
      };
      im.addEventListener("load", done, { once: true });
      im.addEventListener("error", done, { once: true });
      im.setAttribute("href", /** @type {string} */ (im.dataset.href));
    });
    /* after the first frame, so the sky is on screen before the pictures */
    const frame = requestAnimationFrame(() => {
      Promise.all(images.map(arrive)).then(() => { if (!cancelled) world.dataset.rasterised = "ready"; });
    });
    return () => { cancelled = true; cancelAnimationFrame(frame); };
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
  <div class="world" aria-hidden="true" bind:this={world}><svg viewBox="0 0 1600 1000" preserveAspectRatio="xMidYMax slice">
    <defs>
      <linearGradient id="rimg" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="#ffd989"/><stop offset="100%" stop-color="#e2772b"/>
      </linearGradient>
      <!-- the sun about to break the limb: white heart, gold bloom, ember haze
           (orbit-site's stops, smoother than the sheet's three) -->
      <radialGradient id="sun-core" cx="50%" cy="50%" r="50%">
        <stop offset="0%" stop-color="#ffffff"/><stop offset="15%" stop-color="#fff6e2" stop-opacity=".9"/>
        <stop offset="30%" stop-color="#ffedc2" stop-opacity=".6"/><stop offset="45%" stop-color="#ffe9c4" stop-opacity=".34"/>
        <stop offset="60%" stop-color="#ffe4b8" stop-opacity=".16"/><stop offset="75%" stop-color="#ffe0b0" stop-opacity=".06"/>
        <stop offset="90%" stop-color="#ffe0b0" stop-opacity=".015"/><stop offset="100%" stop-color="#ffe0b0" stop-opacity="0"/>
      </radialGradient>
      <radialGradient id="sun-mid" cx="50%" cy="50%" r="50%">
        <stop offset="0%" stop-color="#f8c95e" stop-opacity=".55"/><stop offset="30%" stop-color="#f4c048" stop-opacity=".3"/>
        <stop offset="60%" stop-color="#f0b429" stop-opacity=".1"/><stop offset="82%" stop-color="#f0b429" stop-opacity=".025"/>
        <stop offset="100%" stop-color="#f0b429" stop-opacity="0"/>
      </radialGradient>
      <radialGradient id="sun-wide" cx="50%" cy="50%" r="50%">
        <stop offset="0%" stop-color="#e2772b" stop-opacity=".3"/>
        <stop offset="55%" stop-color="#c2571f" stop-opacity=".12"/>
        <stop offset="100%" stop-opacity="0"/>
      </radialGradient>
      <linearGradient id="skywash" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-opacity="0"/>
        <stop offset="62%" stop-color="#3d2a4d" stop-opacity=".12"/>
        <stop offset="86%" stop-color="#a2492a" stop-opacity=".2"/>
        <stop offset="100%" stop-color="#e2772b" stop-opacity=".26"/>
      </linearGradient>
    </defs>
    <g class="dawnlayer">
      <rect x="0" y="0" width="1600" height="1000" fill="url(#skywash)"/>
      <!-- the two swaying fans: the CSS rotation (flight.css) rides the picture -->
      <g class="rays">
        <image class="sway1" data-href="/flight/door/glow-sway1.webp" x="0" y="0" width="1600" height="1000" preserveAspectRatio="none"/>
        <image class="sway2" data-href="/flight/door/glow-sway2.webp" x="0" y="0" width="1600" height="1000" preserveAspectRatio="none"/>
      </g>
      <!-- the glows that breathe, breathing together as one layer, the
           zodiacal cone first, as orbit-site lays them (index.html:68) -->
      <g class="sunpt">
        <g class="sunpt-breathe">
          <image class="zodiacal" data-href="/flight/door/glow-zod.webp" x="0" y="0" width="1600" height="1000" preserveAspectRatio="none"/>
          <circle cx="800" cy="922" r="520" fill="url(#sun-wide)"/>
          <circle cx="800" cy="922" r="240" fill="url(#sun-mid)"/>
          <circle cx="800" cy="920" r="86" fill="url(#sun-core)"/>
          <image data-href="/flight/door/glow-sunpt.webp" x="0" y="0" width="1600" height="1000" preserveAspectRatio="none"/>
        </g>
      </g>
    </g>
    <!-- the planet: everything below the limb is night -->
    <circle cx="800" cy="3920" r="3000" fill="#04060e"/>
    <circle class="rim" cx="800" cy="3920" r="3000" fill="none" stroke="url(#rimg)"
            stroke-width="2.4" stroke-opacity=".85"/>
    <!-- the Earth itself, from orbit, as the sun comes up over it: before the
         light, and with it -->
    <g class="earth">
      <image class="pre" data-href="/flight/door/dawn-pre.webp" x="0" y="640" width="1600" height="360" preserveAspectRatio="none"/>
      <image class="up" data-href="/flight/door/dawn.webp" x="0" y="640" width="1600" height="360" preserveAspectRatio="none"/>
    </g>
  </svg></div>

  <!-- The 08-14 hero (§15, owner 2026-08-17), as orbit-site draws it since
       #1253: the ring --R wide (flight.css, `--R:min(400px,80vw,46svh)`, the
       glyph's own width; the ring in it is .72R), the word set plain inside it
       with no filled centre, the pill in the row under it. No ribbon, no
       footer. The 200-unit viewBox is the site's: a slim ring with a small
       body riding it, the planet on the ring at radius 72. The `runner` is the
       light that runs the ring while the dawn's first pieces come
       (body.loading); the ring's three circles carry pathLength so one dash
       draws them (draw-ring). -->
  <div class="loginchrome">
    <div class="lockup">
      <div class="glyph" id="login-glyph"><svg width="420" height="420" viewBox="0 0 200 200">
        <defs>
          <linearGradient id="ringlit" gradientUnits="userSpaceOnUse" x1="0" y1="26" x2="0" y2="174"><stop offset="0" stop-color="#6c76a0" stop-opacity=".6"/><stop offset=".5" stop-color="#aab2cf" stop-opacity=".85"/><stop offset=".86" stop-color="#ead2a4"/><stop offset="1" stop-color="#ffe2a8"/></linearGradient>
          <radialGradient id="disclit" cx="100" cy="100" r="72" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#03040a" stop-opacity=".55"/><stop offset=".8" stop-color="#05070f" stop-opacity=".35"/><stop offset="1" stop-color="#05070f" stop-opacity="0"/></radialGradient>
          <radialGradient id="discwarm" cx="100" cy="182" r="70" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#ffcf8a" stop-opacity=".16"/><stop offset="1" stop-color="#ffcf8a" stop-opacity="0"/></radialGradient>
          <linearGradient id="trail" gradientUnits="userSpaceOnUse" x1="46.5" y1="51.8" x2="163" y2="63.5"><stop offset="0" stop-color="#ffd68c" stop-opacity="0"/><stop offset=".46" stop-color="#ffd68c" stop-opacity=".08"/><stop offset="1" stop-color="#ffdea0" stop-opacity=".75"/></linearGradient>
        </defs>
        <g class="lux"><circle cx="100" cy="100" r="71" fill="url(#disclit)"/><circle cx="100" cy="100" r="71" fill="url(#discwarm)"/></g>
        <g class="lux"><circle class="ring" cx="100" cy="100" r="72" fill="none" stroke="url(#ringlit)" stroke-width="9" stroke-opacity=".05" pathLength="100"/>
        <circle class="ring" cx="100" cy="100" r="72" fill="none" stroke="url(#ringlit)" stroke-width="3.6" stroke-opacity=".12" pathLength="100"/></g>
        <circle class="ring" cx="100" cy="100" r="72" fill="none" stroke="url(#ringlit)" stroke-width="1.6" pathLength="100"/>
        <g class="tr"><path d="M46.5 51.8 A72 72 0 0 1 163 63.5" fill="none" stroke="url(#trail)" stroke-width="3.2" stroke-linecap="round"/><image class="world" href="/flight/door/planet-gold.webp" x="145" y="45.5" width="36" height="36"/></g></svg><i class="runner" aria-hidden="true"></i></div>
      <div class="name">orbit</div>
      <div class="gate-wrap">{@render children?.()}</div>
      <div class="state" role="status" aria-live="polite">
        <div class="state-primary">{statePrimary}</div>
        <div class="state-sub">{stateSub}</div>
      </div>
    </div>
  </div>
</div>
