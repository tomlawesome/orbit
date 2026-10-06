<script>
  import { onMount } from "svelte";
  import { CREDITS, FONTS, SIDECARS } from "$lib/about/credits.js";
  import { creditsView, letterOf } from "$lib/about/group.js";
  import { buildLineOf, readAbout, readSession, readWorkspace } from "$lib/data/workspace.js";
  import { fillStarTiles } from "$lib/sky.js";
  import Chrome from "$lib/Chrome.svelte";
  import Credit from "./Credit.svelte";
  import "./about.css";

  /**
   * About (#1256; design record on the issue, 2026-10-06): what this Orbit
   * runs on, and the credits and licences for everything it ships. One
   * responsive layout, the helm's, at every width (owner, answer 8).
   *
   * Cards 2 and 3 are drawn from data the page already holds -- the hand-kept
   * lists in $lib/about/credits.js and the libraries the server load read
   * from the bill of materials -- so they render even when card 1's read
   * fails. Everything is on the page, with no search and no collapsing, so
   * the browser's own find works and the credits are actually shown.
   */
  /** @type {{ data: { libraries: import("$lib/about/group.js").Library[] | null } }} */
  let { data } = $props();

  /** @type {import("$lib/data/workspace.js").AboutFacts | null} */
  let about = $state(null);
  /** @type {string | null} */
  let aboutProblem = $state(null);
  /** @type {{ user: any, household: any } | null} */
  let chrome = $state(null);

  const credits = $derived(creditsView({ pictures: CREDITS, fonts: FONTS, sidecars: SIDECARS, libraries: data.libraries }));
  const libraries = $derived(credits.groups.find((group) => group.id === "credits-libraries")?.entries ?? null);
  const byLetter = $derived(
    credits.letters.filter((one) => one.id).map((one) => ({
      ...one,
      entries: (libraries ?? []).filter((entry) => letterOf(entry.name) === one.letter),
    })),
  );
  const unlettered = $derived((libraries ?? []).filter((entry) => !letterOf(entry.name)));

  /* Spelled as a value: whitespace at the edge of a block is trimmed. */
  const SEPARATOR = " · ";
  const SIDECAR_NAMES = { postgres: "PostgreSQL", tika: "Tika", clamav: "ClamAV", ollama: "Ollama" };

  /** The card's own read, broken out so "try again" can repeat it (settings' loadScreen shape). */
  async function loadAbout() {
    aboutProblem = null;
    try {
      about = await readAbout();
    } catch {
      aboutProblem = "not shown — Orbit could not read what it runs on";
    }
  }

  onMount(async () => {
    fillStarTiles(
      /** @type {SVGGElement} */ (/** @type {unknown} */ (document.getElementById("fartile"))),
      /** @type {SVGGElement} */ (/** @type {unknown} */ (document.getElementById("neartile"))),
    );
    /* The chrome's who-and-where is additive: without it the menu still opens. */
    Promise.all([readWorkspace(), readSession().catch(() => null)])
      .then(([workspace, session]) => {
        const primary = workspace.activeHouseholdId ?? workspace.households[0]?.id ?? null;
        chrome = {
          user: session?.user ?? null,
          household: workspace.households.find((one) => one.id === primary) ?? null,
        };
      })
      .catch(() => {});
    await loadAbout();
  });
</script>

<svelte:head><title>Orbit — about</title></svelte:head>

<div class="about-page">
<div class="sky" aria-hidden="true">
  <svg viewBox="0 0 1600 1000" preserveAspectRatio="xMidYMid slice">
    <g class="far" fill="var(--star-far)"><g id="fartile"></g><use href="#fartile" x="1600"/></g>
    <g class="near" fill="var(--star-near)"><g id="neartile"></g><use href="#neartile" x="1600"/></g>
  </svg>
</div>
<div class="vignette" aria-hidden="true"></div>

<Chrome user={chrome?.user} current="about"
        role={chrome?.household ? `${chrome.household.name ?? ""} · ${chrome.household.canManage ? "owner" : "member"}` : ""} />

<div class="page" role="main">
  <header class="screen">
    <h1>About</h1>
    <div class="sub">what this Orbit runs on, and whose work it carries</div>
  </header>

  <div class="cards">
    <section class="card wide orbit" aria-labelledby="about-orbit">
      <h2 id="about-orbit">This Orbit</h2>
      {#if about}
        {@const line = buildLineOf(about.build)}
        <div class="kv"><span>Orbit</span>{#if line}<b>{line}</b>{:else}<i class="unknown">not known</i>{/if}</div>
        <div class="kv image"><span>Image</span>{#if about.build.image}<b>{about.build.image}</b>{:else}<i class="unknown">not known</i>{/if}</div>
        <div class="kv"><span>Node</span>{#if about.node}<b>{about.node}</b>{:else}<i class="unknown">not known</i>{/if}</div>
        {#each about.sidecars as sidecar (sidecar.id)}
          <div class="kv"><span>{SIDECAR_NAMES[sidecar.id] ?? sidecar.id}</span>
            {#if sidecar.state === "off"}<span class="off">not running</span>
            {:else if sidecar.version}<b>{sidecar.version}</b>
            {:else}<i class="unknown">not known</i>{/if}</div>
        {/each}
      {:else if aboutProblem}
        <p class="note">{aboutProblem}</p>
        <button class="again" onclick={loadAbout}>try again</button>
      {/if}
    </section>

    <section class="card wide credits" aria-labelledby="about-credits">
      <h2 id="about-credits">Credits</h2>
      <nav class="tells" aria-label="Credits index">
        {#each credits.groups as group (group.id)}
          <!-- A same-page anchor to the group below, not a route. -->
          <!-- eslint-disable-next-line svelte/no-navigation-without-resolve -->
          <a class="role" href="#{group.id}">{group.title} · {group.count ?? "—"}</a>
        {/each}
      </nav>

      {#each credits.groups as group (group.id)}
        <h3 class="group" id={group.id}>{group.title}</h3>
        {#if group.id === "credits-libraries"}
          {#if libraries}
            <div class="letters" aria-label="Libraries by letter">
              {#each credits.letters as one (one.letter)}
                {#if one.id}
                  <!-- eslint-disable-next-line svelte/no-navigation-without-resolve -->
                  <a href="#{one.id}">{one.letter}</a>
                {:else}
                  <span aria-hidden="true">{one.letter}</span>
                {/if}
              {/each}
            </div>
            {#each unlettered as one (one.id)}<Credit entry={one} />{/each}
            {#each byLetter as one (one.letter)}
              <div class="letter" id={one.id}>
                {#each one.entries as library (library.id)}<Credit entry={library} />{/each}
              </div>
            {/each}
          {:else}
            <p class="note">not shown — this build carries no bill of materials; a release build does</p>
          {/if}
        {:else}
          {#each group.entries ?? [] as one (one.id)}<Credit entry={one} />{/each}
        {/if}
      {/each}
    </section>

    <section class="card wide licences" aria-labelledby="about-licences">
      <h2 id="about-licences">Licences</h2>
      {#each credits.licences as licence (licence.key)}
        <div class="kv" id={licence.id}>
          <b>{licence.name}</b>
          <span>used by {licence.users}{#if licence.href}{SEPARATOR}<a rel="external" href={licence.href}>the text</a>{/if}</span>
        </div>
      {/each}
    </section>
  </div>
</div>
</div>
