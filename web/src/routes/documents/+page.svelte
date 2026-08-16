<script>
  /*
   * MOTHBALLED (§14, 2026-08-16): retired from the nav, the dispatcher and
   * the fidelity gate, kept per the owner's ruling in case a use returns.
   * Due next lives on as home's manifest (the corridor); documents' job goes
   * to the belt (#458).
   */
  import { onMount } from "svelte";
  import { readDocumentsScreen } from "$lib/data/workspace.js";
  import { archiveOf } from "$lib/data/documents.js";
  import { fillStarTiles } from "$lib/sky.js";
  import Chrome from "$lib/Chrome.svelte";
  import "./documents.css";

  /**
   * Documents — the belt, unrolled (#462). Built from
   * design/v19/documents.html (ratified §13): every file, its origin where
   * knowable, and the body it circles — wearing that body's dial colour.
   * Dashed means not yet in orbit (the relay's catches awaiting review).
   */
  let view = $state(null);
  let query = $state("");
  let mode = $state("all"); // "all" | household name | "relay" | "loose"

  const archive = $derived(view ? archiveOf(view) : null);
  const shown = $derived.by(() => {
    if (!archive) return null;
    const q = query.trim().toLowerCase();
    const keep = (row) => {
      if (mode === "relay" && !row.viaRelay) return false;
      if (mode === "loose" && !row.loose) return false;
      if (mode !== "all" && mode !== "relay" && mode !== "loose" && row.household !== mode) return false;
      if (!q) return true;
      return [row.name, row.item?.title, row.suggestion, row.household]
        .some((field) => field?.toLowerCase().includes(q));
    };
    const groups = archive.groups
      .map((group) => ({ ...group, rows: group.rows.filter(keep) }))
      .filter((group) => group.rows.length);
    return { ...archive, groups };
  });

  const short = (iso) =>
    new Date(iso).toLocaleDateString("en-GB", { day: "2-digit", month: "short", timeZone: "UTC" });
  const kb = (bytes) => `${Math.round(bytes / 1024)} KB`;
  const BAND_VAR = { overdue: "--overdue", "due-soon": "--warm", upcoming: "--upcoming", ok: "--ok", unscheduled: "--ok" };

  onMount(async () => {
    fillStarTiles(document.getElementById("fartile"), document.getElementById("neartile"));
    view = await readDocumentsScreen();
  });
</script>

<svelte:head><title>Orbit — documents</title></svelte:head>

<div class="archive-page">
<div class="sky" aria-hidden="true">
  <svg viewBox="0 0 1600 1000" preserveAspectRatio="xMidYMid slice">
    <g class="far" fill="var(--star-far)"><g id="fartile"></g><use href="#fartile" x="1600"/></g>
    <g class="near" fill="var(--star-near)"><g id="neartile"></g><use href="#neartile" x="1600"/></g>
  </svg>
</div>
<div class="vignette" aria-hidden="true"></div>

<Chrome user={view?.user} current="documents"
        role={view ? `${view.household?.name ?? ""} · ${view.household?.canManage ? "owner" : "member"}` : ""} />

<div class="page">
  <header class="screen">
    <h1>Documents</h1>
    <div class="sub">the belt, unrolled · every file, its origin, and the body it circles</div>
  </header>

  <div class="findrow">
    <input placeholder="find a document — name, item, or system" aria-label="Search documents"
           bind:value={query}>
  </div>
  {#if view}
    <div class="filters" role="group" aria-label="Filter documents">
      <button class="chip" aria-pressed={mode === "all"} onclick={() => (mode = "all")}>all systems</button>
      {#each view.workspace.households.filter((h) => (h.items ?? []).some((i) => (i.documentCount ?? 0) > 0)) as household (household.id)}
        <button class="chip" aria-pressed={mode === household.name}
                onclick={() => (mode = mode === household.name ? "all" : household.name)}>{household.name}</button>
      {/each}
      <button class="chip" aria-pressed={mode === "relay"} onclick={() => (mode = mode === "relay" ? "all" : "relay")}>via the relay</button>
      <button class="chip" aria-pressed={mode === "loose"} onclick={() => (mode = mode === "loose" ? "all" : "loose")}>not yet attached</button>
    </div>
    {#if archive}
      <div class="facts">
        <span>{archive.total} document{archive.total === 1 ? "" : "s"}</span><span>{archive.megabytes}&nbsp;MB held</span>
        <span>all <b>encrypted</b></span>{#if archive.allClean}<span>all <b>scanned clean</b></span>{/if}
      </div>
    {/if}
  {/if}

  {#if shown}
    {#each shown.groups as group (group.label)}
      <div class="group">
        <h3>{group.label}</h3>
        {#each group.rows as row (row.id)}
          <a class="doc" href="/item/{row.loose ? row.receiptId : row.item.id}">
            <span class="thumb" aria-hidden="true"><small>PDF</small></span>
            <div class="body">
              <b>{row.name}</b>
              <span>added {short(row.addedAt)}{row.sizeBytes ? ` · ${kb(row.sizeBytes)}` : ""}{#if row.clean}<span class="j"> · </span><span class="clean">scanned clean</span>{/if}{#if row.viaRelay}<span class="j"> · </span><span class="via">via your relay</span>{/if}</span>
            </div>
            {#if row.loose}
              <span class="orbitchip loose" title="Awaiting review on your inbox"><i></i>suggested: {row.suggestion}</span>
            {:else}
              <span class="orbitchip" style="color:var({BAND_VAR[row.item.band]})"><i></i>{row.item.title}</span>
              <span class="sys">{row.household.toUpperCase()}</span>
            {/if}
          </a>
        {/each}
      </div>
    {/each}
    {#if !shown.groups.length}
      <div class="nothing">— nothing matches — the belt is quieter than your search —</div>
    {/if}
  {/if}
</div>
</div>
