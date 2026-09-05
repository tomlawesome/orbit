<script>
  /*
   * MOTHBALLED (§14, 2026-08-16): retired from the nav, the dispatcher and
   * the fidelity gate, kept per the owner's ruling in case a use returns.
   * Due next lives on as home's manifest (the corridor); documents' job goes
   * to the belt (#458).
   */
  import { onMount } from "svelte";
  import { corridorOf } from "$lib/data/chart.js";
  import { fillStarTiles } from "$lib/sky.js";
  import { showUrgentCount } from "$lib/urgent-badge.js";
  import Chrome from "$lib/Chrome.svelte";
  import { createDueNextViewState } from "./due-next-view.svelte.js";
  import EntryRow from "./EntryRow.svelte";
  import "./due-next.css";

  /**
   * Due next — the approach corridor (#461). Built from design/v19/due-next.html
   * (ratified §13): the dial answers "how does my sky look?", this answers
   * "what is coming, in order?" — the same physics unrolled onto a line. Time
   * flows down the page; overdue sits in the red zone above today; months are
   * rules, not a scale. Every dot is the item's own dial body.
   */
  const view = createDueNextViewState();
  /* The template only reaches `view.value` from inside a truthy guard, but
     that guard doesn't reach into these standalone functions' closures, so
     this asserts what the call sites already guarantee (same idiom as the
     inbox and settings screens' own `need()`). */
  /** @returns {NonNullable<typeof view.value>} */
  function need() {
    const current = view.value;
    if (current === null) throw new Error("need() called before the corridor loaded");
    return current;
  }

  const filtered = $derived(
    view.value && view.filter
      ? { ...need().workspace, households: need().workspace.households.filter((h) => h.id === view.filter) }
      : view.value
        ? need().workspace
        : undefined,
  );
  const corridor = $derived(view.value ? corridorOf(filtered, need().today) : null);
  /* #763: same truth as home's own badge — this browser's chart, not the
     server. */
  const overdueCount = $derived(corridor?.overdue?.length ?? 0);
  $effect(() => {
    showUrgentCount(overdueCount);
  });

  const todayLine = $derived(
    view.value
      ? new Date(need().today + "T00:00:00Z")
          .toLocaleDateString("en-GB", { weekday: "short", day: "2-digit", month: "short", timeZone: "UTC" })
          .replace(",", "").toUpperCase()
      : "",
  );

  onMount(async () => {
    fillStarTiles(document.getElementById("fartile"), document.getElementById("neartile"));
    await view.load();
  });
</script>

<svelte:head><title>{overdueCount > 0 ? `(${overdueCount}) ` : ""}Orbit — due next</title></svelte:head>

<div class="corridor-page">
<div class="sky" aria-hidden="true">
  <svg viewBox="0 0 1600 1000" preserveAspectRatio="xMidYMid slice">
    <g class="far" fill="var(--star-far)"><g id="fartile"></g><use href="#fartile" x="1600"/></g>
    <g class="near" fill="var(--star-near)"><g id="neartile"></g><use href="#neartile" x="1600"/></g>
  </svg>
</div>
<div class="vignette" aria-hidden="true"></div>

<Chrome user={view.value?.user} current="due-next"
        role={view.value ? `${need().household?.name ?? ""} · ${need().household?.canManage ? "owner" : "member"}` : ""} />

<div class="page">
  <header class="screen">
    <h1>Due next</h1>
    <div class="sub">{corridor
      ? `everything approaching, in order · ${corridor.total} item${corridor.total === 1 ? "" : "s"} across ${corridor.systems} system${corridor.systems === 1 ? "" : "s"} · the next ${corridor.monthsSpanned} months`
      : "everything approaching, in order"}</div>
  </header>

  {#if view.value}
    <div class="filters" role="group" aria-label="Filter by system">
      <button class="chip" aria-pressed={view.filter === null} onclick={() => (view.filter = null)}>all systems</button>
      {#each need().workspace.households as household (household.id)}
        <button class="chip" aria-pressed={view.filter === household.id}
                onclick={() => (view.filter = view.filter === household.id ? null : household.id)}>{household.name}</button>
      {/each}
    </div>
  {/if}

  {#if corridor}
    <div class="corridor">
      {#if corridor.overdue.length}
        <div class="redzone">
          {#each corridor.overdue as row (row.id)}
            <EntryRow {row} />
          {/each}
        </div>
      {/if}

      <div class="today"><span class="sunmark" aria-hidden="true"><i></i><b></b></span><span>TODAY · {todayLine}</span><div class="rule"></div></div>

      {#each corridor.current as row (row.id)}
        <EntryRow {row} />
      {/each}

      {#each corridor.months as month (month.key)}
        <div class="month"><span>{month.label}</span><div class="rule"></div><small>{month.rows.length} approaching</small></div>
        {#each month.rows as row (row.id)}
          <EntryRow {row} />
        {/each}
      {/each}
    </div>

    {#if corridor.total === 0}
      <div class="horizon">— nothing scheduled anywhere: your sky is quiet —</div>
    {:else if corridor.horizon}
      <div class="horizon">— beyond the horizon: nothing scheduled past {corridor.horizon} —</div>
    {/if}
  {/if}
</div>
</div>
