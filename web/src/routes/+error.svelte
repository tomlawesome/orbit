<script>
  import Grain from "$lib/Grain.svelte";
  import { onMount } from "svelte";
  import { page } from "$app/state";
  import { resolve } from "$app/paths";
  import { mountGravityWell } from "./gravity-well.js";

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

  onMount(() => {
    if (isNotFound) mountGravityWell();
  });
</script>

<svelte:head>
  <link rel="stylesheet" href="/screens/family.css" />
  <link rel="stylesheet" href="/screens/notfound.css" />
  <title>{isNotFound ? "Orbit — off the chart" : `Orbit — ${page.status}`}</title>
</svelte:head>

{#if isNotFound}
<div class="sky"><svg viewBox="0 0 1600 1000" preserveAspectRatio="xMidYMid slice">
  <defs>
    <radialGradient id="stargl" cx="50%" cy="50%" r="50%">
      <stop offset="0%" stop-color="#e8edff" stop-opacity=".45"/>
      <stop offset="100%" stop-color="#e8edff" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <g class="sky-far" fill="#dbe2f5"><g id="farstars"></g><use href="#farstars" x="1600"/></g>
  <g class="sky-near"><g id="nearstars"></g><use href="#nearstars" x="1600"/></g>
</svg></div>

<div style="position:fixed;inset:0;z-index:1"><svg viewBox="0 0 1600 1000" preserveAspectRatio="xMidYMid slice" style="width:100%;height:100%">
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
    <!-- lensed starlight: stars behind the hole smeared into tangential arcs -->
    <g id="lensarcs" class="lensed" fill="none"></g>

    <!-- the far side of the disc, lensed into an arch OVER the hole (and a fainter one under) -->
    <g class="lensed">
      <path d="M 649 460 A 152 152 0 1 1 951 460" fill="none" stroke="url(#doppler)"
            stroke-width="17" stroke-linecap="round" filter="url(#b3)" opacity=".9"/>
      <path d="M 655 452 A 150 150 0 1 1 945 452" fill="none" stroke="#fff3d6"
            stroke-width="4" stroke-linecap="round" filter="url(#b1)" opacity=".75"/>
      <path d="M 668 508 A 140 140 0 0 0 932 508" fill="none" stroke="url(#doppler)"
            stroke-width="9" stroke-linecap="round" filter="url(#b3)" opacity=".5"/>
    </g>

    <!-- disc haze behind everything -->
    <ellipse cx="800" cy="452" rx="430" ry="96" fill="url(#doppler-soft)" filter="url(#b16)" opacity=".6"/>

    <!-- event horizon -->
    <circle cx="800" cy="450" r="112" fill="#000000"/>
    <!-- photon ring -->
    <circle class="photon" cx="800" cy="450" r="119" fill="none" stroke="#ff9a4a" stroke-width="7" opacity=".4" filter="url(#b6)"/>
    <circle class="photon" cx="800" cy="450" r="118" fill="none" stroke="#ffce8a" stroke-width="2.6" filter="url(#b1)"/>
    <circle class="photon-hot" cx="800" cy="450" r="117" fill="none" stroke="#fffaf0" stroke-width="1.1"/>

    <!-- the near side of the disc, crossing IN FRONT below the hole -->
    <g class="smear">
      <path d="M 452 452 A 348 62 0 0 0 1148 452" fill="none" stroke="url(#doppler-soft)"
            stroke-width="34" filter="url(#b6)"/>
    </g>
    <path d="M 452 452 A 348 62 0 0 0 1148 452" fill="none" stroke="url(#doppler)"
          stroke-width="13" filter="url(#hotrough)"/>
    <path d="M 470 458 A 346 58 0 0 0 1130 458" fill="none" stroke="#fff3d6"
          stroke-width="2.6" filter="url(#b1)" opacity=".8"/>
  </g>

  <!-- the outer 4: caught, but still itself -->
  <text x="505" y="512" text-anchor="middle" font-family="'Space Grotesk',sans-serif"
        font-weight="600" font-size="168" fill="url(#glyphg)"
        transform="rotate(-5 505 460)">4</text>

  <!-- the inner 4: mid-spaghettification, shearing toward the horizon -->
  <g>
    <!-- the glyph itself, stretched and tilted into the fall -->
    <g transform="translate(1092 460) rotate(8) skewX(-14) scale(1.24,.9)">
      <text x="0" y="52" text-anchor="middle" font-family="'Space Grotesk',sans-serif"
            font-weight="600" font-size="168" fill="#e8dcbc" opacity=".3" filter="url(#b6)"
            transform="scale(1.35,1)">4</text>
      <text x="0" y="52" text-anchor="middle" font-family="'Space Grotesk',sans-serif"
            font-weight="600" font-size="168" fill="url(#glyphg)">4</text>
    </g>
    <!-- the tidal stream: its substance drawn off into the photon ring -->
    <path class="smear" d="M 1030 448 C 985 442, 950 442, 916 446 L 916 470 C 950 468, 985 470, 1030 480 Z"
          fill="url(#streamg)" filter="url(#b3)"/>
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
