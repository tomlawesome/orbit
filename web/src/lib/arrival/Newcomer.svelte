<script>
  import { onMount } from "svelte";
  import { NEWCOMER_FAR, NEWCOMER_NEAR } from "$lib/flight/starfields.js";
  import { belongRowsOf, discoveredCountOf } from "./stage.js";
  /*
   * #428's placement law, imported rather than copied: "bearings are sacred,
   * radii negotiate", and the whole thing is one pure function of (households,
   * camera, viewport). One law, or the newcomer and the member are looking at
   * two different skies. It lives with the home screen because that is where it
   * was written; this reads it and changes nothing.
   */
  import { placeGalaxy } from "../../routes/home/placement.js";

  /**
   * THE NEWCOMER'S LANDING (#410, §15 second pass, ruling 4 — ratified
   * verbatim: "fantastic, great job. It ships exactly like that.").
   *
   * A reader who belongs to nothing yet flies exactly the same launch as
   * everybody else and sets down HERE instead of on the dial: the #453
   * labelled sky, every household in the instance hanging as a sub-system with
   * its label and its leader rule, the boxless count as a MOMENT on the settled
   * sky, and then the question in the space it left.
   *
   * The three beats are body classes (`bare`, `instrument`, `counting`,
   * `belong`) applied by the flight's own timeline, so the staging survives
   * reduced motion and can be pinned to one millisecond for a screenshot. This
   * component draws; it never decides when.
   */
  /**
   * @type {{
   *   galaxy?: Record<string, { name: string, requested?: boolean, planets?: Array<[number, number, number, string]> }>,
   *   visibleHouseholds?: Array<{ id: string, name: string, requested?: boolean }>,
   *   onask?: (row: { id: string, name: string, requested?: boolean }) => void,
   *   oncreate?: import('svelte/elements').MouseEventHandler<HTMLButtonElement>,
   * }}
   */
  let {
    /* the labelled sky, from $lib/data/chart.js's labelledSkyOf */
    galaxy = {},
    /* every system on the instance, as the count reads it */
    visibleHouseholds = [],
    onask = () => {},
    oncreate = () => {},
  } = $props();

  /** @type {HTMLDivElement | null} */
  let hero = null;
  /*
   * The join list is fed from `visibleHouseholds`, NOT from `galaxy` (#670,
   * owner decision 2026-09-01).
   *
   * `labelledSkyOf` now draws at most twelve constellations, because past
   * that the sky cannot separate them far enough for a click to be sure which
   * one it hit. That cap is right for the SKY and would be a bug in the LIST:
   * a thirteenth household drawn nowhere would also be listed nowhere, and a
   * household you cannot name is a household you cannot ask to join — it
   * would simply drop out of the instance for every newcomer. So the sky is
   * capped and the list is not. `visibleHouseholds` already carries the id,
   * name and requested flag `belongRowsOf` reads, and it keeps the same
   * id-sorted order, so the rows below are unchanged for every instance small
   * enough for the cap not to bite.
   */
  const rows = $derived(
    belongRowsOf(Object.fromEntries((visibleHouseholds ?? []).map((household) => [household.id, household]))),
  );
  const discovered = $derived(discoveredCountOf(visibleHouseholds));

  /* The household cards on the sky, as plain descriptors — the layout maths
     is unchanged, it just lands in state instead of DOM nodes so the markup
     below can draw it declaratively (#620: imperative appendChild here
     tripped svelte/no-dom-manipulating). */
  /** @type {ReturnType<typeof computeCards>} */
  let cards = $state([]);

  /**
   * The labelled sky, drawn the way mountEmptySky draws it, with the sheet's
   * two adaptations for this surface:
   *
   *   · the QUESTION is the centre of the frame here, so it takes the keep-out
   *     the chart would have had (home's adrift copy is two lines and passes 0);
   *   · the law bounds the RING, not the label, and a label runs ~112px further
   *     out than its ring — so the sky the constellations are placed in is
   *     220px narrower than the frame while the drawing still centres on the
   *     real middle. Nothing about the bearings changes; the usable sky is
   *     simply inset.
   */
  function computeCards() {
    if (!hero) return [];
    const w = hero.clientWidth, h = hero.clientHeight;
    const panel = /** @type {HTMLElement | null | undefined} */ (hero.parentElement?.querySelector(".belong"));
    const keepOut = Math.max(200, (panel ? panel.offsetWidth : 430) / 2 + 118);
    const sky = Math.max(640, w - 220);
    const placed = [];
    /* A household the floor pass could not fit anywhere that keeps the 80px
       floor is marked `undrawn` (#670, owner ruling 2026-09-02) and skipped
       — the join list below stays complete regardless, since it is fed
       `visibleHouseholds`, not this sky. */
    for (const { id, household, ox, oy, dim, undrawn } of placeGalaxy({ galaxy, camera: null, width: sky, height: h, keepOut })) {
      if (undrawn) continue;
      const away = ox > 0;
      /** @param {number} x */
      const mx = (x) => (away ? 210 - x : x);
      const ringX = mx(118);
      const label = household.name.toUpperCase();
      const tw = Math.min(150, label.length * 6.6);
      const veer = away ? `M 206 21 H ${200 - tw} L ${184 - tw} 40` : `M 4 21 H ${tw + 10} L ${tw + 26} 40`;
      placed.push({
        id,
        left: w / 2 + ox - ringX,
        top: h / 2 + oy - 95,
        opacity: dim,
        away,
        nameX: mx(6),
        label,
        requested: Boolean(household.requested),
        veer,
        ringX,
        /* A newcomer's sky carries no planets: §11's labelled sky is "id and
           name and nothing else", and labelledSkyOf hands over an empty
           list. The descriptor keeps the field the mockup has, so a sky that
           ever does carry them draws them the same way. */
        planets: household.planets ?? [],
      });
    }
    return placed;
  }

  function render() {
    cards = computeCards();
  }

  onMount(() => {
    const onResize = () => render();
    addEventListener("resize", onResize);
    return () => removeEventListener("resize", onResize);
  });

  /* Drawn once the frame exists, and redrawn when the systems in it change — a
     row that has just been asked to join wears its waiting note. */
  $effect(() => {
    void galaxy;
    render();
  });
</script>

<div class="nf" aria-label="Where do you belong?">
  <div class="sky" aria-hidden="true"><svg viewBox="0 0 1600 1000" preserveAspectRatio="xMidYMid slice">
    <g class="far" fill="var(--star-far)"><g id="nf-far">
      {#each NEWCOMER_FAR as star, i (i)}
        <circle cx={star.cx} cy={star.cy} r={star.r} opacity={star.opacity} />
      {/each}
    </g><use href="#nf-far" x="1600" /></g>
    <g class="near" fill="var(--star-near)"><g id="nf-near">
      {#each NEWCOMER_NEAR as star, i (i)}
        <circle cx={star.cx} cy={star.cy} r={star.r} opacity={star.opacity} />
      {/each}
    </g><use href="#nf-near" x="1600" /></g>
  </svg></div>
  <div class="vignette" aria-hidden="true"></div>
  <!-- The north star, labelled as home labels it. On a sky with no household in
       it, the thing there is to create is a SYSTEM, so it opens the same three
       questions the card at the foot offers. -->
  <button class="nstar" type="button" onclick={oncreate}>
    <svg width="30" height="30" viewBox="-15 -15 30 30" aria-hidden="true">
      <g class="glint">
        <circle r="9" fill="var(--ink)" opacity=".12" />
        <path d="M 0 -12 L 1.7 -1.7 L 12 0 L 1.7 1.7 L 0 12 L -1.7 1.7 L -12 0 L -1.7 -1.7 Z"
              fill="var(--ink)" opacity=".9" />
        <circle r="2" fill="var(--ink)" />
      </g>
    </svg><span>create</span>
  </button>
  <div class="hero" bind:this={hero} aria-hidden="true">
    {#each cards as c (c.id)}
      <div class="minisys" style="left:{c.left}px;top:{c.top}px;opacity:{c.opacity}">
        <svg width="210" height="160" viewBox="0 0 210 160">
          <text x={c.nameX} y="14" font-size="9.5" letter-spacing=".14em"
                style="fill:var(--accent)" opacity=".85"
                text-anchor={c.away ? "end" : undefined}>{c.label}</text>
          {#if c.requested}
            <text x={c.nameX} y="30" font-size="8.5" letter-spacing=".14em"
                  style="fill:var(--ink-faint)"
                  text-anchor={c.away ? "end" : undefined}>ASKED TO JOIN · WAITING</text>
          {/if}
          <path d={c.veer} fill="none" style="stroke:var(--accent)" stroke-width="1" opacity=".55" />
          <circle class="msring" cx={c.ringX} cy="95" r="40" fill="none"
                  style="stroke:var(--chart-line)" stroke-opacity=".5" stroke-width="1" />
          <circle cx={c.ringX} cy="95" r="3" style="fill:var(--ink)" opacity=".8" />
          {#each c.planets as [px, py, pr, token], i (i)}
            <circle cx={c.ringX + px} cy={95 + py} r={pr} style={`fill:var(${token})`} opacity=".55" />
          {/each}
        </svg>
      </div>
    {/each}
  </div>
  <!-- the count: a beat between the settled sky and the question. No box, no
       border, no panel — the number and the words on the sky itself. -->
  <div class="disc" aria-hidden="true">
    <div class="big">{discovered.count}</div>
    <p><b>{discovered.word}</b> discovered in this universe</p>
  </div>
  <div class="belong" role="group" aria-label="Where do you belong?">
    <div class="top">
      <h2>where do you belong?</h2>
      <p>the systems around you are labels until someone lets you in</p>
    </div>
    <ul>
      {#each rows as row (row.id)}
        <li class:waiting={row.requested}>
          <button type="button" disabled={row.requested}
                  onclick={() => onask(row)}
                  aria-label={row.requested ? `Waiting to join ${row.name}` : `Request to join ${row.name}`}>
            <span class="dot"></span><span class="nm">{row.name}</span>
            <span class="act">{row.requested ? "waiting" : "ask to join"}</span>
          </button>
        </li>
      {/each}
    </ul>
    <div class="own">
      <button type="button" onclick={oncreate}>or name your own system →</button>
      <span>a name, a time zone, a currency — same three questions</span>
    </div>
  </div>
</div>
