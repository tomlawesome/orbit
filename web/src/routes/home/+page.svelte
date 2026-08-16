<script>
  import { onMount, tick } from "svelte";
  import { afterNavigate } from "$app/navigation";
  import { mountHome } from "./home.behaviour.js";
  import { approveReceipt, dismissReceipt, readHome } from "$lib/data/workspace.js";
  import { dialBodiesOf, manifestGroupsOf } from "$lib/data/chart.js";
  import { money } from "$lib/format.js";
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

  let view = $state(null);

  /*
   * Coming BACK to home is not arriving at it (owner, 2026-08-15: leaving an
   * item must return you to exactly where you were). The POL-1 fanfare plays
   * only on a forward arrival — the CSS keys off .arrive — and a history
   * return restores the scroll position once the data has given the page its
   * height (SvelteKit's own restoration fires before the fetch resolves, so
   * it lands at the top without this).
   */
  let arrive = $state(true);
  let restoreScroll = null;
  afterNavigate((navigation) => {
    arrive = navigation.type !== "popstate";
  });
  export const snapshot = {
    capture: () => window.scrollY,
    restore: (y) => { restoreScroll = y; },
  };

  /* Mail-in review on the row (#434): first tap arms, second fires. One
     operation id per receipt across every retry — approval is idempotent by
     construction, so a double-tap can never create two items. */
  let armed = $state({ id: null, act: null });
  let busyReceipt = $state(null);
  let mailProblem = $state(null);
  const operationIds = new Map();
  async function tapReceipt(suggestion, act) {
    mailProblem = null;
    if (!suggestion.receiptId) return; // a #454 fixture suggestion has no mail behind it yet
    if (armed.id !== suggestion.id || armed.act !== act) {
      armed = { id: suggestion.id, act };
      return;
    }
    busyReceipt = suggestion.id;
    try {
      if (act === "approve") {
        if (!operationIds.has(suggestion.receiptId)) operationIds.set(suggestion.receiptId, crypto.randomUUID());
        const result = await approveReceipt(suggestion, view.primary, operationIds.get(suggestion.receiptId));
        if (result.outcome === "partial_success") {
          /* The item exists but its documents didn't make it: the SAME
             operation id retries the SAME body — never a second item. */
          mailProblem = "The item is recorded, but its documents need another try — tap again to finish.";
          return;
        }
        operationIds.delete(suggestion.receiptId);
      } else {
        await dismissReceipt(suggestion.receiptId);
      }
      armed = { id: null, act: null };
      view = await readHome();
    } catch (error) {
      mailProblem = error?.message ?? String(error);
    } finally {
      busyReceipt = null;
    }
  }

  /* Everything below the chrome is the view-model (#451): the same transform
     the unit tests pin renders the dial, the manifest and the palette. */
  const bodies = $derived(
    view ? dialBodiesOf(view.household, { suggestions: view.suggestions, today: view.today }) : [],
  );
  const groups = $derived(
    view ? manifestGroupsOf(view.household, { suggestions: view.suggestions, today: view.today }) : null,
  );
  const initials = $derived(
    (view?.user?.displayName ?? "")
      .split(/\s+/)
      .map((word) => word[0] ?? "")
      .join("")
      .slice(0, 2)
      .toUpperCase(),
  );

  /* The month ring: positions are the design's own (hand-nudged a few px off
     the pure circle, kept verbatim); the TEXT walks with the real date, the
     current month at 12 o'clock (POL-3). */
  const MONTH_POS = [
    [190, 31], [271, 53], [330, 112], [352, 194], [330, 274], [271, 333],
    [190, 355], [109, 333], [50, 274], [28, 194], [50, 112], [109, 53],
  ];
  const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
  const monthLabels = $derived(
    MONTH_POS.map(([x, y], k) => ({
      x, y,
      label: MONTHS[((view ? new Date(view.today + "T00:00:00Z").getUTCMonth() : 7) + k) % 12],
    })),
  );

  const tlabel = (b) => (b.days < 0 ? `T+${-b.days}d` : `T−${b.days}d`);
  const short = (iso) =>
    new Date(iso + "T00:00:00Z").toLocaleDateString("en-GB", { day: "2-digit", month: "short", timeZone: "UTC" });
  const period = (months) => (months === 12 ? "1 year" : months === 6 ? "6 months" : `${months} months`);
  const BAND_VAR = { overdue: "--overdue", "due-soon": "--warm", upcoming: "--upcoming", ok: "--ok" };
  const T_CLASS = { overdue: "over", "due-soon": "soon", upcoming: "up", ok: "ok" };

  const point = (deg, radius) => [
    Math.round((190 + Math.cos((deg * Math.PI) / 180) * radius) * 10) / 10,
    Math.round((190 + Math.sin((deg * Math.PI) / 180) * radius) * 10) / 10,
  ];
  /* A trail rides just behind the body on its own orbit (suggestions: just
     ahead) — the arc the design drew for everything close to the sun. */
  const trailPath = (b) => {
    const angle = b.days - 90;
    const [from, to] = b.suggestion ? [angle + 3, angle + 7] : [angle - 7, angle - 3];
    const [x1, y1] = point(from, b.placement.radius);
    const [x2, y2] = point(to, b.placement.radius);
    return `M ${x1} ${y1} A ${b.placement.radius} ${b.placement.radius} 0 0 1 ${x2} ${y2}`;
  };
  const trailStroke = (b) =>
    b.suggestion ? "var(--upcoming)" : b.overdue ? "var(--overdue)" : "var(--warm)";
  const trailed = $derived(
    bodies.filter((b) => (b.suggestion ? b.trail : b.trail && (b.overdue || b.paint === "amber"))),
  );
  /* The dotted accent line strings the next three routine services together. */
  const constellationPoints = $derived(
    bodies
      .filter((b) => !b.suggestion && b.kind === "service")
      .slice(0, 3)
      .map((b) => `${b.placement.x},${b.placement.y}`)
      .join(" "),
  );
  const closest = $derived(bodies.find((b) => b.closest) ?? null);
  const firstOverdue = $derived(bodies.find((b) => b.overdue) ?? null);
  const crescent = (b) =>
    `M ${b.placement.x} ${b.placement.y - b.size} A ${b.size} ${b.size} 0 0 1 ${b.placement.x} ${b.placement.y + b.size} Z`;


  onMount(() => {
    const query = window.matchMedia(DESK);
    let teardown = null;
    let disposed = false;
    const sync = () => {
      teardown?.();
      /* Tear the old dialect down before standing the new one up. */
      teardown = query.matches
        ? mountHome({ galaxy: view.galaxy, primary: view.primary })
        : mountPocket();
    };
    /* The home view comes through the seam, live (#451). onMount must stay
       synchronous — an async callback's return value is discarded, which
       would leak every listener the teardown exists to remove — so the read
       resolves into a closure and mounting follows it, after tick() has put
       the data-driven markup in the document for the behaviour to bind. */
    readHome().then(async (data) => {
      if (disposed) return;
      view = data;
      await tick();
      if (disposed) return;
      sync();
      query.addEventListener("change", sync);
      if (restoreScroll !== null) {
        const y = restoreScroll;
        restoreScroll = null;
        requestAnimationFrame(() => window.scrollTo(0, y));
      }
    });
    return () => {
      disposed = true;
      query.removeEventListener("change", sync);
      teardown?.();
    };
  });
</script>

<svelte:head>
  <title>Orbit</title>
</svelte:head>

<Pocket {view} />

<div class="desk" class:arrive>
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

<button class="orb" aria-expanded="false" aria-controls="account" title="Menu">{initials}</button>
<div class="account" id="account" role="region" aria-label="Account and menu">
  <div class="who"><b>{view?.user?.displayName ?? ""}</b><span id="who-role"
    >{view ? `${view.household?.name ?? ""} · ${view.galaxy[view.primary]?.role ?? "member"}` : ""}</span></div>
  <nav>
    <a href="/due-next">Due next</a>
    <a href="/documents">Documents</a>
    <a href="/inbox">Inbox</a>
    <a href="/settings">Settings</a>
    <a href="/administration">Administration</a>
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
        <polyline points={constellationPoints} fill="none"
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
        {#each monthLabels as m, k (k)}
          {#if k === 0}<text x={m.x} y={m.y} class="now-month" data-polish="POL-3">{m.label}</text>
          {:else}<text x={m.x} y={m.y}>{m.label}</text>{/if}
        {/each}
      </g>

      <path d="M190 38 l5.5 9 h-11 Z" style="fill:var(--accent)"/>

      <g fill="none" stroke-linecap="round">
        {#each trailed as b (b.id)}
          <path d={trailPath(b)} stroke={trailStroke(b)}
                stroke-opacity={b.suggestion ? ".45" : ".5"} stroke-width="2"/>
        {/each}
      </g>

      {#if closest}
        <line data-polish="POL-7" id="comet" class="comet"
              x1={closest.placement.x} y1={closest.placement.y}
              x2={closest.placement.x + 28.2} y2={closest.placement.y - 99.7}
              stroke-dasharray="110" stroke-dashoffset="110"/>
      {/if}
      </g><!-- /chrome -->
      <circle cx="190" cy="190" r="13" style="fill:var(--sun)" filter="url(#sun)" opacity=".8"/>
      <circle cx="190" cy="190" r="7" style="fill:var(--sun-core)"/>
      <text id="dial-name" x="190" y="212" font-size="10" fill="var(--ink-mid)" text-anchor="middle" style="font-family:var(--ui)">{view?.household?.name ?? ""}</text>

      {#if firstOverdue}
        <circle data-polish="POL-2" class="ping" cx={firstOverdue.placement.x} cy={firstOverdue.placement.y}
                r="8" fill="none" style="stroke:var(--overdue)"/>
      {/if}
      {#each bodies as b (b.id)}
        {#if b.suggestion}
          <a class="body-link" data-body={b.id} data-title={b.title} data-t={tlabel(b)}
             data-cost={money(b.costMinor, b.currency, true)} href="#{b.id}"><g
            ><circle cx={b.placement.x} cy={b.placement.y} r={b.size + 1.2}
                     style="fill:none;stroke:var(--accent);stroke-width:1.8"
            /><circle cx={b.placement.x} cy={b.placement.y} r={b.size - 1.3}
                     style="fill:var(--accent)" opacity=".12"/></g></a>
        {:else}
          <a class="body-link" data-body={b.id} data-title={b.title} data-t={tlabel(b)}
             data-cost={money(b.costMinor, b.currency, b.costIsEstimate)}
             data-docs={b.documentCount > 0 ? b.documentCount : undefined} href="#{b.id}"><g
             id={b.closest ? "b-closest" : undefined}
             class={b.overdue || b.paint === "amber" ? "breathe" : undefined}>
            {#if b.paint === "ruby" || b.paint === "amber"}
              <circle cx={b.placement.x} cy={b.placement.y} r={b.size}
                      style="stroke:var(--bg);stroke-width:2" fill="url(#p-{b.paint})"/>
            {:else if b.paint === "sky"}
              <circle cx={b.placement.x} cy={b.placement.y} r={b.size}
                      style="stroke:var(--upcoming);stroke-opacity:.25;stroke-width:2.6" fill="url(#p-sky)"/>
            {:else if b.documentCount > 0}
              <circle cx={b.placement.x} cy={b.placement.y} r={b.size}
                      style="stroke:var(--ok);stroke-opacity:.25;stroke-width:3" fill="url(#p-jade)"/>
            {:else}
              <circle cx={b.placement.x} cy={b.placement.y} r={b.size} fill="url(#p-jade)"/>
            {/if}
            {#if b.kind === "inspection"}<path d={crescent(b)} fill="rgba(0,0,0,.42)"/>{/if}
            {#if b.kind === "renewal"}
              <circle cx={b.placement.x} cy={b.placement.y} r={b.size * 0.57} style="fill:var(--bg)"/>
              <circle cx={b.placement.x} cy={b.placement.y} r={b.size * 0.28} fill="url(#p-{b.paint})"/>
            {/if}
            {#if b.size >= 4}
              <circle cx={b.placement.x - 0.2 * b.size} cy={b.placement.y + 0.25 * b.size}
                      r={0.33 * b.size} fill="rgba(255,255,255,.38)"/>
            {/if}
          </g></a>
        {/if}
      {/each}
      {#each bodies.filter((b) => b.documentCount > 0 && b.paint === "jade") as b (b.id)}
        <g class="belt" aria-hidden="true">
          <ellipse cx={b.placement.x} cy={b.placement.y} rx="13.5" ry="4.6"
                   transform="rotate(-24 {b.placement.x} {b.placement.y})"
                   fill="none" style="stroke:var(--accent)" stroke-width="1.3" opacity=".8"/>
        </g>
      {/each}
    </svg>
    </div>
    <div class="hero-foot">
      <div class="splash-search" style="position:relative">
        <input id="explore" placeholder="explore your world" aria-label="Search items and documents">
        <div class="palette" data-polish="POL-9" id="palette">
          {#each (groups?.attention ?? []).filter((r) => r.days >= 0).slice(0, 2) as row (row.id)}
            <div><b>{row.title}</b> <small>· {tlabel(row)}</small></div>
          {/each}
          {#if groups?.closest}<div class="act">→ complete "{groups.closest.title}"</div>{/if}
          <div class="act">→ add an item</div>
        </div>
      </div>
    </div>
  </div>

    <div class="manifest" id="manifest-top">
    {#if groups}
      {#snippet manifestRow(row)}
        <a class="item" id={row.id} href="/item/{row.id}">
          {#if row.kind === "inspection"}
            <span class="dot ter" style="color:var({BAND_VAR[row.band]})"></span>
          {:else}
            <span class="dot" style="background:var({BAND_VAR[row.band]})"></span>
          {/if}
          <div class="body"><b>{row.title}</b><span>{[
            row.section,
            row.recurrenceMonths ? `orbital period ${period(row.recurrenceMonths)}` : null,
            row.provider,
            row.costMinor ? money(row.costMinor, row.currency, row.costIsEstimate) : null,
          ].filter(Boolean).join(" · ")}</span></div>
          {#if row.dueDate}
            <div class="t {T_CLASS[row.band]}">{tlabel(row)}<small>{short(row.dueDate)}</small></div>
          {:else}
            <div class="t ok">—</div>
          {/if}
        </a>
      {/snippet}
      {#if groups.attention.length}
        <div class="group">
          <h3>Needs attention {#if groups.closest}<span class="closest">· closest approach — {groups.closest.title} · {tlabel(groups.closest)}</span>{/if}</h3>
          {#each groups.attention as row (row.id)}{@render manifestRow(row)}{/each}
        </div>
      {/if}
      {#if groups.suggestions.length}
        <div class="group">
          <h3>Suggested from your documents</h3>
          {#each groups.suggestions as s (s.id)}
            <div class="item suggest" id={s.id}>
              <span class="dot sug" style="color:var(--accent)"></span>
              <div class="body"><b>{s.title}</b><span>{[
                `Found in ${s.sourceDocument}`,
                s.renewsOn ? `renews ${short(s.renewsOn)}` : null,
                s.costMinor ? money(s.costMinor, s.currency, true) : null,
              ].filter(Boolean).join(" · ")}</span></div>
              <!-- #434: approval is the boundary between untrusted mail and
                   the household, so it takes two deliberate taps — the first
                   arms, the second fires. One operation id per receipt makes
                   the write idempotent under any retry. -->
              <div class="actions">
                <button class="yes" disabled={busyReceipt === s.id}
                  onclick={() => tapReceipt(s, "approve")}>
                  {armed.id === s.id && armed.act === "approve" ? "tap again to approve" : "Add to orbit"}
                </button>
                <button disabled={busyReceipt === s.id}
                  onclick={() => tapReceipt(s, "dismiss")}>
                  {armed.id === s.id && armed.act === "dismiss" ? "tap again to dismiss" : "Dismiss"}
                </button>
              </div>
              {#if mailProblem && armed.id === s.id}
                <div class="mail-problem">{mailProblem}</div>
              {/if}
            </div>
          {/each}
        </div>
      {/if}
      {#if groups.later.length}
        <div class="group">
          <h3>Later this year</h3>
          {#each groups.later as row (row.id)}{@render manifestRow(row)}{/each}
        </div>
      {/if}
    {/if}
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
