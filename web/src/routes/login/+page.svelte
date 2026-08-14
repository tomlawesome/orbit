<script>
  import { onMount } from "svelte";
  import "./login.css";

  /**
   * The sign-in screen. Built from design/family/login.html (issue #399) and
   * owned here from that point on — the mockup was the input to this file, not
   * a live dependency of it. Changes are made here and judged in the running
   * app, per the owner's process: mock up, evaluate, build, test, iterate.
   *
   * No wrapper element scopes these lookups. The CSS is authored against
   * children of <body> (`.stage{height:100%}`, the fixed `.gate-wrap`), and
   * introducing a positioned wrapper to satisfy the framework would change the
   * layout the design specifies.
   */
  onMount(() => {
    /* first light: the dawn breaks once on load (CON-9, POL-13) */
    let timer;
    const frame = requestAnimationFrame(() => {
      timer = setTimeout(() => document.body.classList.add("lit"), 180);
    });

    /*
     * The design draws a <button>, so it stays a button and navigates on
     * click. GET /api/auth/login seals the login transaction and redirects to
     * the identity provider.
     *
     */
    const gate = document.querySelector("button.gate");
    let leaving = false;
    const signIn = () => {
      if (leaving) return;
      leaving = true;
      window.location.href = "/api/auth/login";
    };
    gate?.addEventListener("click", signIn);

    return () => {
      cancelAnimationFrame(frame);
      clearTimeout(timer);
      gate?.removeEventListener("click", signIn);
      document.body.classList.remove("lit");
    };
  });
</script>

<svelte:head>
  <link rel="stylesheet" href="/screens/family.css" />
  <title>Orbit — sign in</title>
</svelte:head>

<div class="sky"><svg viewBox="0 0 1600 1000" preserveAspectRatio="xMidYMid slice">
<g class="far" fill="#e9edf8"><g id="lg-fartile"><circle class="tw" style="animation-delay:3.9s" cx="1265.7" cy="832.5" r="0.84" opacity="0.14"/>
      <circle cx="1141.9" cy="658.3" r="0.75" opacity="0.31"/>
      <circle cx="903.2" cy="721.6" r="0.42" opacity="0.27"/>
      <circle cx="1019.8" cy="902.8" r="0.66" opacity="0.17"/>
      <circle cx="1527.3" cy="230.7" r="0.69" opacity="0.29"/>
      <circle cx="1598.4" cy="366.3" r="0.78" opacity="0.29"/>
      <circle class="tw" style="animation-delay:5.2s" cx="182.8" cy="925.9" r="0.44" opacity="0.32"/>
      <circle cx="806.9" cy="798.2" r="0.45" opacity="0.11"/>
      <circle cx="469.2" cy="234.3" r="0.64" opacity="0.33"/>
      <circle cx="973.0" cy="655.9" r="0.72" opacity="0.1"/>
      <circle cx="896.2" cy="414.1" r="0.57" opacity="0.17"/>
      <circle cx="611.7" cy="548.2" r="0.68" opacity="0.14"/>
      <circle class="tw" style="animation-delay:1.9s" cx="178.4" cy="746.3" r="0.57" opacity="0.3"/>
      <circle cx="708.5" cy="701.4" r="0.58" opacity="0.24"/>
      <circle cx="1573.0" cy="73.3" r="0.74" opacity="0.29"/>
      <circle cx="1527.6" cy="953.0" r="0.55" opacity="0.19"/>
      <circle cx="738.5" cy="659.6" r="0.52" opacity="0.16"/>
      <circle cx="612.1" cy="338.8" r="0.63" opacity="0.22"/>
      <circle class="tw" style="animation-delay:0.4s" cx="1086.5" cy="775.6" r="0.74" opacity="0.29"/>
      <circle cx="1188.2" cy="437.2" r="0.67" opacity="0.28"/>
      <circle cx="790.7" cy="219.0" r="0.69" opacity="0.17"/>
      <circle cx="630.1" cy="611.3" r="0.67" opacity="0.15"/>
      <circle cx="648.0" cy="24.9" r="0.61" opacity="0.34"/>
      <circle cx="1094.2" cy="200.6" r="0.69" opacity="0.26"/>
      <circle class="tw" style="animation-delay:5.3s" cx="1102.5" cy="636.8" r="0.46" opacity="0.32"/>
      <circle cx="217.6" cy="623.6" r="0.43" opacity="0.13"/>
      <circle cx="1031.4" cy="657.8" r="0.69" opacity="0.21"/>
      <circle cx="1539.9" cy="999.4" r="0.51" opacity="0.22"/>
      <circle cx="549.4" cy="224.0" r="0.85" opacity="0.35"/>
      <circle cx="161.2" cy="344.3" r="0.87" opacity="0.33"/>
      <circle class="tw" style="animation-delay:3.8s" cx="1172.0" cy="505.2" r="0.77" opacity="0.3"/>
      <circle cx="1360.2" cy="971.4" r="0.47" opacity="0.14"/>
      <circle cx="973.4" cy="394.8" r="0.78" opacity="0.32"/>
      <circle cx="385.1" cy="126.4" r="0.51" opacity="0.11"/>
      <circle cx="1126.5" cy="561.2" r="0.67" opacity="0.35"/>
      <circle cx="330.7" cy="925.3" r="0.8" opacity="0.21"/>
      <circle class="tw" style="animation-delay:4.4s" cx="318.1" cy="991.0" r="0.86" opacity="0.15"/>
      <circle cx="783.9" cy="599.4" r="0.75" opacity="0.32"/>
      <circle cx="227.9" cy="752.4" r="0.51" opacity="0.14"/>
      <circle cx="83.8" cy="107.2" r="0.63" opacity="0.24"/>
      <circle cx="1016.4" cy="332.8" r="0.72" opacity="0.33"/>
      <circle cx="862.6" cy="425.1" r="0.41" opacity="0.15"/>
      <circle class="tw" style="animation-delay:2.6s" cx="1478.7" cy="648.2" r="0.69" opacity="0.22"/>
      <circle cx="440.6" cy="871.5" r="0.42" opacity="0.15"/>
      <circle cx="751.6" cy="606.3" r="0.69" opacity="0.32"/>
      <circle cx="1085.0" cy="549.6" r="0.74" opacity="0.15"/>
      <circle cx="954.6" cy="551.2" r="0.81" opacity="0.31"/>
      <circle cx="1361.4" cy="326.3" r="0.77" opacity="0.32"/>
      <circle class="tw" style="animation-delay:0.9s" cx="825.0" cy="298.7" r="0.8" opacity="0.25"/>
      <circle cx="1319.5" cy="641.3" r="0.57" opacity="0.11"/>
      <circle cx="1433.5" cy="430.8" r="0.43" opacity="0.11"/>
      <circle cx="399.9" cy="456.1" r="0.74" opacity="0.18"/>
      <circle cx="1137.3" cy="474.5" r="0.56" opacity="0.25"/>
      <circle cx="292.5" cy="899.5" r="0.41" opacity="0.28"/>
      <circle class="tw" style="animation-delay:1.1s" cx="1587.9" cy="644.7" r="0.79" opacity="0.33"/>
      <circle cx="46.7" cy="667.2" r="0.81" opacity="0.18"/>
      <circle cx="1140.6" cy="315.7" r="0.42" opacity="0.22"/>
      <circle cx="899.1" cy="360.9" r="0.46" opacity="0.29"/>
      <circle cx="1259.3" cy="537.3" r="0.65" opacity="0.13"/>
      <circle cx="691.9" cy="629.7" r="0.83" opacity="0.29"/>
      <circle class="tw" style="animation-delay:2.9s" cx="1369.5" cy="204.4" r="0.69" opacity="0.11"/>
      <circle cx="438.1" cy="22.0" r="0.46" opacity="0.28"/>
      <circle cx="589.3" cy="529.8" r="0.47" opacity="0.22"/>
      <circle cx="390.8" cy="889.8" r="0.59" opacity="0.26"/>
      <circle cx="427.3" cy="730.3" r="0.76" opacity="0.27"/>
      <circle cx="7.3" cy="684.0" r="0.85" opacity="0.35"/>
      <circle class="tw" style="animation-delay:3.0s" cx="1076.7" cy="24.7" r="0.82" opacity="0.31"/>
      <circle cx="504.2" cy="417.0" r="0.76" opacity="0.33"/>
      <circle cx="1337.4" cy="923.0" r="0.56" opacity="0.32"/>
      <circle cx="44.2" cy="259.9" r="0.87" opacity="0.29"/>
      <circle cx="430.1" cy="243.1" r="0.76" opacity="0.32"/>
      <circle cx="748.4" cy="750.6" r="0.55" opacity="0.33"/>
      <circle class="tw" style="animation-delay:2.9s" cx="204.3" cy="298.3" r="0.76" opacity="0.12"/>
      <circle cx="785.3" cy="541.5" r="0.68" opacity="0.24"/>
      <circle cx="1391.4" cy="727.7" r="0.78" opacity="0.24"/>
      <circle cx="1214.2" cy="381.6" r="0.73" opacity="0.32"/>
      <circle cx="777.8" cy="643.2" r="0.58" opacity="0.28"/>
      <circle cx="122.6" cy="434.0" r="0.72" opacity="0.26"/>
      <circle class="tw" style="animation-delay:5.4s" cx="430.4" cy="306.2" r="0.64" opacity="0.24"/>
      <circle cx="1442.1" cy="554.2" r="0.5" opacity="0.3"/>
      <circle cx="438.6" cy="375.1" r="0.63" opacity="0.1"/>
      <circle cx="666.7" cy="991.7" r="0.42" opacity="0.15"/>
      <circle cx="909.9" cy="990.4" r="0.83" opacity="0.13"/>
      <circle cx="1416.5" cy="30.6" r="0.56" opacity="0.22"/>
      <circle class="tw" style="animation-delay:4.9s" cx="1184.5" cy="476.3" r="0.54" opacity="0.15"/>
      <circle cx="546.0" cy="531.1" r="0.65" opacity="0.27"/>
      <circle cx="167.5" cy="514.2" r="0.8" opacity="0.12"/>
      <circle cx="892.8" cy="454.5" r="0.76" opacity="0.27"/>
      <circle cx="508.4" cy="709.4" r="0.65" opacity="0.19"/>
      <circle cx="1265.3" cy="178.5" r="0.4" opacity="0.21"/>
      <circle class="tw" style="animation-delay:5.2s" cx="742.6" cy="104.4" r="0.43" opacity="0.28"/>
      <circle cx="33.8" cy="896.7" r="0.41" opacity="0.28"/>
      <circle cx="1038.7" cy="250.2" r="0.77" opacity="0.14"/>
      <circle cx="1202.6" cy="379.1" r="0.71" opacity="0.15"/>
      <circle cx="163.8" cy="895.8" r="0.64" opacity="0.17"/>
      <circle cx="160.2" cy="95.5" r="0.6" opacity="0.12"/>
      <circle class="tw" style="animation-delay:5.6s" cx="175.8" cy="488.8" r="0.75" opacity="0.2"/>
      <circle cx="733.8" cy="520.4" r="0.72" opacity="0.23"/>
      <circle cx="1299.9" cy="224.0" r="0.55" opacity="0.22"/>
      <circle cx="1308.9" cy="946.7" r="0.57" opacity="0.29"/></g><use href="#lg-fartile" x="1600"/></g>
<g class="near" fill="#f4f0ff"><g id="lg-neartile"><circle cx="584.1" cy="212.4" r="1.5" opacity="0.63"/>
      <circle cx="781.6" cy="127.5" r="1.14" opacity="0.35"/>
      <circle cx="693.5" cy="882.3" r="0.84" opacity="0.66"/>
      <circle cx="560.9" cy="836.7" r="1.01" opacity="0.47"/>
      <circle cx="298.7" cy="892.8" r="1.05" opacity="0.68"/>
      <circle cx="1561.9" cy="908.3" r="0.93" opacity="0.57"/>
      <circle cx="1524.8" cy="852.0" r="1.27" opacity="0.42"/>
      <circle cx="892.3" cy="469.9" r="1.45" opacity="0.62"/>
      <circle cx="259.2" cy="741.4" r="1.38" opacity="0.58"/>
      <circle cx="1076.7" cy="180.6" r="1.19" opacity="0.49"/>
      <circle cx="610.5" cy="531.3" r="0.98" opacity="0.7"/>
      <circle cx="591.2" cy="965.7" r="1.02" opacity="0.55"/>
      <circle cx="851.2" cy="287.1" r="1.07" opacity="0.62"/>
      <circle cx="910.5" cy="427.6" r="0.99" opacity="0.64"/>
      <circle cx="900.4" cy="859.7" r="1.12" opacity="0.41"/>
      <circle cx="557.9" cy="14.1" r="1.2" opacity="0.4"/>
      <circle cx="1133.7" cy="38.5" r="1.25" opacity="0.59"/>
      <circle cx="1019.0" cy="16.0" r="1.07" opacity="0.43"/>
      <circle cx="174.7" cy="983.8" r="1.59" opacity="0.55"/>
      <circle cx="1276.3" cy="568.7" r="1.34" opacity="0.5"/>
      <circle cx="280.3" cy="943.7" r="0.96" opacity="0.54"/>
      <circle cx="1562.2" cy="991.4" r="1.09" opacity="0.55"/>
      <circle cx="559.0" cy="211.1" r="1.43" opacity="0.59"/>
      <circle cx="1077.2" cy="863.0" r="1.17" opacity="0.41"/>
      <circle cx="1249.9" cy="204.3" r="1.43" opacity="0.64"/>
      <circle cx="534.1" cy="236.7" r="1.56" opacity="0.49"/>
      <circle cx="1009.8" cy="705.0" r="1.37" opacity="0.45"/>
      <circle cx="1051.7" cy="156.5" r="1.56" opacity="0.64"/>
      <circle cx="0.6" cy="333.9" r="1.35" opacity="0.5"/>
      <circle cx="1391.9" cy="343.3" r="0.98" opacity="0.4"/>
      <circle cx="613.1" cy="152.8" r="0.96" opacity="0.49"/>
      <circle cx="1474.9" cy="526.2" r="1.07" opacity="0.52"/>
      <circle cx="1542.8" cy="596.4" r="0.83" opacity="0.48"/>
      <circle cx="1255.8" cy="126.9" r="0.81" opacity="0.63"/>
      <circle cx="257.5" cy="573.9" r="0.98" opacity="0.39"/>
      <circle cx="908.4" cy="340.3" r="0.89" opacity="0.48"/>
      <circle cx="3.3" cy="597.8" r="1.58" opacity="0.35"/>
      <circle cx="1576.3" cy="363.6" r="1.37" opacity="0.38"/>
      <circle cx="1032.9" cy="562.8" r="1.02" opacity="0.67"/>
      <circle cx="611.2" cy="897.8" r="1.28" opacity="0.69"/>
      <circle cx="694.2" cy="963.8" r="1.35" opacity="0.66"/>
      <circle cx="211.3" cy="896.9" r="1.58" opacity="0.58"/>
      <circle cx="1387.1" cy="450.4" r="0.86" opacity="0.61"/>
      <circle cx="428.7" cy="438.0" r="0.89" opacity="0.45"/></g><use href="#lg-neartile" x="1600"/></g></svg></div>
<div class="world"><svg viewBox="0 0 1600 1000" preserveAspectRatio="xMidYMid slice">
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

  <!-- dawn light behind the limb -->
  <g class="dawnlayer">
    <!-- the sky itself warms toward the horizon -->
    <rect x="0" y="0" width="1600" height="1000" fill="url(#skywash)"/>
    <!-- zodiacal light: a tall faint cone rising from the sunrise point -->
    <ellipse class="zodiacal" cx="800" cy="640" rx="300" ry="480" fill="url(#zod)" filter="url(#b20l)"/>

    <!-- crepuscular rays, two swaying fans out of phase -->
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

    <!-- atmospheric scattering hugging the limb: white heat to deep ember -->
    <g class="scatter">
      <circle cx="800" cy="3920" r="3122" fill="none" stroke="#7a2c18" stroke-opacity=".1" stroke-width="150" filter="url(#b20l)"/>
      <circle cx="800" cy="3920" r="3060" fill="none" stroke="#e2772b" stroke-opacity=".16" stroke-width="84" filter="url(#b20l)"/>
      <circle cx="800" cy="3920" r="3026" fill="none" stroke="#f0b429" stroke-opacity=".28" stroke-width="34" filter="url(#b12l)"/>
      <circle cx="800" cy="3920" r="3010" fill="none" stroke="#ffd989" stroke-opacity=".4" stroke-width="12" filter="url(#b6l)"/>
      <circle cx="800" cy="3920" r="3003" fill="none" stroke="#fff3d6" stroke-opacity=".65" stroke-width="4" filter="url(#b2l)"/>
    </g>

    <!-- the point of first light -->
    <g class="sunpt">
      <g class="sunpt-breathe">
        <circle cx="800" cy="922" r="520" fill="url(#sun-wide)"/>
        <circle cx="800" cy="922" r="240" fill="url(#sun-mid)"/>
        <circle cx="800" cy="920" r="86" fill="url(#sun-core)"/>
        <circle cx="800" cy="919" r="20" fill="#fffdf6" filter="url(#b6l)"/>
      </g>
      <!-- limb brightening either side of the point -->
      <path d="M 560 934 A 3000 3000 0 0 1 1040 934" fill="none" stroke="#ffedc2"
            stroke-width="3" stroke-linecap="round" opacity=".7" filter="url(#b2l)"/>
    </g>
  </g>

  <!-- the planet: everything below the limb is night -->
  <circle cx="800" cy="3920" r="3000" fill="#04060e"/>
  <!-- rim light + travelling shimmer -->
  <circle cx="800" cy="3920" r="3000" fill="none" stroke="url(#rimg)"
          stroke-width="6" stroke-opacity=".35" filter="url(#b6l)" class="rim"/>
  <circle class="rim" cx="800" cy="3920" r="3000" fill="none" stroke="url(#rimg)"
          stroke-width="2.4" stroke-opacity=".85"/>
  <circle class="shimmer" pathLength="100" cx="800" cy="3920" r="3000" fill="none"
          stroke="#fff6e6" stroke-width="3.4" stroke-linecap="round"/>
</svg></div>
<div class="stage"><div class="lockup">
  <!--
    Drawn for this size, not scaled up from the favicon geometry. The viewBox
    units are the same, so stroke-width and the planet radius are restated
    rather than inherited: at 420px the mark's original 9-unit stroke renders
    ~19px and its 20-unit planet an 84px disc, which reads as a heavy badge
    instead of a slim ring with a small body riding it. 2 units = ~4px of line,
    7 units = a ~29px planet. Position is unchanged — cx/cy still sit on the
    ring at radius 72.
  -->
  <div class="glyph"><svg width="420" height="420" viewBox="0 0 200 200"><circle cx="100" cy="100" r="72" fill="none" stroke="var(--ink-mid)" stroke-width="2"/><g class="tr"><circle cx="163" cy="63.5" r="7" style="fill:var(--accent)"/></g></svg></div>
  <div class="name">orbit</div>
  <!-- the ask lives inside the ring, directly beneath the name -->
  <div class="gate-wrap"><button class="gate">Sign in</button></div>
</div></div>
<svg class="grain" width="100%" height="100%"><filter id="gr">
  <feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2" stitchTiles="stitch"/>
  <feColorMatrix type="saturate" values="0"/>
  <feComponentTransfer><feFuncA type="linear" slope="0.08"/></feComponentTransfer>
  <feComposite operator="in" in2="SourceGraphic"/>
</filter><rect width="100%" height="100%" filter="url(#gr)"/></svg>
<div class="vignette"></div>
