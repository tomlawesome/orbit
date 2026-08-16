<script>
  import "./pocket.css";
  import { dialBodiesOf, daysUntil, hashId, manifestGroupsOf } from "$lib/data/chart.js";
  import { ago, money } from "$lib/format.js";

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
   * Lifted from design/family/mobile-home.html; live since #451 — the same
   * view-model the desk dialect renders, through the same laws. A thumb gets
   * fewer, bigger bodies: the overdue one, the closest approach, and anything
   * carrying documents on a wide orbit; the rest live in the rows.
   *
   * Markup only: +page.svelte mounts whichever dialect the viewport selected,
   * so the hidden one never binds listeners.
   */
  let { view = null } = $props();

  const bodies = $derived(
    view ? dialBodiesOf(view.household, { suggestions: view.suggestions, today: view.today }) : [],
  );
  const pocketBodies = $derived(
    bodies.filter((b) => b.suggestion || b.overdue || b.closest || (b.documentCount > 0 && b.paint === "jade")),
  );
  const groups = $derived(
    view ? manifestGroupsOf(view.household, { suggestions: view.suggestions, today: view.today }) : null,
  );
  const others = $derived(
    view
      ? Object.entries(view.galaxy)
          .filter(([id]) => id !== view.primary)
          .map(([id, hh]) => {
            const angle = (hashId(id) / 0xffffffff) * Math.PI * 2;
            return {
              id,
              name: hh.name,
              tone: hh.planets[0]?.[3] ?? "--ok",
              dx: Math.round((10 + Math.cos(angle) * 5.5) * 10) / 10,
              dy: Math.round((10 + Math.sin(angle) * 5.5) * 10) / 10,
            };
          })
      : [],
  );
  const initials = $derived(
    (view?.user?.displayName ?? "")
      .split(/\s+/)
      .map((word) => word[0] ?? "")
      .join("")
      .slice(0, 2)
      .toUpperCase(),
  );
  const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
  const QUARTER_POS = [[190, 26], [356, 196], [190, 364], [24, 196]];
  const quarters = $derived(
    QUARTER_POS.map(([x, y], k) => ({
      x, y,
      label: MONTHS[((view ? new Date(view.today + "T00:00:00Z").getUTCMonth() : 7) + k * 3) % 12],
    })),
  );
  const BAND_VAR = { overdue: "--overdue", "due-soon": "--warm", upcoming: "--upcoming", ok: "--ok" };
  const tlabel = (b) => (b.days < 0 ? `T+${-b.days}d` : `T−${b.days}d`);
  const short = (iso) =>
    new Date(iso + "T00:00:00Z").toLocaleDateString("en-GB", { day: "2-digit", month: "short", timeZone: "UTC" });
  const bodyColour = (b) => `var(${BAND_VAR[b.overdue ? "overdue" : b.paint === "amber" ? "due-soon" : b.paint === "sky" ? "upcoming" : "ok"]})`;
  const bodyR = (b) => (b.overdue ? 8 : b.closest ? 7 : 7.5);
  const sheetMeta = (b) =>
    [
      tlabel(b),
      b.dueDate ? short(b.dueDate) : null,
      b.costMinor ? money(b.costMinor, b.currency, b.costIsEstimate) : null,
      b.documentCount > 0 ? `◆ ${b.documentCount} documents` : null,
    ].filter(Boolean).join(" · ");
  /* #466: the relay's signals — days until an unreviewed arrival burns up,
     elapsed time in the pocket's short register. `now` is pinned by the seam. */
  const burnsIn = (s) => (s.expiresAt ? daysUntil(s.expiresAt.slice(0, 10), view.today) : null);
  const agoShort = (iso) => ago(iso, view.now ?? new Date().toISOString());
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
    <div class="morb">{initials}</div>
  </div>
  <div class="mdial">
    <svg viewBox="0 0 380 380">
      <circle cx="190" cy="190" r="150" fill="none" stroke="var(--line)" stroke-width="1.5"/>
      <circle cx="190" cy="190" r="62" fill="none" stroke="var(--overdue)" stroke-opacity=".3"
              stroke-width="1" stroke-dasharray="3 5"/>
      <g font-size="11" fill="var(--ink-faint)" text-anchor="middle" font-family="JetBrains Mono,monospace">
        {#each quarters as q, k (k)}<text x={q.x} y={q.y}>{q.label}</text>{/each}</g>
      <path d="M190 34 l6 10 h-12 Z" style="fill:var(--accent)"/>
      <circle cx="190" cy="190" r="8" style="fill:#fff6e6"/>
      {#each pocketBodies as b (b.id)}
        {#if b.suggestion}
          <!-- #466: the relay's catch is ON the dial at its law position —
               the same hollow accent body the desk shows (§12). -->
          <g data-sheet-sugg={b.id} style="cursor:pointer">
            <circle cx={b.placement.x} cy={b.placement.y} r="8.5" style="fill:none;stroke:var(--accent);stroke-width:1.8"/>
            <circle cx={b.placement.x} cy={b.placement.y} r="6" style="fill:var(--accent)" opacity=".12"/>
          </g>
        {:else}
          <circle cx={b.placement.x} cy={b.placement.y} r={bodyR(b)} style="fill:{bodyColour(b)}"
                  data-sheet-title={b.title} data-sheet-meta={sheetMeta(b)}/>
          {#if b.documentCount > 0 && b.paint === "jade"}
            <ellipse cx={b.placement.x} cy={b.placement.y} rx="14" ry="5"
                     transform="rotate(-24 {b.placement.x} {b.placement.y})"
                     fill="none" style="stroke:var(--accent)" stroke-width="1.2" opacity=".8"/>
          {/if}
        {/if}
      {/each}
    </svg>
  </div>
  <div class="skies">
    {#each others as hh (hh.id)}
      <div class="msys"><svg width="20" height="20" viewBox="0 0 20 20"><circle cx="10" cy="10" r="8" fill="none" stroke="var(--line)"/><circle cx={hh.dx} cy={hh.dy} r="2" style="fill:var({hh.tone === "--warm" ? "--warm" : hh.tone === "--upcoming" ? "--upcoming" : "--ok"})" opacity=".6"/></svg>{hh.name}</div>
    {/each}
  </div>
  <div class="msearch"><input placeholder="explore your world" readonly></div>
  {#if groups?.attention.length}
  <div class="mgroup"><h3>NEEDS ATTENTION</h3>
    {#each groups.attention as row (row.id)}
      <div class="mitem"><span class="dot" style="background:var({BAND_VAR[row.band]})"></span>
        <div class="flex"><b>{row.title}</b><span>{[row.section, row.costMinor ? money(row.costMinor, row.currency, row.costIsEstimate) : null].filter(Boolean).join(" · ")}</span></div>
        <div class="mt" style="color:var({BAND_VAR[row.band]})">{tlabel(row)}<small>{row.dueDate ? short(row.dueDate) : ""}</small></div></div>
    {/each}
  </div>
  {/if}
  <!-- #466: the pocket's signals surface — what the relay caught, in the
       pocket's own grammar. Suggestion rows raise the suggestion sheet;
       failures speak the server's words. -->
  {#if view?.suggestions?.length || view?.mailReading?.length || view?.mailFailures?.length}
  <div class="mgroup"><h3>SIGNALS — YOUR RELAY CAUGHT</h3>
    {#each view.suggestions as s (s.id)}
      <div class="mitem suggest" data-sheet-sugg={s.id}>
        <span class="dot sug"></span>
        <div class="flex"><b>{s.title}</b><span>{[
          `from ${s.sourceDocument}`,
          burnsIn(s) !== null ? `burns up in ${burnsIn(s)}d` : null,
        ].filter(Boolean).join(" · ")}</span></div>
        <div class="mt" style="color:var(--accent)">{s.costMinor ? money(s.costMinor, s.currency, true) : ""}<small>{s.renewsOn ? `renews ${short(s.renewsOn)}` : ""}</small></div>
      </div>
    {/each}
    {#each view.mailReading as r (r.id)}
      <div class="mitem reading">
        <span class="dot"></span>
        <div class="flex"><b>A message arrived {agoShort(r.receivedAt)}</b><span>still reading its document</span></div>
      </div>
    {/each}
    {#each view.mailFailures as f (f.id)}
      <div class="mitem failed">
        <span class="dot"></span>
        <div class="flex"><b>A message from {short(f.receivedAt.slice(0, 10))}</b><span>{f.message}</span></div>
      </div>
    {/each}
    <div class="burnup">unreviewed arrivals burn up after 45 days · nothing is added without you</div>
  </div>
  {/if}
</div>
<div class="sheet" id="sheet">
  <div class="grab"></div><b id="sh-title"></b><div class="meta" id="sh-meta"></div>
  <div class="fields" id="sh-fields"></div>
  <div class="acts" id="sh-acts-item"><button class="pri">open</button><button>documents</button><button
    data-sheet-close>close</button></div>
  <div class="acts" id="sh-acts-sugg" hidden>
    <button class="pri" data-sugg-act="approve">Add to orbit</button>
    <button data-sugg-act="dismiss">Dismiss</button>
    <button data-sheet-close>close</button>
  </div>
  <a class="amend" id="sh-amend" href="/home" hidden>review &amp; amend →</a>
</div>
{#each view?.suggestions ?? [] as s (s.id)}
  <!-- The suggestion sheet's copy, rendered by Svelte and cloned into the
       sheet by the behaviour — no markup is ever built from strings. -->
  <template data-sugg-template={s.id} data-title={s.title}
            data-meta={`caught by your relay ${short((s.receivedAt ?? view.today).slice(0, 10))} · burns up in ${burnsIn(s)}d`}>
    {#if s.provider}<div class="kv"><span>provider</span><b>{s.provider}</b></div>{/if}
    {#if s.renewsOn}<div class="kv"><span>renews</span><b>{short(s.renewsOn)} {s.renewsOn.slice(0, 4)}</b></div>{/if}
    {#if s.costMinor}<div class="kv"><span>cost</span><b>{money(s.costMinor, s.currency, true)}</b></div>{/if}
    <div class="kv"><span>document</span><b>◆ {s.sourceDocument} · scanned clean</b></div>
  </template>
{/each}
</div>
