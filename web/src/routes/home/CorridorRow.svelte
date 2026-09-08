<script>
  /*
   * One corridor row (#469), split out of +page.svelte so `row` can carry a
   * real prop type (#624/#782): the identical `{#snippet corridorRow(row)}`
   * inline in +page.svelte's template has nowhere to put the annotation — a
   * `{#snippet}` parameter is one of the positions where svelte-check accepts
   * an inline `@type` cast but the production rolldown build does not. A
   * component's `$props()` destructuring is a plain `<script>` statement, so
   * it takes the same annotation due-next/EntryRow.svelte already relies on.
   *
   * The expanded item view is rendered from here rather than back up in
   * +page.svelte, because "expanded" is a per-row question — same reason the
   * original snippet rendered `{@render itemview(row)}` from inside itself.
   */
  import { resolve } from "$app/paths";
  import { money } from "$lib/format.js";
  import { BAND_VAR, T_CLASS, tlabel } from "./bands.js";
  import ItemView from "./ItemView.svelte";

  /**
   * @typedef {import('$lib/data/chart.js').CorridorRow} CorridorRowData
   * @typedef {import('$lib/data/workspace.js').ReceiptSuggestion} ReceiptSuggestion
   * @typedef {import('$lib/data/workspace.js').ItemView} ItemViewData
   */
  /** @type {{
   *   row: CorridorRowData,
   *   suggestions: ReceiptSuggestion[] | undefined,
   *   busyReceipt: string | null,
   *   armed: { id: string | null, act: "approve" | "dismiss" | null },
   *   mailProblem: string | null,
   *   expanded: string | null,
   *   onReceiptTap: (suggestion: ReceiptSuggestion, act: "approve" | "dismiss") => void,
   *   onRowClick: (event: MouseEvent, id: string) => void,
   *   detail: ItemViewData | null,
   *   detailBusy: boolean,
   *   detailProblem: string | null,
   *   copied: boolean,
   *   onCopyAddress: () => void,
   * }} */
  let {
    row, suggestions, busyReceipt, armed, mailProblem, expanded,
    onReceiptTap, onRowClick, detail, detailBusy, detailProblem, copied, onCopyAddress,
  } = $props();

  /* $derived, not const: a prop read at the top level of a component's
     script is captured once, so a row instance reused for a different entry
     would keep the first entry's suggestion match, label and meta line (the
     bug fixed in cbea64f for due-next's EntryRow). */
  const suggestionMatch = $derived(suggestions?.find((one) => one.id === row.id));
  /* `row.suggestion` being true is what guarantees a backing suggestion
     exists (home builds corridor rows from the same suggestions list this
     component is handed) — the guard doesn't reach into this closure any
     more than the guards behind home's own `asView` do, so this asserts the
     same invariant the same way. */
  /** @param {ReceiptSuggestion | undefined} s
   *  @returns {ReceiptSuggestion} */
  const asSuggestion = (s) => /** @type {ReceiptSuggestion} */ (s);

  /** @param {string | null} iso */
  const short = (iso) =>
    iso
      ? new Date(iso + "T00:00:00Z").toLocaleDateString("en-GB", { day: "2-digit", month: "short", timeZone: "UTC" })
      : "";

  const suggestionMeta = $derived(
    [
      `Found in ${row.sourceDocument}`,
      row.dueDate ? `renews ${short(row.dueDate)}` : null,
      row.costMinor ? money(row.costMinor, row.currency, true) : null,
    ].filter(Boolean),
  );
  /* `CorridorRow` (lib/data/chart.js) never carries `recurrenceMonths` --
     corridorOf() doesn't copy it onto a row the way manifestGroupsOf() does
     -- so the "orbital period" clause the old inline snippet had here was
     always undefined and always filtered out. Typing `row` for real (#624)
     surfaced that; dropped rather than kept as dead code behind a cast. */
  const meta = $derived(
    [
      row.section,
      row.provider,
      row.costMinor ? money(row.costMinor, row.currency, row.costIsEstimate) : null,
    ].filter(Boolean),
  );
</script>

{#if row.suggestion}
  <div class="item suggest" id={row.id}>
    <span class="planet sug" aria-hidden="true"><i></i></span>
    <div class="body"><b>{row.title}</b><span>{suggestionMeta.join(" · ")}</span></div>
    <!-- #434: approval is the boundary between untrusted mail and
         the household, so it takes two deliberate taps — the first
         arms, the second fires. One operation id per receipt makes
         the write idempotent under any retry. -->
    <div class="actions">
      <button class="yes" disabled={busyReceipt === row.id}
        onclick={() => onReceiptTap(asSuggestion(suggestionMatch), "approve")}>
        {armed.id === row.id && armed.act === "approve" ? "tap again to approve" : "Add to orbit"}
      </button>
      <button disabled={busyReceipt === row.id}
        onclick={() => onReceiptTap(asSuggestion(suggestionMatch), "dismiss")}>
        {armed.id === row.id && armed.act === "dismiss" ? "tap again to dismiss" : "Dismiss"}
      </button>
    </div>
    {#if mailProblem && armed.id === row.id}
      <div class="mail-problem">{mailProblem}</div>
    {/if}
  </div>
{:else}
  <!-- #424: the row is the item. The href is the row's real address —
       kept so a modified click can still open it in its own tab — and
       a plain click expands the row here instead of leaving home. -->
  <a class="item" class:open={expanded === row.id} id={row.id}
     href={resolve(`/home?item=${encodeURIComponent(row.id)}`)} aria-expanded={expanded === row.id}
     aria-controls="{row.id}-view" onclick={(event) => onRowClick(event, row.id)}>
    <span class="planet" class:ter={row.kind === "inspection"} class:con={row.kind === "renewal"}
          style="color:var({BAND_VAR[row.band]})" aria-hidden="true"><i></i></span>
    <div class="body"><b>{row.title}</b><span>{meta.join(" · ")}</span></div>
    {#if row.dueDate}
      <div class="t {T_CLASS[row.band]}">{tlabel(row)}<small>{short(row.dueDate)}</small></div>
    {:else}
      <div class="t ok">—</div>
    {/if}
  </a>
  {#if expanded === row.id}
    <ItemView {row} {detail} {detailBusy} {detailProblem} {copied} {onCopyAddress} />
  {/if}
{/if}
