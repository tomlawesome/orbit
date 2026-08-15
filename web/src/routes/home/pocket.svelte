<script>
  import "./pocket.css";

  /**
   * Home in the mobile dialect (CON-10, #430) — the dial owns the width, the
   * other households collapse from a sky you fly through into a strip you
   * scroll, and what is a hover callout on a desk becomes a bottom sheet under
   * a thumb.
   *
   * It shares home's URL. Both dialects are server-rendered and the viewport
   * chooses between them in CSS, because selecting in JS would flash the wrong
   * one and would break the non-JS fallback. See pocket.css for the switch.
   *
   * Lifted from design/family/mobile-home.html and owned here from that point
   * on. Its rows and bodies are still the mockup's own data.
   *
   * Markup only: +page.svelte mounts whichever dialect the viewport selected,
   * so the hidden one never binds listeners.
   */
</script>

<div class="pocket">
<div class="sky"><svg viewBox="0 0 400 850" preserveAspectRatio="xMidYMid slice">
<g fill="var(--star-far, #e9edf8)"><circle cx="152.4" cy="196.1" r="0.52" opacity="0.37"/>
      <circle cx="231.2" cy="586.6" r="0.79" opacity="0.22"/>
      <circle cx="292.6" cy="490.0" r="0.95" opacity="0.3"/>
      <circle cx="335.7" cy="373.5" r="0.51" opacity="0.14"/>
      <circle cx="289.3" cy="142.4" r="0.86" opacity="0.29"/>
      <circle cx="23.8" cy="666.7" r="0.42" opacity="0.36"/>
      <circle cx="336.4" cy="183.5" r="0.91" opacity="0.32"/>
      <circle cx="50.0" cy="569.5" r="0.49" opacity="0.37"/>
      <circle cx="275.5" cy="833.0" r="0.44" opacity="0.2"/>
      <circle cx="248.0" cy="517.0" r="0.53" opacity="0.37"/>
      <circle cx="338.6" cy="256.2" r="0.5" opacity="0.3"/>
      <circle cx="162.9" cy="563.8" r="0.75" opacity="0.22"/>
      <circle cx="8.7" cy="114.7" r="0.72" opacity="0.32"/>
      <circle cx="170.3" cy="632.8" r="0.78" opacity="0.36"/>
      <circle cx="262.0" cy="273.6" r="0.5" opacity="0.12"/>
      <circle cx="15.8" cy="733.1" r="1.01" opacity="0.33"/>
      <circle cx="43.7" cy="561.4" r="0.49" opacity="0.37"/>
      <circle cx="262.2" cy="637.2" r="0.83" opacity="0.23"/>
      <circle cx="339.4" cy="817.4" r="0.57" opacity="0.23"/>
      <circle cx="293.4" cy="578.0" r="0.69" opacity="0.24"/>
      <circle cx="387.1" cy="234.6" r="0.55" opacity="0.31"/>
      <circle cx="110.8" cy="762.8" r="0.63" opacity="0.38"/>
      <circle cx="151.9" cy="752.4" r="0.93" opacity="0.32"/>
      <circle cx="85.7" cy="139.6" r="0.42" opacity="0.15"/>
      <circle cx="266.6" cy="54.7" r="0.57" opacity="0.27"/>
      <circle cx="62.1" cy="279.7" r="0.56" opacity="0.3"/>
      <circle cx="47.4" cy="847.9" r="0.82" opacity="0.31"/>
      <circle cx="221.0" cy="423.1" r="1.08" opacity="0.37"/>
      <circle cx="328.8" cy="25.4" r="0.81" opacity="0.38"/>
      <circle cx="255.3" cy="436.0" r="0.85" opacity="0.15"/>
      <circle cx="291.1" cy="666.2" r="0.45" opacity="0.25"/>
      <circle cx="238.1" cy="299.2" r="0.88" opacity="0.38"/>
      <circle cx="362.5" cy="261.6" r="0.51" opacity="0.36"/>
      <circle cx="244.8" cy="705.1" r="1.01" opacity="0.18"/>
      <circle cx="235.0" cy="257.7" r="0.96" opacity="0.31"/>
      <circle cx="95.6" cy="425.1" r="0.82" opacity="0.17"/>
      <circle cx="73.0" cy="403.1" r="0.45" opacity="0.25"/>
      <circle cx="376.0" cy="702.1" r="0.44" opacity="0.35"/>
      <circle cx="286.6" cy="601.9" r="0.42" opacity="0.33"/>
      <circle cx="78.2" cy="682.6" r="0.63" opacity="0.21"/>
      <circle cx="68.9" cy="737.4" r="0.56" opacity="0.36"/>
      <circle cx="205.5" cy="126.2" r="0.86" opacity="0.26"/>
      <circle cx="10.8" cy="700.1" r="0.59" opacity="0.11"/>
      <circle cx="306.5" cy="618.0" r="0.67" opacity="0.16"/>
      <circle cx="210.8" cy="498.5" r="0.88" opacity="0.25"/>
      <circle cx="227.1" cy="612.7" r="0.53" opacity="0.15"/>
      <circle cx="193.8" cy="641.0" r="0.96" opacity="0.36"/>
      <circle cx="175.6" cy="606.6" r="0.47" opacity="0.22"/>
      <circle cx="26.7" cy="710.0" r="1.1" opacity="0.3"/>
      <circle cx="301.0" cy="316.4" r="0.96" opacity="0.13"/>
      <circle cx="148.2" cy="298.2" r="1.0" opacity="0.15"/>
      <circle cx="63.7" cy="76.0" r="0.99" opacity="0.19"/>
      <circle cx="361.2" cy="266.0" r="0.99" opacity="0.16"/>
      <circle cx="361.0" cy="827.6" r="1.01" opacity="0.31"/>
      <circle cx="358.5" cy="777.2" r="1.07" opacity="0.18"/>
      <circle cx="340.0" cy="662.7" r="0.64" opacity="0.15"/>
      <circle cx="359.9" cy="401.5" r="0.77" opacity="0.37"/>
      <circle cx="193.5" cy="214.6" r="0.88" opacity="0.26"/>
      <circle cx="109.0" cy="588.2" r="1.03" opacity="0.17"/>
      <circle cx="325.1" cy="640.6" r="0.77" opacity="0.16"/></g></svg></div>
<div class="mpage">
  <div class="mtop">
    <div class="mark-row" style="font-size:15px"><svg width="22" height="22" viewBox="0 0 200 200"><circle cx="100" cy="100" r="72" fill="none" stroke="var(--ink-mid)" stroke-width="10"/><circle cx="163" cy="63.5" r="22" style="fill:var(--accent)"/></svg> orbit</div>
    <div class="morb">TL</div>
  </div>
  <div class="mdial">
    <svg viewBox="0 0 380 380">
      <circle cx="190" cy="190" r="150" fill="none" stroke="var(--line)" stroke-width="1.5"/>
      <circle cx="190" cy="190" r="62" fill="none" stroke="var(--overdue)" stroke-opacity=".3"
              stroke-width="1" stroke-dasharray="3 5"/>
      <g font-size="11" fill="var(--ink-faint)" text-anchor="middle" font-family="JetBrains Mono,monospace">
        <text x="190" y="26">AUG</text><text x="356" y="196">NOV</text>
        <text x="190" y="364">FEB</text><text x="24" y="196">MAY</text></g>
      <path d="M190 34 l6 10 h-12 Z" style="fill:var(--accent)"/>
      <circle cx="190" cy="190" r="8" style="fill:#fff6e6"/>
      <circle cx="175.8" cy="140" r="8" style="fill:var(--overdue)" data-sheet-title="Gutter clearing" data-sheet-meta="T+16d &middot; 28 Jul &middot; ~£150"/>
      <circle cx="212" cy="126" r="7" style="fill:var(--warm)" data-sheet-title="Car MOT — Volvo V60" data-sheet-meta="T&#8722;16d &middot; 29 Aug &middot; £54.85 &middot; ◆ 2 documents"/>
      <circle cx="199.1" cy="294.3" r="7.5" style="fill:var(--ok)" data-sheet-title="Car full service" data-sheet-meta="T&#8722;161d &middot; ~£300 &middot; ◆ 2 documents"/>
      <ellipse cx="199.1" cy="294.3" rx="14" ry="5" transform="rotate(-24 199.1 294.3)"
               fill="none" style="stroke:var(--accent)" stroke-width="1.2" opacity=".8"/>
      <g style="fill:var(--ok)"><circle cx="322" cy="220" r="5"/><circle cx="106" cy="297" r="5"/>
      <circle cx="55" cy="165" r="5"/><circle cx="134" cy="64" r="5"/></g>
    </svg>
  </div>
  <div class="skies">
    <div class="msys"><svg width="20" height="20" viewBox="0 0 20 20"><circle cx="10" cy="10" r="8" fill="none" stroke="var(--line)" /><circle cx="15" cy="6" r="2" style="fill:var(--warm)" opacity=".6"/></svg>Seaside Cottage</div>
    <div class="msys"><svg width="20" height="20" viewBox="0 0 20 20"><circle cx="10" cy="10" r="8" fill="none" stroke="var(--line)"/><circle cx="6" cy="14" r="2" style="fill:var(--ok)" opacity=".6"/></svg>Mum &amp; Dad&rsquo;s</div>
  </div>
  <div class="msearch"><input placeholder="explore your world" readonly></div>
  <div class="mgroup"><h3>NEEDS ATTENTION</h3>
    <div class="mitem"><span class="dot" style="background:var(--overdue)"></span>
      <div class="flex"><b>Gutter clearing</b><span>Home &middot; ~£150</span></div>
      <div class="mt" style="color:var(--overdue)">T+16d<small>28 Jul</small></div></div>
    <div class="mitem"><span class="dot" style="background:var(--warm)"></span>
      <div class="flex"><b>Car MOT — Volvo V60</b><span>Vehicles &middot; £54.85</span></div>
      <div class="mt" style="color:var(--warm)">T&#8722;16d<small>29 Aug</small></div></div>
  </div>
</div>
<div class="sheet" id="sheet">
  <div class="grab"></div><b id="sh-title"></b><div class="meta" id="sh-meta"></div>
  <div class="acts"><button class="pri">open</button><button>documents</button><button
    data-sheet-close>close</button></div>
</div>
</div>
