<script>
  import { onMount, tick } from "svelte";
  import { afterNavigate } from "$app/navigation";
  import { mountEmptySky, mountHome } from "./home.behaviour.js";
  import { approveReceipt, dismissReceipt, readHome, requestToJoin } from "$lib/data/workspace.js";
  import { corridorOf, dialBodiesOf, manifestGroupsOf } from "$lib/data/chart.js";
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

  /* §11 (#453): the ask prompt — the label is the whole surface, the
     question is the whole dialogue. Idempotent server-side. */
  let askTarget = $state(null);
  let askBusy = $state(false);
  let askProblem = $state(null);
  let resync = () => {};
  async function ask() {
    askBusy = true;
    askProblem = null;
    try {
      await requestToJoin(askTarget.id);
      askTarget = null;
      view = await readHome();
      await tick();
      resync();
    } catch (error) {
      askProblem = error?.message ?? String(error);
    } finally {
      askBusy = false;
    }
  }
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
  /* §14 (#469): the manifest rendered as the corridor — this household's
     full scrollback, suggestions merged in date order. */
  const corridor = $derived(
    view?.household
      ? corridorOf(
          { households: [view.household], activeHouseholdId: view.primary },
          view.today,
          { suggestions: view.suggestions },
        )
      : null,
  );
  const todayLine = $derived(
    view
      ? new Date(view.today + "T00:00:00Z")
          .toLocaleDateString("en-GB", { weekday: "short", day: "2-digit", month: "short", timeZone: "UTC" })
          .replace(",", "").toUpperCase()
      : "",
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
      /* §11 (#453): no household means the labelled sky in either dialect —
         same bearings, label only, click to ask. */
      if (view?.emptySky) {
        if (query.matches) {
          teardown = mountEmptySky({ galaxy: view.galaxy, onAsk: (id, name, requested) => { if (!requested) askTarget = { id, name }; } });
        } else {
          /* The pocket's labelled sky is a list; asking rides data attributes
             because the hidden dialect must never bind listeners. */
          const controller = new AbortController();
          for (const row of document.querySelectorAll("[data-ask]")) {
            row.addEventListener("click", () => {
              if (row.dataset.askRequested !== "true") askTarget = { id: row.dataset.ask, name: row.dataset.askName };
            }, { signal: controller.signal });
          }
          teardown = () => controller.abort();
        }
        return;
      }
      /* Tear the old dialect down before standing the new one up. */
      teardown = query.matches
        ? mountHome({ galaxy: view.galaxy, primary: view.primary })
        : mountPocket({
            /* #466: the sheet's two-tap lands on the same idempotent approve
               protocol the desk rows use — one operation id per receipt. */
            approve: (id) => {
              const suggestion = view?.suggestions.find((one) => one.receiptId === id);
              if (suggestion) { armed = { id: suggestion.id, act: "approve" }; tapReceipt(suggestion, "approve"); }
            },
            dismiss: (id) => {
              const suggestion = view?.suggestions.find((one) => one.receiptId === id);
              if (suggestion) { armed = { id: suggestion.id, act: "dismiss" }; tapReceipt(suggestion, "dismiss"); }
            },
          });
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
      resync = sync;
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
    {#if view?.emptySky}
    <!-- §11 (#453): the labelled sky — no dial, no manifest. The
         constellations are placed by mountEmptySky; this is the hero's
         quiet centre, and the north star above still creates. -->
    <div class="adrift">
      <h2>you’re adrift</h2>
      <p>the systems around you are labels until someone lets you in —<br>
         tap one to ask to join, or follow the north star to start your own</p>
    </div>
    {:else}
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
    {/if}
  </div>

    <!-- §14 (#469): ONE schedule surface. The manifest IS the corridor — a
         full scrollback through events, nearest at the top down to the
         furthest away, suggestions riding the same line in date order. -->
    <div class="manifest" id="manifest-top">
    {#if corridor && !view?.emptySky}
      {#snippet corridorRow(row)}
        {#if row.suggestion}
          {@const s = view.suggestions.find((one) => one.id === row.id)}
          <div class="item suggest" id={row.id}>
            <span class="planet sug" aria-hidden="true"><i></i></span>
            <div class="body"><b>{row.title}</b><span>{[
              `Found in ${row.sourceDocument}`,
              row.dueDate ? `renews ${short(row.dueDate)}` : null,
              row.costMinor ? money(row.costMinor, row.currency, true) : null,
            ].filter(Boolean).join(" · ")}</span></div>
            <!-- #434: approval is the boundary between untrusted mail and
                 the household, so it takes two deliberate taps — the first
                 arms, the second fires. One operation id per receipt makes
                 the write idempotent under any retry. -->
            <div class="actions">
              <button class="yes" disabled={busyReceipt === row.id}
                onclick={() => tapReceipt(s, "approve")}>
                {armed.id === row.id && armed.act === "approve" ? "tap again to approve" : "Add to orbit"}
              </button>
              <button disabled={busyReceipt === row.id}
                onclick={() => tapReceipt(s, "dismiss")}>
                {armed.id === row.id && armed.act === "dismiss" ? "tap again to dismiss" : "Dismiss"}
              </button>
            </div>
            {#if mailProblem && armed.id === row.id}
              <div class="mail-problem">{mailProblem}</div>
            {/if}
          </div>
        {:else}
          <a class="item" id={row.id} href="/item/{row.id}">
            <span class="planet" class:ter={row.kind === "inspection"} class:con={row.kind === "renewal"}
                  style="color:var({BAND_VAR[row.band]})" aria-hidden="true"><i></i></span>
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
        {/if}
      {/snippet}
      <div class="corridor">
        {#if corridor.overdue.length}
          <div class="redzone">
            {#each corridor.overdue as row (row.id)}{@render corridorRow(row)}{/each}
          </div>
        {/if}
        <div class="today"><span class="sunmark" aria-hidden="true"><i></i><b></b></span><span>TODAY · {todayLine}</span><div class="rule"></div></div>
        {#each corridor.current as row (row.id)}{@render corridorRow(row)}{/each}
        {#each corridor.months as month (month.key)}
          <div class="month"><span>{month.label}</span><div class="rule"></div><small>{month.rows.length} approaching</small></div>
          {#each month.rows as row (row.id)}{@render corridorRow(row)}{/each}
        {/each}
        {#each corridor.undated as row (row.id)}{@render corridorRow(row)}{/each}
      </div>
      {#if corridor.total === 0}
        <div class="horizon">— nothing scheduled: your sky is quiet —</div>
      {:else if corridor.horizon}
        <div class="horizon">— beyond the horizon: nothing scheduled past {corridor.horizon} —</div>
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
{#if !view?.emptySky}
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
{/if}
{#if askTarget}
<!-- §11 (#453): the question IS the dialogue — one ask, two honest answers. -->
<div class="askveil" role="dialog" aria-label="Request to join">
  <div class="askcard">
    <h3>Request to join {askTarget.name} system?</h3>
    <p>its owners decide — you’ll see the whole system once someone lets you in</p>
    {#if askProblem}<div class="askproblem">{askProblem}</div>{/if}
    <div class="askacts">
      <button class="yes" disabled={askBusy} onclick={ask}>request to join</button>
      <button disabled={askBusy} onclick={() => (askTarget = null)}>not now</button>
    </div>
  </div>
</div>
{/if}
</div>
