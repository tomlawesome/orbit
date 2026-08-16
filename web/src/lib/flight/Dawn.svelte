<script>
  import { DAWN_FAR, DAWN_NEAR } from "./starfields.js";

  /**
   * THE DAWN — the sky the launch leaves from, and the sign-in's own surface.
   * Markup verbatim from design/v19/first-run.html at 159ec9f (which carries
   * design/family/login.html's world across): the skywash, the zodiacal cone,
   * the two swaying fans of crepuscular rays, the scattering rings hugging the
   * limb, the point of first light, and the night side below it.
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
   */
  let { children = undefined, shown = false } = $props();
</script>

<div id="dawn" class:shown>
  <div class="sky" aria-hidden="true"><svg viewBox="0 0 1600 1000" preserveAspectRatio="xMidYMid slice">
    <g class="far" fill="#e9edf8"><g id="lg-far">
      {#each DAWN_FAR as s, i (i)}
        {#if s.delay}<circle class="tw" style="animation-delay:{s.delay}s" cx={s.cx} cy={s.cy} r={s.r} opacity={s.opacity}/>
        {:else}<circle cx={s.cx} cy={s.cy} r={s.r} opacity={s.opacity}/>{/if}
      {/each}
    </g><use href="#lg-far" x="1600"/></g>
    <g class="near" fill="#f4f0ff"><g id="lg-near">
      {#each DAWN_NEAR as s, i (i)}
        <circle cx={s.cx} cy={s.cy} r={s.r} opacity={s.opacity}/>
      {/each}
    </g><use href="#lg-near" x="1600"/></g>
  </svg></div>
  <div class="world" aria-hidden="true"><svg viewBox="0 0 1600 1000" preserveAspectRatio="xMidYMid slice">
    <defs>
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
      <linearGradient id="skywash" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-opacity="0"/>
        <stop offset="62%" stop-color="#3d2a4d" stop-opacity=".12"/>
        <stop offset="86%" stop-color="#a2492a" stop-opacity=".2"/>
        <stop offset="100%" stop-color="#e2772b" stop-opacity=".26"/>
      </linearGradient>
      <filter id="b2l"><feGaussianBlur stdDeviation="2"/></filter>
      <filter id="b6l"><feGaussianBlur stdDeviation="6"/></filter>
      <filter id="b12l" x="-40%" y="-40%" width="180%" height="180%"><feGaussianBlur stdDeviation="12"/></filter>
      <filter id="b20l" x="-60%" y="-60%" width="220%" height="220%"><feGaussianBlur stdDeviation="20"/></filter>
      <!-- entropy: rays are light through air, not vector wedges -->
      <filter id="rayrough" x="-30%" y="-30%" width="160%" height="160%">
        <feTurbulence type="fractalNoise" baseFrequency="0.004 0.03" numOctaves="2" seed="9" result="n"/>
        <feDisplacementMap in="SourceGraphic" in2="n" scale="22"/>
        <feGaussianBlur stdDeviation="17"/>
      </filter>
    </defs>
    <g class="dawnlayer">
      <rect x="0" y="0" width="1600" height="1000" fill="url(#skywash)"/>
      <ellipse class="zodiacal" cx="800" cy="640" rx="300" ry="480" fill="url(#zod)" filter="url(#b20l)"/>
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
      <g class="scatter">
        <circle cx="800" cy="3920" r="3122" fill="none" stroke="#7a2c18" stroke-opacity=".1" stroke-width="150" filter="url(#b20l)"/>
        <circle cx="800" cy="3920" r="3060" fill="none" stroke="#e2772b" stroke-opacity=".16" stroke-width="84" filter="url(#b20l)"/>
        <circle cx="800" cy="3920" r="3026" fill="none" stroke="#f0b429" stroke-opacity=".28" stroke-width="34" filter="url(#b12l)"/>
        <circle cx="800" cy="3920" r="3010" fill="none" stroke="#ffd989" stroke-opacity=".4" stroke-width="12" filter="url(#b6l)"/>
        <circle cx="800" cy="3920" r="3003" fill="none" stroke="#fff3d6" stroke-opacity=".65" stroke-width="4" filter="url(#b2l)"/>
      </g>
      <g class="sunpt">
        <g class="sunpt-breathe">
          <circle cx="800" cy="922" r="520" fill="url(#sun-wide)"/>
          <circle cx="800" cy="922" r="240" fill="url(#sun-mid)"/>
          <circle cx="800" cy="920" r="86" fill="url(#sun-core)"/>
          <circle cx="800" cy="919" r="20" fill="#fffdf6" filter="url(#b6l)"/>
        </g>
        <path d="M 560 934 A 3000 3000 0 0 1 1040 934" fill="none" stroke="#ffedc2"
              stroke-width="3" stroke-linecap="round" opacity=".7" filter="url(#b2l)"/>
      </g>
    </g>
    <!-- the planet: everything below the limb is night -->
    <circle cx="800" cy="3920" r="3000" fill="#04060e"/>
    <circle cx="800" cy="3920" r="3000" fill="none" stroke="url(#rimg)"
            stroke-width="6" stroke-opacity=".35" filter="url(#b6l)" class="rim"/>
    <circle class="rim" cx="800" cy="3920" r="3000" fill="none" stroke="url(#rimg)"
            stroke-width="2.4" stroke-opacity=".85"/>
    <circle class="shimmer" pathLength="100" cx="800" cy="3920" r="3000" fill="none"
            stroke="#fff6e6" stroke-width="3.4" stroke-linecap="round"/>
  </svg></div>

  <div class="loginchrome">
    <div class="lockup">
      <div class="glyph" id="login-glyph"><svg width="64" height="64" viewBox="0 0 200 200">
        <circle cx="100" cy="100" r="72" fill="none" stroke="#8791b3" stroke-width="9"/>
        <circle cx="163" cy="63.5" r="20" fill="#d8b45a"/></svg></div>
      <div class="name">orbit</div>
    </div>
    <div class="gate-wrap">{@render children?.()}</div>
    <div class="below">PRIVATE &middot; SELF-HOSTED &middot; YOURS</div>
  </div>
</div>
