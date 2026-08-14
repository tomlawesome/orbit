<script>
  import { onMount } from "svelte";
  import { mountHome } from "./home.behaviour.js";
  import { GALAXY_FIXTURE } from "./galaxy.fixture.js";
  import Pocket from "./pocket.svelte";
  import { mountPocket } from "./pocket.behaviour.js";
  import "./home.css";

  /**
   * The home screen. Built from design/v19/home.html (issue #399) and owned
   * here from that point on.
   *
   * Svelte renders the markup and then stands back: mountHome() takes the
   * document and runs the chart, the galaxy and the drawers as the imperative
   * DOM code they were written as. See home.behaviour.js for why.
   *
   * Two dialects share this route (CON-10, #430): the desk chart below and the
   * pocket in pocket.svelte. Both are server-rendered and CSS chooses between
   * them, so there is no flash of the wrong one and no-JS still gets a page.
   * Only the visible dialect is mounted, because each binds window-level
   * listeners and the hidden one would be handling events against elements
   * with no layout.
   */
  const DESK = "(min-width: 901px)";

  onMount(() => {
    const query = window.matchMedia(DESK);
    let teardown = null;
    const sync = () => {
      teardown?.();
      /* Tear the old dialect down before standing the new one up. */
      teardown = query.matches ? mountHome({ galaxy: GALAXY_FIXTURE }) : mountPocket();
    };
    sync();
    query.addEventListener("change", sync);
    return () => {
      query.removeEventListener("change", sync);
      teardown?.();
    };
  });
</script>

<svelte:head>
  <title>Orbit</title>
</svelte:head>

<Pocket />

<div class="desk">
<div class="sky" aria-hidden="true">
  <svg viewBox="0 0 1600 1000" preserveAspectRatio="xMidYMid slice">
    <g id="cam-far" class="cam"><g class="far" fill="var(--star-far)"><g id="fartile"></g><use href="#fartile" x="1600"/></g></g>
    <g id="cam-near" class="cam"><g class="near" fill="var(--star-near)"><g id="neartile"></g><use href="#neartile" x="1600"/></g></g>
  </svg>
</div>
<div class="vignette" aria-hidden="true"></div>
<div class="meteor" style="top:12%;left:18%" aria-hidden="true" data-polish="POL-8"></div>
<div class="meteor m2" aria-hidden="true" data-polish="POL-8"></div>
<div class="meteor m3" aria-hidden="true" data-polish="POL-10"></div>

<button class="orb" aria-expanded="false" aria-controls="account" title="Menu">TL</button>
<div class="account" id="account" role="region" aria-label="Account and menu">
  <div class="who"><b>Tom Lawson</b><span id="who-role">Lawson Home · owner</span></div>
  <nav>
    <a href="#">Due next</a>
    <a href="#">Documents</a>
    <a href="#">Inbox</a>
    <a href="#">Settings</a>
    <a href="#">Administration</a>
  </nav>
  <div class="swatches" role="group" aria-label="Theme">
    <span>THEME</span>
    <button style="background:#070d1f" title="star-chart" aria-pressed="true"></button>
    <button style="background:#05070d" title="after dark" aria-pressed="false"></button>
    <button style="background:#c9bfa6" title="atlas" aria-pressed="false"></button>
    <button style="background:#c3ccdb" title="dawn" aria-pressed="false"></button>
    <button style="background:#080a14;box-shadow:inset 0 0 0 1px #ff4fd8" title="retrograde"
            aria-pressed="false"></button>
  </div>
  <button class="signout">sign out →</button>
</div>

<!-- CON-12: creation drawer — full width, from the top; the north star is its handle -->
<aside class="drawer-top" id="createdrawer" role="region" aria-label="Add to your orbit">
  <div class="inner">
    <h4>Add to your orbit</h4>
    <div class="ctypes">
      <button class="ctype"><span class="dot con"></span>renewal</button>
      <button class="ctype"><span class="dot"></span>service</button>
      <button class="ctype"><span class="dot ter"></span>inspection</button>
      <button class="ctype"><span class="dot" style="background:none;border:1.6px solid currentColor"></span>something else</button>
    </div>
    <div class="crow">
      <div class="cdrop">drop a document here — we'll read what we can</div>
      <a class="cfull" href="/create">open the full form →</a>
    </div>
  </div>
  <button class="nstar" id="nstar" aria-expanded="false" title="Add to your orbit">
    <svg width="30" height="30" viewBox="-15 -15 30 30" aria-hidden="true">
      <g class="glint" style="transform-origin:0 0">
        <circle r="9" fill="var(--ink)" opacity=".12"/>
        <path d="M 0 -12 L 1.7 -1.7 L 12 0 L 1.7 1.7 L 0 12 L -1.7 1.7 L -12 0 L -1.7 -1.7 Z"
              fill="var(--ink)" opacity=".9"/>
        <circle r="2" fill="var(--ink)"/>
      </g>
    </svg>
    <span>create</span>
  </button>
</aside>

<div class="scrim" aria-hidden="true"></div>
<div class="page">
    <div class="hero" id="hero">
    <!-- backdrop constellations are generated from the galaxy map -->
    <div class="dialwrap">
      <svg width="640" height="640" class="dial" viewBox="0 0 380 380" role="img"
         aria-label="Gravity well: items orbit by due date; distance from the household is time remaining, body size is typical cost; details in the manifest below">
      <defs>
        <filter id="soft" x="-60%" y="-60%" width="220%" height="220%">
          <feGaussianBlur stdDeviation="4"/>
        </filter>
        <filter id="sun" x="-200%" y="-200%" width="500%" height="500%">
          <feGaussianBlur stdDeviation="9"/>
        </filter>
        <radialGradient id="p-ruby" cx="34%" cy="30%" r="72%">
          <stop offset="0%" stop-color="var(--p-ruby-1, #ffb3ab)"/><stop offset="42%" stop-color="var(--p-ruby-2, #e0453e)"/>
          <stop offset="100%" stop-color="var(--p-ruby-3, #7e1a1f)"/>
        </radialGradient>
        <radialGradient id="p-jade" cx="34%" cy="30%" r="72%">
          <stop offset="0%" stop-color="var(--p-jade-1, #b8f5cf)"/><stop offset="45%" stop-color="var(--p-jade-2, #2fae6a)"/>
          <stop offset="100%" stop-color="var(--p-jade-3, #12603a)"/>
        </radialGradient>
        <radialGradient id="p-amber" cx="34%" cy="30%" r="72%">
          <stop offset="0%" stop-color="var(--p-amber-1, #ffe1a0)"/><stop offset="45%" stop-color="var(--p-amber-2, #f0a52b)"/>
          <stop offset="100%" stop-color="var(--p-amber-3, #8a5a10)"/>
        </radialGradient>
        <radialGradient id="p-sky" cx="34%" cy="30%" r="72%">
          <stop offset="0%" stop-color="var(--p-sky-1, #cfe4ff)"/><stop offset="45%" stop-color="var(--p-sky-2, #6fa3ef)"/>
          <stop offset="100%" stop-color="var(--p-sky-3, #2a4f8f)"/>
        </radialGradient>
        <radialGradient id="danger4" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stop-color="#f87171" stop-opacity=".10"/>
          <stop offset="55%" stop-color="#f87171" stop-opacity=".035"/>
          <stop offset="85%" stop-color="#f87171" stop-opacity="0"/>
        </radialGradient>
      </defs>

      <g class="chrome">
      <g class="celestial rotor">
        <g stroke="var(--chart-line-soft)" stroke-width=".5">
          <line x1="190" y1="14" x2="190" y2="34"/><line x1="314.5" y1="65.5" x2="300" y2="80"/>
          <line x1="366" y1="190" x2="346" y2="190"/><line x1="314.5" y1="314.5" x2="300" y2="300"/>
          <line x1="190" y1="366" x2="190" y2="346"/><line x1="65.5" y1="314.5" x2="80" y2="300"/>
          <line x1="14" y1="190" x2="34" y2="190"/><line x1="65.5" y1="65.5" x2="80" y2="80"/>
        </g>
        <circle cx="190" cy="190" r="168" fill="none" stroke="var(--chart-line-soft)" stroke-width=".5"/>
      </g>
      <g class="celestial">
        <polyline points="175.8,140 214.9,127.5 256.6,151.9" fill="none"
                  stroke="var(--accent)" stroke-opacity=".38" stroke-width="1"
                  stroke-dasharray="1 5" stroke-linecap="round"/>
      </g>

      <circle cx="190" cy="190" r="62" fill="url(#danger4)"/>
      <circle cx="190" cy="190" r="62" fill="none" stroke="var(--overdue)"
              stroke-opacity=".3" stroke-width="1" stroke-dasharray="3 5"/>
      <circle cx="190" cy="190" r="106" fill="none" stroke="var(--chart-line-soft)" stroke-width=".75"/>
      <circle cx="190" cy="190" r="150" fill="none" stroke="var(--chart-line)" stroke-width="1.5"/>

      <g stroke="var(--chart-line)" stroke-width="1.5">
        <line x1="190" y1="40" x2="190" y2="47"/><line x1="265" y1="60.1" x2="261.5" y2="66.2"/>
        <line x1="319.9" y1="115" x2="313.8" y2="118.5"/><line x1="340" y1="190" x2="333" y2="190"/>
        <line x1="319.9" y1="265" x2="313.8" y2="261.5"/><line x1="265" y1="319.9" x2="261.5" y2="313.8"/>
        <line x1="190" y1="340" x2="190" y2="333"/><line x1="115" y1="319.9" x2="118.5" y2="313.8"/>
        <line x1="60.1" y1="265" x2="66.2" y2="261.5"/><line x1="40" y1="190" x2="47" y2="190"/>
        <line x1="60.1" y1="115" x2="66.2" y2="118.5"/><line x1="115" y1="60.1" x2="118.5" y2="66.2"/>
      </g>
      <g font-size="9" fill="var(--chart-ink)" text-anchor="middle">
        <text x="190" y="31" class="now-month" data-polish="POL-3">AUG</text><text x="271" y="53">SEP</text>
        <text x="330" y="112">OCT</text><text x="352" y="194">NOV</text>
        <text x="330" y="274">DEC</text><text x="271" y="333">JAN</text>
        <text x="190" y="355">FEB</text><text x="109" y="333">MAR</text>
        <text x="50" y="274">APR</text><text x="28" y="194">MAY</text>
        <text x="50" y="112">JUN</text><text x="109" y="53">JUL</text>
      </g>

      <path d="M190 38 l5.5 9 h-11 Z" style="fill:var(--accent)"/>

      <g fill="none" stroke-linecap="round">
        <path d="M 170.5 141.8 A 52 52 0 0 1 173.2 140.9" stroke="var(--overdue)" stroke-opacity=".5" stroke-width="2"/>
        <path d="M 200.3 125.0 A 66 66 0 0 1 204.5 125.7" stroke="var(--warm)" stroke-opacity=".5" stroke-width="2"/>
        <path d="M 207.4 125.0 A 67 67 0 0 1 211.5 126.0" stroke="var(--warm)" stroke-opacity=".5" stroke-width="2"/>
        <path d="M 251.3 143.8 A 77 77 0 0 1 253.5 146.5" stroke="var(--upcoming)" stroke-opacity=".45" stroke-width="2"/>
      </g>

      <line data-polish="POL-7" id="comet" class="comet" x1="207.9" y1="126.7" x2="236.1" y2="27"
            stroke-dasharray="110" stroke-dashoffset="110"/>
      </g><!-- /chrome -->
      <circle cx="190" cy="190" r="13" style="fill:var(--sun)" filter="url(#sun)" opacity=".8"/>
      <circle cx="190" cy="190" r="7" style="fill:var(--sun-core)"/>
      <text id="dial-name" x="190" y="212" font-size="10" fill="var(--ink-mid)" text-anchor="middle" style="font-family:var(--ui)">Lawson Home</text>

      <circle data-polish="POL-2" class="ping" cx="175.8" cy="140" r="8" fill="none" style="stroke:var(--overdue)"/>
      <a class="body-link" data-body="i-gutter" data-title="Gutter clearing" data-t="T+16d" data-cost="~£150" href="#i-gutter"><circle id="b-overdue" cx="175.8" cy="140" r="6.5" class="breathe" style="stroke:var(--bg);stroke-width:2" fill="url(#p-ruby)"/></a>
      <a class="body-link" data-body="i-mot" data-title="Car MOT — Volvo V60" data-t="T−16d" data-cost="£54.85" data-docs="2" href="#i-mot"><g id="b-mot" class="breathe"><circle cx="207.9" cy="126.7" r="5.2" style="stroke:var(--bg);stroke-width:2" fill="url(#p-amber)"/><path d="M 207.9 121.5 A 5.2 5.2 0 0 1 207.9 131.9 Z" fill="rgba(0,0,0,.42)"/><circle cx="206.5" cy="128.2" r="1.7" fill="rgba(255,255,255,.4)"/></g></a>
      <a class="body-link" data-body="i-boiler" data-title="Boiler service" data-t="T−22d" data-cost="~£120" href="#i-boiler"><g class="breathe"><circle cx="214.9" cy="127.5" r="6" style="stroke:var(--bg);stroke-width:2" fill="url(#p-amber)"/><circle cx="214.2" cy="129.2" r="2" fill="rgba(255,255,255,.38)"/></g></a>
      <a class="body-link" data-body="i-insurance" data-title="Home insurance renewal" data-t="T−51d" data-cost="~£400" href="#i-insurance"><g><circle cx="246.1" cy="141.7" r="8.5" style="fill:none;stroke:var(--accent);stroke-width:1.8"/><circle cx="246.1" cy="141.7" r="6" style="fill:var(--accent)" opacity=".12"/></g></a>
      <a class="body-link" data-body="i-chimney" data-title="Chimney sweep" data-t="T−61d" data-cost="~£90" href="#i-chimney"><g><circle cx="256.6" cy="151.9" r="5.5" style="stroke:var(--upcoming);stroke-opacity:.25;stroke-width:2.6" fill="url(#p-sky)"/><circle cx="255.2" cy="152.7" r="1.9" fill="rgba(255,255,255,.38)"/></g></a>
      <a class="body-link" data-body="i-smoke" data-title="Smoke alarm batteries" data-t="T−122d" data-cost="~£12" href="#i-smoke"><circle cx="268.9" cy="236.2" r="3.5" fill="url(#p-jade)"/></a>
      <g fill="url(#p-jade)">
        <circle cx="239.4" cy="275.5" r="4"/></g><a class="body-link" data-body="i-svc" data-title="Car full service" data-t="T&#8722;161d" data-cost="~&pound;300" data-docs="2" href="#manifest-top"><circle cx="199.1" cy="294.3" r="6.5" style="stroke:var(--ok);stroke-opacity:.25;stroke-width:3" fill="url(#p-jade)"/><circle cx="198.9" cy="292.4" r="2.2" fill="rgba(255,255,255,.4)"/></a><g style="fill:var(--ok)"></g>
      <g fill="url(#p-jade)">
        <circle cx="152.0" cy="294.3" r="4"/><circle cx="102.6" cy="268.7" r="5"/><circle cx="103.7" cy="267.7" r="1.7" fill="rgba(255,255,255,.35)"/>
        <circle cx="70.0" cy="222.2" r="3.5"/><circle cx="62.2" cy="160.5" r="6"/><circle cx="62.2" cy="160.5" r="3.4" style="fill:var(--bg)"/><circle cx="62.2" cy="160.5" r="1.7"/>
        <circle cx="84.5" cy="101.5" r="4.5"/><circle cx="120.7" cy="65.1" r="5.5"/><path d="M 120.7 59.6 A 5.5 5.5 0 0 1 120.7 70.6 Z" fill="rgba(0,0,0,.42)"/>
        <circle cx="157.0" cy="47.2" r="3.5"/>
      </g>
      <g class="belt" aria-hidden="true">
        <ellipse cx="199.1" cy="294.3" rx="13.5" ry="4.6" transform="rotate(-24 199.1 294.3)"
                 fill="none" style="stroke:var(--accent)" stroke-width="1.3" opacity=".8"/>
      </g>
    </svg>
    </div>
    <div class="hero-foot">
      <div class="splash-search" style="position:relative">
        <input id="explore" placeholder="explore your world" aria-label="Search items and documents">
        <div class="palette" data-polish="POL-9" id="palette">
          <div><b>Car MOT — Volvo V60</b> <small>· T−16d</small></div>
          <div><b>Boiler service</b> <small>· T−22d</small></div>
          <div class="act">→ complete "Boiler service"</div>
          <div class="act">→ add an item</div>
        </div>
      </div>
    </div>
  </div>

    <div class="manifest" id="manifest-top">
    <div class="group">
      <h3>Needs attention <span class="closest">· closest approach — Car MOT · T−16d</span></h3>
      <a class="item" id="i-gutter" href="/item/i-gutter">
        <span class="dot" style="background:var(--overdue)"></span>
        <div class="body"><b>Gutter clearing</b><span>Home · orbital period 1 year · ~£150</span></div>
        <div class="t over">T+16d<small>28 Jul</small></div>
      </a>
      <a class="item" id="i-mot" href="/item/i-mot">
        <span class="dot ter" style="color:var(--warm)"></span>
        <div class="body"><b>Car MOT — Volvo V60</b><span>Vehicles · orbital period 1 year · £54.85</span></div>
        <div class="t soon">T−16d<small>29 Aug</small></div>
      </a>
      <a class="item" id="i-boiler" href="/item/i-boiler">
        <span class="dot" style="background:var(--warm)"></span>
        <div class="body"><b>Boiler service</b><span>Home · orbital period 1 year · British Gas · ~£120</span></div>
        <div class="t soon">T−22d<small>04 Sep</small></div>
      </a>
    </div>
    <div class="group">
      <h3>Suggested from your documents</h3>
      <div class="item suggest" id="i-insurance">
        <span class="dot sug" style="color:var(--accent)"></span>
        <div class="body"><b>Home insurance renewal</b><span>Found in policy-schedule.pdf · renews 02 Oct · ~£400</span></div>
        <div class="actions"><button class="yes">Add to orbit</button><button>Dismiss</button></div>
      </div>
    </div>
    <div class="group">
      <h3>Later this year</h3>
      <a class="item" id="i-chimney" href="/item/i-chimney">
        <span class="dot" style="background:var(--upcoming)"></span>
        <div class="body"><b>Chimney sweep</b><span>Home · orbital period 1 year · ~£90</span></div>
        <div class="t up">T−61d<small>12 Oct</small></div>
      </a>
      <a class="item" id="i-smoke" href="/item/i-smoke">
        <span class="dot" style="background:var(--ok)"></span>
        <div class="body"><b>Smoke alarm batteries</b><span>Devices · orbital period 6 months · ~£12</span></div>
        <div class="t ok">T−122d<small>12 Dec</small></div>
      </a>
    </div>
  </div>
</div>

<aside class="drawer drawer-left" id="statusdrawer" role="region" aria-label="System status">
  <button class="handle" id="edge-health" aria-expanded="false">
    <i></i><span>degraded</span></button>
  <h4>System status</h4>
  <div class="svc"><i style="background:var(--ok)"></i><b>orbit-app</b><small>healthy &middot; 40s ago</small></div>
  <div class="svc"><i style="background:var(--ok)"></i><b>orbit-postgres</b><small>healthy &middot; 40s ago</small></div>
  <div class="svc"><i style="background:var(--degraded)"></i><b>orbit-clamav</b><small>unreachable &middot; 2m ago</small></div>
  <div class="svc"><i style="background:var(--ink-faint)"></i><b>orbit-tika</b><small>not enabled</small></div>
  <div class="svc"><i style="background:var(--ok)"></i><b>scheduler</b><small>running &middot; 12s ago</small></div>
  <h4>Last health check</h4>
  <div class="svc"><i style="background:var(--degraded)"></i><b>scan readiness</b><small>failed &middot; scanner-unreachable</small></div>
  <div class="svc"><i style="background:var(--ok)"></i><b>application</b><small>ready</small></div>
  <h4>Full diagnostics</h4>
  <div class="svc" style="color:var(--ink-faint)">container logs &middot; or the launcher repair flow</div>
</aside>
<aside class="drawer drawer-right" id="keydrawer" role="region" aria-label="Chart key">
  <button class="handle" aria-expanded="false">
    <i></i><span>key</span></button>
  <h4>Urgency</h4>
  <div class="keyrow"><span class="sw" style="background:var(--overdue)"></span>overdue &mdash; inside the ring</div>
  <div class="keyrow"><span class="sw" style="background:var(--warm)"></span>due soon</div>
  <div class="keyrow"><span class="sw" style="background:var(--upcoming)"></span>upcoming</div>
  <div class="keyrow"><span class="sw" style="background:var(--ok)"></span>on track &mdash; wide orbit</div>
  <h4>Types</h4>
  <div class="keyrow"><span class="sw" style="background:var(--ink-mid)"></span>routine service</div>
  <div class="keyrow"><span class="sw" style="background:radial-gradient(circle,var(--ink-mid) 24%,var(--panel-raised) 34%,var(--ink-mid) 52%)"></span>renewal / contract</div>
  <div class="keyrow"><span class="sw" style="background:linear-gradient(90deg,var(--ink-mid) 50%,rgba(0,0,0,.55) 50%)"></span>inspection / certification</div>
  <div class="keyrow"><span class="sw" style="background:none;border:1.6px solid var(--accent)"></span>suggestion &mdash; not yet accepted</div>
  <h4>Physics</h4>
  <div class="keyrow">closer = sooner</div>
  <div class="keyrow">bigger = costlier</div>
  <div class="keyrow">belt = documents attached</div>
  <div class="keyrow">the sky&rsquo;s weather = your workload</div>
</aside>
<div class="docview" id="docview" role="dialog" aria-label="Documents">
  <button class="close">×</button>
  <h4 id="docview-title">Car full service</h4>
  <div class="sub">2 documents · encrypted · scanned clean</div>
  <div class="doc">◆<span>service-invoice-2026.pdf<small>added 12 Jun · 240 KB</small></span></div>
  <div class="doc">◆<span>service-checklist.pdf<small>added 12 Jun · 88 KB</small></span></div>
</div>
</div>
