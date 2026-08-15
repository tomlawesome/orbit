<script>
  import Grain from "$lib/Grain.svelte";
  import { onMount } from "svelte";
  import "./maintenance.css";
  import { mountTotalitySky } from "./sky.js";

  /**
   * Maintenance — totality (CON-15). An eclipse is the sky's own scheduled
   * downtime: the light goes out, briefly and predictably, then comes back.
   * The corona is only visible during totality, which is why a corona drawn on
   * a bright sun never worked. The moon's transit doubles as the progress bar
   * and the diamond ring is the service returning.
   *
   * Copy is three words, deliberately: "maintenance — back soon". The visual
   * carries the drama; the words state the fact.
   *
   * Built from design/family/maintenance.html and owned here from that point on.
   */
  onMount(mountTotalitySky);
</script>

<svelte:head>
  <link rel="stylesheet" href="/screens/family.css" />
  <title>Orbit — maintenance</title>
</svelte:head>

<div class="sky"><svg viewBox="0 0 1600 1000" preserveAspectRatio="xMidYMid slice">
  <defs>
    <radialGradient id="stargl" cx="50%" cy="50%" r="50%">
      <stop offset="0%" stop-color="#eef2ff" stop-opacity=".5"/>
      <stop offset="100%" stop-color="#eef2ff" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <g class="sky-drift-far" fill="#dfe6f7"><g id="farstars"></g><use href="#farstars" x="1600"/></g>
  <g class="sky-drift-near"><g id="nearstars"></g><use href="#nearstars" x="1600"/></g>
</svg></div>

<div class="world" style="position:fixed;inset:0;z-index:1"><svg viewBox="0 0 1600 1000" preserveAspectRatio="xMidYMid slice" style="width:100%;height:100%">
  <defs>
    <!-- totality sky: the eerie 360-degree sunset around the whole horizon -->
    <linearGradient id="duskband" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#e2772b" stop-opacity="0"/>
      <stop offset="55%" stop-color="#e2772b" stop-opacity=".1"/>
      <stop offset="85%" stop-color="#f0a35a" stop-opacity=".22"/>
      <stop offset="100%" stop-color="#ffd9a0" stop-opacity=".3"/>
    </linearGradient>
    <radialGradient id="cornerwarm" cx="50%" cy="100%" r="70%">
      <stop offset="0%" stop-color="#f0b429" stop-opacity=".2"/>
      <stop offset="60%" stop-color="#e2772b" stop-opacity=".07"/>
      <stop offset="100%" stop-opacity="0"/>
    </radialGradient>

    <!-- corona -->
    <radialGradient id="coronaIn" cx="50%" cy="50%" r="50%">
      <stop offset="38%" stop-color="#fff8ea" stop-opacity="0"/>
      <stop offset="41%" stop-color="#fff8ea" stop-opacity=".85"/>
      <stop offset="48%" stop-color="#ffedc8" stop-opacity=".4"/>
      <stop offset="62%" stop-color="#f5d9a0" stop-opacity=".12"/>
      <stop offset="100%" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="coronaWide" cx="50%" cy="50%" r="50%">
      <stop offset="24%" stop-color="#f7e8c8" stop-opacity=".3"/>
      <stop offset="55%" stop-color="#e8d4ae" stop-opacity=".1"/>
      <stop offset="100%" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="streamerFade" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0%" stop-color="#ffeec6" stop-opacity=".46"/>
      <stop offset="45%" stop-color="#f2dcae" stop-opacity=".15"/>
      <stop offset="100%" stop-opacity="0"/>
    </linearGradient>
    <radialGradient id="washg" cx="59.25%" cy="34.8%" r="85%">
      <stop offset="0%" stop-color="#ffffff"/>
      <stop offset="30%" stop-color="#fff6e0"/>
      <stop offset="70%" stop-color="#f8dca4" stop-opacity=".75"/>
      <stop offset="100%" stop-color="#e8b25e" stop-opacity=".45"/>
    </radialGradient>
    <radialGradient id="moonshade" cx="42%" cy="60%" r="75%">
      <stop offset="0%" stop-color="#0a0c13"/>
      <stop offset="70%" stop-color="#050609"/>
      <stop offset="100%" stop-color="#010203"/>
    </radialGradient>
    <radialGradient id="promg" cx="50%" cy="50%" r="50%">
      <stop offset="0%" stop-color="#ffb3a6" stop-opacity=".9"/>
      <stop offset="55%" stop-color="#ff7d92" stop-opacity=".5"/>
      <stop offset="100%" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="flareg" cx="50%" cy="50%" r="50%">
      <stop offset="0%" stop-color="#ffffff"/>
      <stop offset="18%" stop-color="#fff6e0" stop-opacity=".9"/>
      <stop offset="100%" stop-color="#ffd98a" stop-opacity="0"/>
    </radialGradient>

    <filter id="b2"><feGaussianBlur stdDeviation="2"/></filter>
    <filter id="b4"><feGaussianBlur stdDeviation="4"/></filter>
    <filter id="b9" x="-60%" y="-60%" width="220%" height="220%"><feGaussianBlur stdDeviation="9"/></filter>
    <filter id="b18" x="-80%" y="-80%" width="260%" height="260%"><feGaussianBlur stdDeviation="18"/></filter>
    <!-- entropy: turbulence-displaced streamer edges, then softened -->
    <filter id="rough" x="-40%" y="-40%" width="180%" height="180%">
      <feTurbulence type="fractalNoise" baseFrequency="0.011 0.019" numOctaves="3" seed="11" result="n"/>
      <feDisplacementMap in="SourceGraphic" in2="n" scale="34"/>
      <feGaussianBlur stdDeviation="5"/>
    </filter>
    <filter id="rough2" x="-40%" y="-40%" width="180%" height="180%">
      <feTurbulence type="fractalNoise" baseFrequency="0.02 0.008" numOctaves="3" seed="4" result="n"/>
      <feDisplacementMap in="SourceGraphic" in2="n" scale="26"/>
      <feGaussianBlur stdDeviation="2.5"/>
    </filter>

    <!-- one streamer petal, drawn once, placed many times -->
    <path id="petal" d="M 0 -26 C 150 -58, 330 -40, 560 -10 C 330 22, 150 34, 0 26 Z"/>
    <path id="petalLong" d="M 0 -20 C 210 -66, 430 -52, 700 -6 C 430 30, 210 40, 0 20 Z"/>
    <path id="wisp" d="M 0 -8 C 160 -30, 300 -22, 430 -2 C 300 12, 160 16, 0 8 Z"/>
  </defs>

  <!-- horizon: sunset in every direction -->
  <g class="horizon">
    <rect x="0" y="700" width="1600" height="300" fill="url(#duskband)"/>
    <ellipse cx="120" cy="1010" rx="560" ry="230" fill="url(#cornerwarm)" filter="url(#b18)"/>
    <ellipse cx="1480" cy="1010" rx="560" ry="230" fill="url(#cornerwarm)" filter="url(#b18)"/>
    <ellipse cx="800" cy="1030" rx="900" ry="200" fill="url(#cornerwarm)" filter="url(#b18)" opacity=".8"/>
  </g>

  <!-- wide corona haze -->
  <g class="corona-wide">
    <ellipse cx="800" cy="440" rx="760" ry="330" fill="url(#coronaWide)"/>
    <circle cx="800" cy="440" r="430" fill="url(#coronaIn)"/>
  </g>

  <!-- streamers: pulled long at the equator, brushed short at the poles -->
  <g class="streamers-a" filter="url(#rough)" fill="url(#streamerFade)">
    <use href="#petalLong" transform="translate(800 440) rotate(4) translate(150 0)"/>
    <use href="#petal"     transform="translate(800 440) rotate(-19) translate(152 0) scale(.9)"/>
    <use href="#petalLong" transform="translate(800 440) rotate(168) translate(150 0) scale(1.06)"/>
    <use href="#petal"     transform="translate(800 440) rotate(196) translate(152 0) scale(.84)"/>
    <use href="#petal"     transform="translate(800 440) rotate(24) translate(150 0) scale(.62)"/>
    <use href="#petal"     transform="translate(800 440) rotate(149) translate(150 0) scale(.58)"/>
  </g>
  <g class="streamers-b" filter="url(#rough2)" fill="url(#streamerFade)" opacity=".8">
    <use href="#wisp" transform="translate(800 440) rotate(-8) translate(158 0) scale(1.15)"/>
    <use href="#wisp" transform="translate(800 440) rotate(13) translate(158 0)"/>
    <use href="#wisp" transform="translate(800 440) rotate(186) translate(158 0) scale(1.2)"/>
    <use href="#wisp" transform="translate(800 440) rotate(160) translate(158 0) scale(.9)"/>
    <use href="#wisp" transform="translate(800 440) rotate(-38) translate(154 0) scale(.55)"/>
    <use href="#wisp" transform="translate(800 440) rotate(212) translate(154 0) scale(.5)"/>
    <use href="#wisp" transform="translate(800 440) rotate(31) translate(156 0) scale(.72)"/>
    <use href="#wisp" transform="translate(800 440) rotate(174) translate(156 0) scale(.66)"/>
    <use href="#petal" transform="translate(800 440) rotate(-9) translate(150 0) scale(.45)"/>
    <use href="#petal" transform="translate(800 440) rotate(190) translate(150 0) scale(.4)"/>
  </g>

  <!-- fine filaments and polar brushes: the iron-filing structure -->
  <g class="filaments" stroke="#f4e6c6" fill="none" filter="url(#b2)">
    <path d="M 962 420 C 1120 396, 1260 400, 1420 428" stroke-width="1.1" opacity=".2"/>
    <path d="M 964 452 C 1130 470, 1280 476, 1450 460" stroke-width="1" opacity=".16"/>
    <path d="M 960 478 C 1100 508, 1230 520, 1330 540" stroke-width=".9" opacity=".12"/>
    <path d="M 638 424 C 480 400, 340 402, 180 432" stroke-width="1.1" opacity=".2"/>
    <path d="M 636 456 C 470 476, 320 480, 160 462" stroke-width="1" opacity=".15"/>
    <path d="M 642 486 C 500 514, 380 524, 290 546" stroke-width=".9" opacity=".12"/>
    <g stroke-width=".9">
      <path d="M 782 272 C 776 210, 770 160, 758 96" opacity=".15"/>
      <path d="M 800 268 C 800 200, 802 150, 804 84" opacity=".18"/>
      <path d="M 818 272 C 826 208, 834 158, 846 100" opacity=".15"/>
      <path d="M 764 278 C 748 224, 734 180, 712 128" opacity=".11"/>
      <path d="M 836 278 C 854 222, 868 178, 892 124" opacity=".11"/>
      <path d="M 784 608 C 776 664, 768 710, 754 768" opacity=".14"/>
      <path d="M 802 612 C 802 676, 804 724, 806 788" opacity=".17"/>
      <path d="M 820 608 C 830 668, 840 714, 854 770" opacity=".14"/>
      <path d="M 762 602 C 746 652, 732 694, 710 744" opacity=".1"/>
      <path d="M 838 602 C 858 654, 872 696, 896 748" opacity=".1"/>
    </g>
  </g>

  <!-- prominences: pink fire at the limb, behind the moon's edge -->
  <g filter="url(#b4)">
    <circle class="prom"    cx="678" cy="330" r="17" fill="url(#promg)"/>
    <circle class="prom p2" cx="948" cy="512" r="21" fill="url(#promg)"/>
    <circle class="prom p3" cx="742" cy="600" r="13" fill="url(#promg)"/>
    <path class="prom p2" d="M 930 350 q 26 -30 44 -2 q -18 -14 -30 6 Z" fill="#ff9d9d" opacity=".6"/>
    <circle class="prom p3" cx="636" cy="470" r="15" fill="url(#promg)"/>
    <path class="prom" d="M 662 556 q -30 22 -12 44 q 2 -22 22 -30 Z" fill="#ff8fa8" opacity=".5"/>
  </g>

  <!-- the moon: black, with the faintest earthshine mottle -->
  <circle cx="800" cy="440" r="170" fill="url(#moonshade)"/>

  <!-- chromosphere + photon ring -->
  <circle cx="800" cy="440" r="170" fill="none" stroke="#ffb46a" stroke-width="7" opacity=".22" filter="url(#b9)"/>
  <circle class="ring-inner" cx="800" cy="440" r="170" fill="none" stroke="#ffe9bd" stroke-width="3.2" opacity=".8" filter="url(#b2)"/>
  <circle cx="800" cy="440" r="170" fill="none" stroke="#fffdf6" stroke-width="1.2" opacity=".95"/>

  <!-- transit is the progress bar -->
  <circle class="progress" pathLength="100" cx="800" cy="440" r="186" fill="none"
          stroke="var(--accent)" stroke-width="1.5" stroke-linecap="round" opacity=".5"
          transform="rotate(-90 800 440)"/>

  <!-- the diamond ring: service returning (demo loops) -->
  <g class="flare">
    <circle cx="948" cy="348" r="230" fill="url(#flareg)"/>
    <circle cx="948" cy="348" r="60" fill="url(#flareg)"/>
    <!-- anamorphic streak with chromatic fringes -->
    <ellipse cx="948" cy="348" rx="330" ry="7" fill="#ffd98a" opacity=".5" filter="url(#b9)"/>
    <ellipse cx="948" cy="345" rx="290" ry="4" fill="#ff9a5e" opacity=".35" filter="url(#b4)"/>
    <ellipse cx="948" cy="351" rx="290" ry="4" fill="#9ec5ff" opacity=".3" filter="url(#b4)"/>
    <ellipse cx="948" cy="348" rx="190" ry="2.4" fill="#fffdf6" opacity=".95" filter="url(#b2)"/>
    <!-- six-point glint -->
    <g stroke="#fff6e0" stroke-linecap="round">
      <path d="M 948 178 L 948 518" stroke-width="2.2" opacity=".75"/>
      <path d="M 878 244 L 1018 452" stroke-width="1.1" opacity=".45"/>
      <path d="M 1018 244 L 878 452" stroke-width="1.1" opacity=".45"/>
    </g>
    <circle cx="948" cy="348" r="9" fill="#ffffff"/>
    <circle cx="948" cy="348" r="16" fill="none" stroke="#ffffff" stroke-width="1" opacity=".55" filter="url(#b2)"/>
  </g>
  <circle class="flarewave" cx="948" cy="348" r="30" fill="none" stroke="#ffe9bd" stroke-width="2"/>
  <circle class="ringflare" cx="800" cy="440" r="170" fill="none" stroke="#ffffff" stroke-width="3.4"/>
  <rect class="wash" x="0" y="0" width="1600" height="1000" fill="url(#washg)"/>
</svg></div>

<div class="msg">maintenance — back soon</div>

<Grain slope={0.09} />

<div class="vignette" style="background:radial-gradient(ellipse at 50% 44%,transparent 46%,rgba(0,0,0,.42) 100%)"></div>
