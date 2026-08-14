<script>
  import { onMount } from "svelte";
  import "./logout.css";
  import { mountSunsetSky } from "./sky.js";

  /**
   * Sign-out — the sunset (CON-17). The same limb world as the sign-in
   * performing the day ending well: the sun sinks, the scattering cools
   * amber to ember to indigo, the stars come out and take over, an ember rim
   * holds. First light and sunset bookend every session.
   *
   * Built from design/family/logout.html and owned here from that point on.
   */
  onMount(() => {
    mountSunsetSky();

    /* the sunset runs once on load, as the dawn does on the sign-in */
    let timer;
    const frame = requestAnimationFrame(() => {
      timer = setTimeout(() => document.body.classList.add("set"), 180);
    });

    return () => {
      cancelAnimationFrame(frame);
      clearTimeout(timer);
      document.body.classList.remove("set");
    };
  });
</script>

<svelte:head>
  <link rel="stylesheet" href="/screens/family.css" />
  <title>Orbit — signed out</title>
</svelte:head>

<div class="sky"><svg viewBox="0 0 1600 1000" preserveAspectRatio="xMidYMid slice">
  <g id="starfield"></g>
</svg></div>
<div class="world"><svg viewBox="0 0 1600 1000" preserveAspectRatio="xMidYMid slice">
  <defs>
    <linearGradient id="rimg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#ffd989"/><stop offset="100%" stop-color="#e2772b"/>
    </linearGradient>
    <linearGradient id="rimg-ember" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#d9713a"/><stop offset="100%" stop-color="#3a1830"/>
    </linearGradient>
    <!-- the late sun, still warm, about to go down -->
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
    <linearGradient id="rayg" x1="0" y1="1" x2="0" y2="0">
      <stop offset="0%" stop-color="#ffe4a8" stop-opacity=".26"/>
      <stop offset="55%" stop-color="#f4c05a" stop-opacity=".07"/>
      <stop offset="100%" stop-opacity="0"/>
    </linearGradient>
    <radialGradient id="zod" cx="50%" cy="88%" r="75%">
      <stop offset="0%" stop-color="#f6d489" stop-opacity=".13"/>
      <stop offset="55%" stop-color="#e8b25e" stop-opacity=".045"/>
      <stop offset="100%" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="skywash-day" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-opacity="0"/>
      <stop offset="62%" stop-color="#3d2a4d" stop-opacity=".12"/>
      <stop offset="86%" stop-color="#a2492a" stop-opacity=".2"/>
      <stop offset="100%" stop-color="#e2772b" stop-opacity=".26"/>
    </linearGradient>
    <!-- night wash: deep indigo above, one last ember kiss right at the horizon -->
    <linearGradient id="skywash-night" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-opacity="0"/>
      <stop offset="55%" stop-color="#0d0a1e" stop-opacity=".3"/>
      <stop offset="80%" stop-color="#241128" stop-opacity=".4"/>
      <stop offset="100%" stop-color="#5c2414" stop-opacity=".32"/>
    </linearGradient>
    <filter id="b2l"><feGaussianBlur stdDeviation="2"/></filter>
    <filter id="b6l"><feGaussianBlur stdDeviation="6"/></filter>
    <filter id="b12l" x="-40%" y="-40%" width="180%" height="180%"><feGaussianBlur stdDeviation="12"/></filter>
    <filter id="b20l" x="-60%" y="-60%" width="220%" height="220%"><feGaussianBlur stdDeviation="20"/></filter>
    <filter id="rayrough" x="-30%" y="-30%" width="160%" height="160%">
      <feTurbulence type="fractalNoise" baseFrequency="0.004 0.03" numOctaves="2" seed="9" result="n"/>
      <feDisplacementMap in="SourceGraphic" in2="n" scale="22"/>
      <feGaussianBlur stdDeviation="17"/>
    </filter>
  </defs>

  <!-- day sky: late gold light, still up -->
  <rect class="skywash-day" x="0" y="0" width="1600" height="1000" fill="url(#skywash-day)"/>
  <g class="zodiacal-wrap">
    <ellipse class="zodiacal" cx="800" cy="640" rx="300" ry="480" fill="url(#zod)" filter="url(#b20l)"/>
  </g>

  <g class="rays">
    <g class="sway1" fill="url(#rayg)" filter="url(#rayrough)">
      <path d="M 800 924 L 736 356 L 772 362 Z"/>
      <path d="M 800 924 L 852 528 L 892 548 Z"/>
      <path d="M 800 924 L 508 620 L 556 588 Z"/>
      <path d="M 800 924 L 1096 448 L 1052 428 Z"/>
      <path d="M 800 924 L 320 690 L 360 646 Z" opacity=".8"/>
      <path d="M 800 924 L 1290 670 L 1244 630 Z" opacity=".8"/>
    </g>
    <g class="sway2" fill="url(#rayg)" filter="url(#rayrough)" opacity=".7">
      <path d="M 800 924 L 646 404 L 680 390 Z"/>
      <path d="M 800 924 L 962 560 L 928 544 Z"/>
      <path d="M 800 924 L 404 610 L 448 574 Z"/>
      <path d="M 800 924 L 1200 596 L 1156 562 Z"/>
    </g>
  </g>

  <!-- amber scattering hugging the limb, day tone -->
  <g class="scatter-day">
    <g class="scatter-day-breathe">
      <circle cx="800" cy="3920" r="3122" fill="none" stroke="#7a2c18" stroke-opacity=".1" stroke-width="150" filter="url(#b20l)"/>
      <circle cx="800" cy="3920" r="3060" fill="none" stroke="#e2772b" stroke-opacity=".16" stroke-width="84" filter="url(#b20l)"/>
      <circle cx="800" cy="3920" r="3026" fill="none" stroke="#f0b429" stroke-opacity=".28" stroke-width="34" filter="url(#b12l)"/>
      <circle cx="800" cy="3920" r="3010" fill="none" stroke="#ffd989" stroke-opacity=".4" stroke-width="12" filter="url(#b6l)"/>
      <circle cx="800" cy="3920" r="3003" fill="none" stroke="#fff3d6" stroke-opacity=".65" stroke-width="4" filter="url(#b2l)"/>
    </g>
  </g>

  <!-- the sun, still up, about to go down -->
  <g class="sunpt">
    <g class="sunpt-breathe">
      <circle cx="800" cy="862" r="520" fill="url(#sun-wide)"/>
      <circle cx="800" cy="862" r="240" fill="url(#sun-mid)"/>
      <circle cx="800" cy="860" r="86" fill="url(#sun-core)"/>
      <circle cx="800" cy="859" r="20" fill="#fffdf6" filter="url(#b6l)"/>
    </g>
    <path d="M 560 934 A 3000 3000 0 0 1 1040 934" fill="none" stroke="#ffedc2"
          stroke-width="3" stroke-linecap="round" opacity=".7" filter="url(#b2l)"/>
  </g>

  <!-- ember scattering hugging the limb, night tone: the after-glow that lingers -->
  <g class="scatter-night">
    <g class="scatter-night-breathe">
      <circle cx="800" cy="3920" r="3122" fill="none" stroke="#241238" stroke-opacity=".14" stroke-width="150" filter="url(#b20l)"/>
      <circle cx="800" cy="3920" r="3060" fill="none" stroke="#7a2c18" stroke-opacity=".22" stroke-width="84" filter="url(#b20l)"/>
      <circle cx="800" cy="3920" r="3026" fill="none" stroke="#b3441f" stroke-opacity=".32" stroke-width="34" filter="url(#b12l)"/>
      <circle cx="800" cy="3920" r="3010" fill="none" stroke="#e2772b" stroke-opacity=".4" stroke-width="12" filter="url(#b6l)"/>
      <circle cx="800" cy="3920" r="3003" fill="none" stroke="#f2a25a" stroke-opacity=".52" stroke-width="4" filter="url(#b2l)"/>
    </g>
  </g>

  <!-- night wash climbs over the day as the sky darkens -->
  <rect class="skywash-night" x="0" y="0" width="1600" height="1000" fill="url(#skywash-night)"/>

  <!-- the planet: everything below the limb is night, always -->
  <circle cx="800" cy="3920" r="3000" fill="#04060e"/>
  <!-- day rim: gold, fades out -->
  <circle class="rim-day" cx="800" cy="3920" r="3000" fill="none" stroke="url(#rimg)"
          stroke-width="6" stroke-opacity=".35" filter="url(#b6l)"/>
  <circle class="rim-day" cx="800" cy="3920" r="3000" fill="none" stroke="url(#rimg)"
          stroke-width="2.4" stroke-opacity=".85"/>
  <!-- ember rim: the cooling after-glow that stays -->
  <circle class="rim-ember" cx="800" cy="3920" r="3000" fill="none" stroke="url(#rimg-ember)"
          stroke-width="6" stroke-opacity=".3" filter="url(#b6l)"/>
  <circle class="rim-ember" cx="800" cy="3920" r="3000" fill="none" stroke="url(#rimg-ember)"
          stroke-width="2.2" stroke-opacity=".7"/>
  <circle class="shimmer-ember" pathLength="100" cx="800" cy="3920" r="3000" fill="none"
          stroke="#ffb37a" stroke-width="3" stroke-linecap="round"/>
</svg></div>
<div class="stage"><div class="lockup">
  <!--
    Drawn for this size, not scaled up from the favicon geometry: the mark's
    own 9-unit stroke and 20-unit planet render as a heavy badge at 420px.
    2 units = ~4px of line, 7 units = a ~29px planet. Position unchanged —
    the planet still sits on the ring at radius 72.
  -->
  <div class="glyph"><svg width="420" height="420" viewBox="0 0 200 200"><circle cx="100" cy="100" r="72" fill="none" stroke="var(--ink-mid)" stroke-width="2"/><g class="tr"><circle cx="163" cy="63.5" r="7" style="fill:var(--accent)"/></g></svg></div>
  <div class="name">orbit</div>
  <!-- the ask lives inside the ring, directly beneath the name -->
  <div class="gate-wrap"><a class="gate" href="/login">Sign in</a></div>
</div></div>
<svg class="grain" width="100%" height="100%"><filter id="gr">
  <feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2" stitchTiles="stitch"/>
  <feColorMatrix type="saturate" values="0"/>
  <feComponentTransfer><feFuncA type="linear" slope="0.08"/></feComponentTransfer>
  <feComposite operator="in" in2="SourceGraphic"/>
</filter><rect width="100%" height="100%" filter="url(#gr)"/></svg>
<div class="vignette"></div>
