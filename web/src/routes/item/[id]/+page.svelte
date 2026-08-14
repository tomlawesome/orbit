<script>
  import { onMount } from "svelte";
  import { mountItemSky } from "./sky.js";
  import "./item.css";

  /**
   * One item, in full (#424).
   *
   * Reached by clicking its row in the manifest. The dial still anchors to the
   * row, exactly as CON-5 specifies — the row is the destination of a click on
   * a body — and the row is now itself a link onward to here.
   *
   * No mockup draws this screen. Rather than invent one, it is composed from
   * vocabulary the design already ratified: the family stage and glass card,
   * the relay's label/value rows, home's document row. See item.css, which
   * names the source of every rule.
   *
   * Read-only on purpose. Completing, rescheduling, snoozing and archiving all
   * exist as commands server-side and none is reachable; making them reachable
   * is a separate slice with its own design question, recorded on #410.
   */
  let { data } = $props();
  const item = $derived(data.item);

  const money = (minor, currency, estimate) => {
    if (minor === null || minor === undefined) return "—";
    const amount = new Intl.NumberFormat("en-GB", { style: "currency", currency })
      .format(minor / 100);
    return estimate ? `~${amount}` : amount;
  };

  /* The manifest's own vocabulary: a date, and how far away it is in days.
     Pinned to the design's today so the view agrees with the chart that sent
     you here rather than with the wall clock. */
  const TODAY = "2026-08-13";
  const day = (iso) => Math.round(Date.parse(iso + "T00:00:00Z") / 86400000);
  const tminus = (due) => {
    const days = day(due) - day(TODAY);
    return days < 0 ? `T+${-days}d` : `T−${days}d`;
  };
  const longDate = (iso) => new Date(iso + "T00:00:00Z").toLocaleDateString("en-GB", {
    day: "numeric", month: "long", year: "numeric", timeZone: "UTC",
  });
  const every = (months) =>
    months === 12 ? "every year" : months === 1 ? "every month" : `every ${months} months`;

  /* POL-11: every page's sky drifts. Decorative and aria-hidden, so a reader
     without JavaScript loses only the stars, never the item. */
  let sky;
  onMount(() => mountItemSky(sky));
</script>

<svelte:head>
  <link rel="stylesheet" href="/screens/family.css" />
  <title>{item.title} — Orbit</title>
</svelte:head>

<div class="sky" aria-hidden="true" bind:this={sky}></div>

<div class="stage">
  <article class="glass item-card">
    <h2>{item.title}</h2>
    <div class="sub">{item.section} · {item.subtype}</div>

    <div class="kv">
      <span>due</span>
      <b class:over={day(item.dueDate) < day(TODAY)}>
        {tminus(item.dueDate)} · {longDate(item.dueDate)}
      </b>
    </div>
    <div class="kv"><span>orbital period</span><b>{every(item.recurrenceMonths)}</b></div>
    <div class="kv">
      <span>typical cost</span>
      <b>{money(item.costMinor, item.currency, item.costIsEstimate)}</b>
    </div>
    {#if item.provider}
      <div class="kv"><span>provider</span><b>{item.provider}</b></div>
    {/if}
    {#if item.reference}
      <div class="kv"><span>reference</span><b>{item.reference}</b></div>
    {/if}
    <div class="kv">
      <span>reminders</span>
      <b>{item.reminderDays.map((d) => `${d}d before`).join(" · ")}</b>
    </div>

    {#if item.documents.length}
      <h4>documents</h4>
      {#each item.documents as document (document.name)}
        <div class="doc">◆<span>{document.name}<small>{document.meta}</small></span></div>
      {/each}
    {/if}

    {#if item.notes}
      <h4>notes</h4>
      <p>{item.notes}</p>
    {/if}

    <!-- Honest about what this screen cannot yet do. Every one of these
         commands exists server-side and none is reachable; the copy says so
         rather than drawing buttons that do nothing. -->
    <div class="note">
      read only for now — completing, rescheduling and archiving are not wired
      to this screen yet
    </div>
    <a class="back" href="/home#{item.id}">← back to your orbit</a>
  </article>
</div>
<div class="vignette" aria-hidden="true"></div>
