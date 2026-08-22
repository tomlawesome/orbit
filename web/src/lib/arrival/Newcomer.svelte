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
  let {
    /* the labelled sky, from $lib/data/chart.js's labelledSkyOf */
    galaxy = {},
    /* every system on the instance, as the count reads it */
    visibleHouseholds = [],
    onask = () => {},
    oncreate = () => {},
  } = $props();

  let hero;
  const rows = $derived(belongRowsOf(galaxy));
  const discovered = $derived(discoveredCountOf(visibleHouseholds));

  const SVG = "http://www.w3.org/2000/svg";

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
  function render() {
    if (!hero) return;
    for (const old of hero.querySelectorAll(".minisys")) old.remove();
    const w = hero.clientWidth, h = hero.clientHeight;
    const card = hero.parentElement?.querySelector(".belong");
    const keepOut = Math.max(200, (card ? card.offsetWidth : 430) / 2 + 118);
    const sky = Math.max(640, w - 220);
    for (const { household, ox, oy, dim } of placeGalaxy({ galaxy, camera: null, width: sky, height: h, keepOut })) {
      const away = ox > 0;
      const mx = (x) => (away ? 210 - x : x);
      const ringX = mx(118);
      const div = document.createElement("div");
      div.className = "minisys";
      div.style.left = (w / 2 + ox - ringX) + "px";
      div.style.top = (h / 2 + oy - 95) + "px";
      div.style.opacity = dim;
      const label = household.name.toUpperCase();
      const tw = Math.min(150, label.length * 6.6);
      const veer = away ? `M 206 21 H ${200 - tw} L ${184 - tw} 40` : `M 4 21 H ${tw + 10} L ${tw + 26} 40`;
      const svg = document.createElementNS(SVG, "svg");
      svg.setAttribute("width", "210");
      svg.setAttribute("height", "160");
      svg.setAttribute("viewBox", "0 0 210 160");
      const put = (tag, attrs, text) => {
        const el = document.createElementNS(SVG, tag);
        for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, value);
        if (text !== undefined) el.textContent = text;
        svg.appendChild(el);
        return el;
      };
      const name = put("text", {
        x: mx(6), y: 14, "font-size": "9.5", "letter-spacing": ".14em",
        style: "fill:var(--accent)", opacity: ".85",
      }, label);
      if (away) name.setAttribute("text-anchor", "end");
      if (household.requested) {
        const asked = put("text", {
          x: mx(6), y: 30, "font-size": "8.5", "letter-spacing": ".14em",
          style: "fill:var(--ink-faint)",
        }, "ASKED TO JOIN · WAITING");
        if (away) asked.setAttribute("text-anchor", "end");
      }
      put("path", { d: veer, fill: "none", style: "stroke:var(--accent)", "stroke-width": "1", opacity: ".55" });
      put("circle", { class: "msring", cx: ringX, cy: 95, r: 40, fill: "none", style: "stroke:var(--chart-line)", "stroke-opacity": ".5", "stroke-width": "1" });
      put("circle", { cx: ringX, cy: 95, r: 3, style: "fill:var(--ink)", opacity: ".8" });
      /* A newcomer's sky carries no planets: §11's labelled sky is "id and name
         and nothing else", and labelledSkyOf hands over an empty list. The
         drawing keeps the loop the mockup has, so a sky that ever does carry
         them draws them the same way. */
      for (const [px, py, pr, token] of household.planets ?? []) {
        put("circle", { cx: ringX + px, cy: 95 + py, r: pr, style: `fill:var(${token})`, opacity: ".55" });
      }
      div.appendChild(svg);
      hero.appendChild(div);
    }
  }

  onMount(() => {
    const onResize = () => render();
    addEventListener("resize", onResize);
    return () => {
      removeEventListener("resize", onResize);
      if (hero) for (const old of hero.querySelectorAll(".minisys")) old.remove();
    };
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
  <div class="hero" bind:this={hero} aria-hidden="true"></div>
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
