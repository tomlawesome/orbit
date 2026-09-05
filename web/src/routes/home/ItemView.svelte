<script>
  /*
   * The item detail panel a corridor row expands into (#424), split out of
   * +page.svelte so `row` and `detail` can carry real prop types (#624/#782):
   * the identical `{#snippet itemview(row)}` inline in +page.svelte's
   * template has nowhere to put the annotation — a `{#snippet}` parameter is
   * one of the positions where svelte-check accepts an inline `@type` cast
   * but the production rolldown build does not. A component's `$props()`
   * destructuring is a plain `<script>` statement, so it takes the same
   * annotation CorridorRow.svelte and due-next/EntryRow.svelte already rely
   * on.
   */
  import { resolve } from "$app/paths";
  import { every, longDate, money, tminus } from "$lib/format.js";

  /**
   * @typedef {import('$lib/data/chart.js').CorridorRow} CorridorRowData
   * @typedef {import('$lib/data/workspace.js').ItemView} ItemViewData
   */
  /** @type {{
   *   row: CorridorRowData,
   *   detail: ItemViewData | null,
   *   detailBusy: boolean,
   *   detailProblem: string | null,
   *   copied: boolean,
   *   onCopyAddress: () => void,
   * }} */
  let { row, detail, detailBusy, detailProblem, copied, onCopyAddress } = $props();

  /* The directive expression below (class:over={...}) does not carry an
     inline @type cast comment through to the type checker the way a plain
     {...} interpolation does, same reason home's own asAny existed — and
     ItemView's own type has no `band` field, since readItem's live shape
     was never given one. */
  /** @type {(v: any) => any} */
  const asAny = (v) => v;
  /** @param {ItemViewData} one */
  const detailDue = (one) =>
    one.dueDate ? `${tminus(one.dueDate, one.today)} · ${longDate(one.dueDate)}` : "unscheduled";
</script>

<div class="itemview" id="{row.id}-view" role="region" aria-label="{row.title} — full detail">
  {#if detailProblem}
    <div class="ivproblem" role="alert">{detailProblem}</div>
  {:else if !detail}
    <div class="ivnote">{detailBusy ? "reading…" : ""}</div>
  {:else}
    <div class="kv"><span>due</span>
      <b class:over={asAny(detail).band === "overdue" || row.band === "overdue"}>{detailDue(detail)}</b></div>
    {#if detail.snoozedUntil}
      <div class="kv"><span>snoozed until</span><b>{longDate(detail.snoozedUntil)}</b></div>
    {/if}
    {#if detail.status !== "active"}
      <div class="kv"><span>status</span><b>{detail.status}</b></div>
    {/if}
    {#if detail.section}
      <div class="kv"><span>section</span><b>{detail.section}</b></div>
    {/if}
    {#if detail.subtype}
      <div class="kv"><span>type</span><b>{detail.subtype}</b></div>
    {/if}
    {#if detail.recurrenceMonths}
      <div class="kv"><span>orbital period</span><b>{every(detail.recurrenceMonths)}</b></div>
    {/if}
    <div class="kv"><span>cost</span>
      <b>{money(detail.costMinor, detail.currency ?? "GBP", /** @type {any} */ (detail).costIsEstimate)}</b></div>
    {#if detail.provider}
      <div class="kv"><span>provider</span><b>{detail.provider}</b></div>
    {/if}
    {#if detail.reference}
      <div class="kv"><span>reference</span><b>{detail.reference}</b></div>
    {/if}
    {#if detail.reminderDays?.length}
      <div class="kv"><span>reminders</span>
        <b>{detail.reminderDays.map((d) => `${d}d before`).join(" · ")}</b></div>
    {/if}
    {#if detail.documents?.length}
      <h4>documents</h4>
      {#each detail.documents as document (document.name)}
        <div class="doc">◆<span>{document.name}<small>{document.meta}</small></span></div>
      {/each}
    {/if}
    {#if detail.notes}
      <h4>notes</h4>
      <p>{detail.notes}</p>
    {/if}
    <div class="ivfoot">
      <button class="ivcopy" onclick={onCopyAddress}>{copied ? "link copied" : "copy link"}</button>
      <a class="ivfull" href={resolve("/item/[id]", { id: row.id })}>manage this item →</a>
    </div>
  {/if}
</div>
