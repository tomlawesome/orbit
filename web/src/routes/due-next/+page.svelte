<script>
  /*
   * MOTHBALLED (§14, 2026-08-16): retired from the nav, the dispatcher and
   * the fidelity gate, kept per the owner's ruling in case a use returns.
   * Due next lives on as home's manifest (the corridor); documents' job goes
   * to the belt (#458).
   */
  import { onMount } from "svelte";
  import { readDueNext } from "$lib/data/workspace.js";
  import { corridorOf } from "$lib/data/chart.js";
  import { money } from "$lib/format.js";
  import { fillStarTiles } from "$lib/sky.js";
  import Chrome from "$lib/Chrome.svelte";
  import "./due-next.css";

  /**
   * Due next — the approach corridor (#461). Built from design/v19/due-next.html
   * (ratified §13): the dial answers "how does my sky look?", this answers
   * "what is coming, in order?" — the same physics unrolled onto a line. Time
   * flows down the page; overdue sits in the red zone above today; months are
   * rules, not a scale. Every dot is the item's own dial body.
   */
  let view = $state(null);
  let filter = $state(null); // household id, or null = all systems

  const filtered = $derived(
    view && filter
      ? { ...view.workspace, households: view.workspace.households.filter((h) => h.id === filter) }
      : view?.workspace,
  );
  const corridor = $derived(view ? corridorOf(filtered, view.today) : null);

  const tlabel = (row) => (row.days < 0 ? `T+${-row.days}d` : `T−${row.days}d`);
  const short = (iso) =>
    new Date(iso + "T00:00:00Z").toLocaleDateString("en-GB", { day: "2-digit", month: "short", timeZone: "UTC" });
  const BAND_VAR = { overdue: "--overdue", "due-soon": "--warm", upcoming: "--upcoming", ok: "--ok" };
  const T_CLASS = { overdue: "over", "due-soon": "soon", upcoming: "up", ok: "ok" };
  const meta = (row) => [
    row.section,
    row.provider,
    row.costMinor ? money(row.costMinor, row.currency, row.costIsEstimate) : null,
  ].filter(Boolean);
  const todayLine = $derived(
    view
      ? new Date(view.today + "T00:00:00Z")
          .toLocaleDateString("en-GB", { weekday: "short", day: "2-digit", month: "short", timeZone: "UTC" })
          .replace(",", "").toUpperCase()
      : "",
  );

  onMount(async () => {
    fillStarTiles(document.getElementById("fartile"), document.getElementById("neartile"));
    view = await readDueNext();
  });
</script>

<svelte:head><title>Orbit — due next</title></svelte:head>

<div class="corridor-page">
<div class="sky" aria-hidden="true">
  <svg viewBox="0 0 1600 1000" preserveAspectRatio="xMidYMid slice">
    <g class="far" fill="var(--star-far)"><g id="fartile"></g><use href="#fartile" x="1600"/></g>
    <g class="near" fill="var(--star-near)"><g id="neartile"></g><use href="#neartile" x="1600"/></g>
  </svg>
</div>
<div class="vignette" aria-hidden="true"></div>

<Chrome user={view?.user} current="due-next"
        role={view ? `${view.household?.name ?? ""} · ${view.household?.canManage ? "owner" : "member"}` : ""} />

<div class="page">
  <header class="screen">
    <h1>Due next</h1>
    <div class="sub">{corridor
      ? `everything approaching, in order · ${corridor.total} item${corridor.total === 1 ? "" : "s"} across ${corridor.systems} system${corridor.systems === 1 ? "" : "s"} · the next ${corridor.monthsSpanned} months`
      : "everything approaching, in order"}</div>
  </header>

  {#if view}
    <div class="filters" role="group" aria-label="Filter by system">
      <button class="chip" aria-pressed={filter === null} onclick={() => (filter = null)}>all systems</button>
      {#each view.workspace.households as household (household.id)}
        <button class="chip" aria-pressed={filter === household.id}
                onclick={() => (filter = filter === household.id ? null : household.id)}>{household.name}</button>
      {/each}
    </div>
  {/if}

  {#if corridor}
    <div class="corridor">
      {#if corridor.overdue.length}
        <div class="redzone">
          {#each corridor.overdue as row (row.id)}
            {@render entry(row)}
          {/each}
        </div>
      {/if}

      <div class="today"><span class="sunmark" aria-hidden="true"><i></i><b></b></span><span>TODAY · {todayLine}</span><div class="rule"></div></div>

      {#each corridor.current as row (row.id)}
        {@render entry(row)}
      {/each}

      {#each corridor.months as month (month.key)}
        <div class="month"><span>{month.label}</span><div class="rule"></div><small>{month.rows.length} approaching</small></div>
        {#each month.rows as row (row.id)}
          {@render entry(row)}
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

{#snippet entry(row)}
  <a class="item" href="/item/{row.id}">
    <span class="planet" class:ter={row.kind === "inspection"} class:con={row.kind === "renewal"}
          style="color:var({BAND_VAR[row.band]})"><i></i></span>
    <div class="body"><b>{row.title}</b><span><span class="sys" class:away={row.away}
      >{row.household.toUpperCase()}</span>{meta(row).length ? ` · ${meta(row).join(" · ")}` : ""}</span></div>
    <div class="t {T_CLASS[row.band]}">{tlabel(row)}<small>{short(row.dueDate)}</small></div>
  </a>
{/snippet}
