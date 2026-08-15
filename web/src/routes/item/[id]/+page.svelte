<script>
  import { onMount } from "svelte";
  import { goto, invalidateAll } from "$app/navigation";
  import { mountItemSky } from "./sky.js";
  import { DESIGN_TODAY, day, every, longDate, money, tminus } from "$lib/format.js";
  import { applyCommand } from "$lib/data/workspace.js";
  import {
    archiveCommand,
    completeCommand,
    nextDateAfter,
    rescheduleCommand,
    snoozeCommand,
    statusCommand,
    upsertCommand,
  } from "$lib/data/commands.js";
  import "./item.css";

  /**
   * One item, in full (#424) — and since #455, in hand: every command the
   * engine already speaks (complete, reschedule, snooze, archive, cancel,
   * edit) is reachable from here, through the same seam and the same
   * optimistic-concurrency contract the shipped app used.
   *
   * Reached by clicking its row in the manifest. The dial still anchors to the
   * row, exactly as CON-5 specifies — the row is the destination of a click on
   * a body — and the row is now itself a link onward to here.
   *
   * No mockup draws this screen. Rather than invent one, it is composed from
   * vocabulary the design already ratified: the family stage and glass card,
   * the relay's label/value rows, home's document row, the create form's
   * fields and buttons. See item.css, which names the source of every rule.
   */
  let { data } = $props();
  const item = $derived(data.item);

  let panel = $state(null);
  let busy = $state(false);
  let problem = $state(null);
  let form = $state({});

  const todayISO = () => new Date().toISOString().slice(0, 10);
  const pounds = (minor) => (minor === null || minor === undefined ? "" : (minor / 100).toFixed(2));
  const minorOf = (text) => {
    const value = Number.parseFloat(String(text).replace(",", "."));
    return Number.isFinite(value) ? Math.round(value * 100) : undefined;
  };

  function open(name) {
    problem = null;
    panel = panel === name ? null : name;
    if (panel === "complete") {
      const done = todayISO();
      form = {
        completedDate: done,
        nextDate: nextDateAfter(done, item.recurrenceMonths) ?? "",
        cost: pounds(item.costMinor),
        notes: "",
      };
    }
    if (panel === "reschedule") form = { dueDate: item.dueDate ?? todayISO() };
    if (panel === "snooze") form = { until: item.snoozedUntil ?? todayISO() };
    if (panel === "edit") {
      form = {
        title: item.title,
        provider: item.provider ?? "",
        reference: item.reference ?? "",
        cost: pounds(item.costMinor),
        dueDate: item.dueDate ?? "",
        recurrenceMonths: item.recurrenceMonths ?? "",
        notes: item.notes ?? "",
      };
    }
  }

  /* One writer. Success either re-reads this view or returns to the orbit —
     completing and archiving change what this URL even means, so they leave.
     A 409 (version_conflict) surfaces in the server's own words and the
     re-read shows the truth that beat us; nothing is silently overwritten. */
  async function run(build, { leave = false } = {}) {
    busy = true;
    problem = null;
    try {
      await applyCommand(build());
      panel = null;
      if (leave) await goto("/home");
      else await invalidateAll();
    } catch (error) {
      problem = error?.message ?? String(error);
      if (error?.code === "version_conflict") await invalidateAll();
    } finally {
      busy = false;
    }
  }

  const editsOf = () => ({
    title: form.title.trim(),
    provider: form.provider.trim() || undefined,
    reference: form.reference.trim() || undefined,
    costMinor: minorOf(form.cost),
    dueDate: form.dueDate || undefined,
    recurrenceMonths: form.recurrenceMonths ? Number(form.recurrenceMonths) : undefined,
    notes: form.notes.trim() || undefined,
  });

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
      <b class:over={day(item.dueDate) < day(item.today ?? DESIGN_TODAY)}>
        {tminus(item.dueDate, item.today ?? DESIGN_TODAY)} · {longDate(item.dueDate)}
      </b>
    </div>
    {#if item.snoozedUntil}
      <div class="kv"><span>snoozed until</span><b>{longDate(item.snoozedUntil)}</b></div>
    {/if}
    {#if item.status !== "active"}
      <div class="kv"><span>status</span><b>{item.status}</b></div>
    {/if}
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

    <h4>actions</h4>
    <div class="acts" role="group" aria-label="Item actions">
      {#if item.status === "active"}
        <button aria-pressed={panel === "complete"} onclick={() => open("complete")}>complete</button>
        <button aria-pressed={panel === "reschedule"} onclick={() => open("reschedule")}>reschedule</button>
        <button aria-pressed={panel === "snooze"} onclick={() => open("snooze")}>snooze</button>
        <button aria-pressed={panel === "edit"} onclick={() => open("edit")}>edit</button>
        <button aria-pressed={panel === "retire"} onclick={() => open("retire")}>retire</button>
      {:else}
        <button disabled={busy} onclick={() => run(() => statusCommand(item, "active"))}>restore</button>
        {#if item.status !== "archived"}
          <button aria-pressed={panel === "retire"} onclick={() => open("retire")}>retire</button>
        {/if}
      {/if}
    </div>

    {#if panel === "complete"}
      <div class="panel">
        <div class="row2">
          <div class="field"><label for="a-done">completed on</label>
            <input id="a-done" type="date" bind:value={form.completedDate}></div>
          {#if item.recurrenceMonths}
            <div class="field"><label for="a-next">next orbit</label>
              <input id="a-next" type="date" bind:value={form.nextDate}></div>
          {/if}
        </div>
        <div class="row2">
          <div class="field mono"><label for="a-cost">actual cost</label>
            <input id="a-cost" inputmode="decimal" bind:value={form.cost} placeholder="optional"></div>
        </div>
        <div class="field"><label for="a-cnotes">notes</label>
          <input id="a-cnotes" bind:value={form.notes} placeholder="optional"></div>
        <div class="save-row">
          <button class="btn-primary" disabled={busy || !form.completedDate}
            onclick={() => run(() => completeCommand(item, {
              completedDate: form.completedDate,
              nextDate: form.nextDate || undefined,
              costMinor: minorOf(form.cost),
              notes: form.notes.trim() || undefined,
            }), { leave: !form.nextDate })}>complete</button>
          <button class="cancel-link" onclick={() => (panel = null)}>never mind</button>
        </div>
      </div>
    {/if}

    {#if panel === "reschedule"}
      <div class="panel">
        <div class="field"><label for="a-due">new due date</label>
          <input id="a-due" type="date" bind:value={form.dueDate}></div>
        <div class="save-row">
          <button class="btn-primary" disabled={busy || !form.dueDate}
            onclick={() => run(() => rescheduleCommand(item, form.dueDate))}>reschedule</button>
          <button class="cancel-link" onclick={() => (panel = null)}>never mind</button>
        </div>
      </div>
    {/if}

    {#if panel === "snooze"}
      <div class="panel">
        <div class="field"><label for="a-until">snooze until</label>
          <input id="a-until" type="date" bind:value={form.until}></div>
        <div class="save-row">
          <button class="btn-primary" disabled={busy || !form.until}
            onclick={() => run(() => snoozeCommand(item, form.until))}>snooze</button>
          <button class="cancel-link" onclick={() => (panel = null)}>never mind</button>
        </div>
      </div>
    {/if}

    {#if panel === "edit"}
      <div class="panel">
        <div class="field"><label for="e-title">title</label>
          <input id="e-title" bind:value={form.title}></div>
        <div class="row2">
          <div class="field"><label for="e-provider">provider</label>
            <input id="e-provider" bind:value={form.provider} placeholder="optional"></div>
          <div class="field"><label for="e-reference">reference</label>
            <input id="e-reference" bind:value={form.reference} placeholder="optional"></div>
        </div>
        <div class="row2">
          <div class="field mono"><label for="e-cost">typical cost</label>
            <input id="e-cost" inputmode="decimal" bind:value={form.cost} placeholder="optional"></div>
          <div class="field"><label for="e-due">due date</label>
            <input id="e-due" type="date" bind:value={form.dueDate}></div>
        </div>
        <div class="field"><label for="e-recur">orbital period (months)</label>
          <input id="e-recur" inputmode="numeric" bind:value={form.recurrenceMonths} placeholder="optional"></div>
        <div class="field"><label for="e-notes">notes</label>
          <textarea id="e-notes" rows="3" bind:value={form.notes} placeholder="optional"></textarea></div>
        <div class="save-row">
          <button class="btn-primary" disabled={busy || !form.title.trim()}
            onclick={() => run(() => upsertCommand(item, editsOf()))}>save changes</button>
          <button class="cancel-link" onclick={() => (panel = null)}>never mind</button>
        </div>
      </div>
    {/if}

    {#if panel === "retire"}
      <div class="panel">
        <div class="note">
          retiring takes this item off the chart — archive keeps its history;
          cancel marks it stood down and it can be restored later
        </div>
        <div class="save-row">
          <button class="btn-primary" disabled={busy}
            onclick={() => run(() => archiveCommand(item), { leave: true })}>archive</button>
          {#if item.status === "active"}
            <button class="btn-quiet" disabled={busy}
              onclick={() => run(() => statusCommand(item, "cancelled"))}>cancel item</button>
          {/if}
          <button class="cancel-link" onclick={() => (panel = null)}>never mind</button>
        </div>
      </div>
    {/if}

    {#if problem}
      <div class="problem" role="alert">{problem}</div>
    {/if}

    <a class="back" href="/home#{item.id}">← back to your orbit</a>
  </article>
</div>
<div class="vignette" aria-hidden="true"></div>
