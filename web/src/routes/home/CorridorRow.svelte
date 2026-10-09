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
  import { sectionColourOf } from "$lib/option-colour.js";
  import Mark from "$lib/Mark.svelte";
  import { BAND_VAR, T_CLASS, tlabel } from "./bands.js";
  import ItemView from "./ItemView.svelte";
  import SuggestionView from "./SuggestionView.svelte";

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
   *   today: string,
   *   expanded: string | null,
   *   onReceiptTap: (suggestion: ReceiptSuggestion, act: "approve" | "dismiss") => void,
   *   onRowClick: (event: MouseEvent, id: string) => void,
   *   detail: ItemViewData | null,
   *   detailBusy: boolean,
   *   detailProblem: string | null,
   *   copied: boolean,
   *   onCopyAddress: () => void,
   *   showingDoc: string | null,
   *   onOpenDoc: (doc: import('$lib/data/workspace.js').DrawerDocument, from: HTMLElement) => void,
   *   acts: import('./drawer-acts.js').DrawerActs,
   * }} */
  let {
    row, suggestions, busyReceipt, armed, mailProblem, today, expanded,
    onReceiptTap, onRowClick, detail, detailBusy, detailProblem, copied, onCopyAddress, showingDoc, onOpenDoc, acts,
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

  /* #1005: a renewal comes round, a one-off ends -- and once its date is past
     it has ended. The suggestion's own schedule kind is what says which. */
  const dateWord = $derived(
    suggestionMatch?.scheduleKind === "expiry" ? (row.days < 0 ? "ended" : "ends") : "renews",
  );
  const suggestionMeta = $derived(
    [
      `Found in ${row.sourceDocument}`,
      row.dueDate ? `${dateWord} ${short(row.dueDate)}` : null,
      row.costMinor ? money(row.costMinor, row.currency, true) : null,
    ].filter(Boolean),
  );
  /* `CorridorRow` (lib/data/chart.js) never carries `recurrenceMonths` --
     corridorOf() doesn't copy it onto a row the way manifestGroupsOf() does
     -- so the "orbital period" clause the old inline snippet had here was
     always undefined and always filtered out. Typing `row` for real (#624)
     surfaced that; dropped rather than kept as dead code behind a cast. */
  /* round 8 (#1319): the section word leads the line in its own colour;
     the rest follows it in the row's own ink. */
  const meta = $derived(
    [
      /* #1319: a retired item, or a one-off already done, says so first */
      row.state,
      row.provider,
      row.costMinor ? money(row.costMinor, row.currency, row.costIsEstimate) : null,
    ].filter(Boolean),
  );
  /** Between the meta line's parts. */
  const SEP = " · ";
  const sectionOpt = $derived(sectionColourOf({ id: row.sectionId, icon: row.sectionIcon }));
  /* #1319 stage 2: while this item is being edited its head is no longer a
     link — the title edits in place in it (round 8, `editing`), and a
     press on it leaves the drawer as it is. */
  const draft = $derived(acts.modes.edit.id === row.id ? acts.modes.edit.draft : null);
</script>

{#if row.suggestion}
  <!-- #1145 (owner, 2026-09-27): a suggestion opens as a drawer like the
       manifest items. The row at rest is what it was -- the hollow mark, the
       title, `Found in … · renews … · ~£…` -- and it opens in place exactly
       as a filed row does (#424's shallow address, Back, Escape, click-off),
       into SuggestionView: the relay's readings and how sure it was, the
       paper it came in, when it burns up, and the two decisions, which used
       to sit on the row. #1319: it is reviewed there too -- `review & amend
       →` puts the drawer's rows into editing, and the title edits here in
       the head, as a filed row's does. -->
  {#if draft && expanded === row.id}
    <div class="item suggest open editing" id={row.id}>
      <span class="planet sug" aria-hidden="true"><i></i></span>
      <div class="body">
        <b class="ed" contenteditable="plaintext-only" spellcheck="false" role="textbox" tabindex="0"
           aria-label="title" data-ed="title" bind:textContent={draft.title}></b>
        <span>{suggestionMeta.join(" · ")}</span>
      </div>
    </div>
  {:else}
  <a class="item suggest" class:open={expanded === row.id} id={row.id}
     href={resolve(`/home?item=${encodeURIComponent(row.id)}`)} aria-expanded={expanded === row.id}
     aria-controls="{row.id}-view" onclick={(event) => onRowClick(event, row.id)}>
    <span class="planet sug" aria-hidden="true"><i></i></span>
    <div class="body"><b>{row.title}</b><span>{suggestionMeta.join(" · ")}</span></div>
  </a>
  {/if}
  {#if expanded === row.id}
    <SuggestionView {row} suggestion={asSuggestion(suggestionMatch)} {busyReceipt} {armed} {mailProblem}
                    {today} {onReceiptTap} {copied} {onCopyAddress} {showingDoc} {onOpenDoc} {acts} />
  {/if}
{:else}
  <!-- #424: the row is the item. The href is the row's real address —
       kept so a modified click can still open it in its own tab — and
       a plain click expands the row here instead of leaving home. -->
  {#snippet face()}
    <span class="planet" style="color:var({BAND_VAR[row.band]})" aria-hidden="true"><i></i></span>
    <!-- #867: the section's own mark, beside the entry, 14px (12px svg,
         4px dot) — the manifest's own copy of the shared table (Mark.svelte,
         marks.js), not a redraw. -->
    {#if row.sectionIcon}<Mark icon={row.sectionIcon} accent={row.sectionAccent} size={12} aria-hidden="true" />{/if}
    <div class="body">
      {#if draft}
        <b class="ed" contenteditable="plaintext-only" spellcheck="false" role="textbox" tabindex="0"
           aria-label="title" data-ed="title" bind:textContent={draft.title}></b>
      {:else}
        <b>{row.title}</b>
      {/if}
      <span>{#if row.section}<i class="opt" data-opt={sectionOpt}>{row.section}</i>{#if meta.length}{SEP}{/if}{/if}{meta.join(" · ")}</span>
    </div>
    {#if row.dueDate}
      <div class="t {T_CLASS[row.band]}">{tlabel(row)}<small>{short(row.dueDate)}</small></div>
    {:else}
      <div class="t ok">—</div>
    {/if}
  {/snippet}
  {#if draft && expanded === row.id}
    <div class="item open editing" id={row.id}>{@render face()}</div>
  {:else}
  <!-- #424: the row is the item. The href is the row's real address —
       kept so a modified click can still open it in its own tab — and
       a plain click expands the row here instead of leaving home. -->
  <a class="item" class:open={expanded === row.id} id={row.id}
     href={resolve(`/home?item=${encodeURIComponent(row.id)}`)} aria-expanded={expanded === row.id}
     aria-controls="{row.id}-view" onclick={(event) => onRowClick(event, row.id)}>{@render face()}</a>
  {/if}
  {#if expanded === row.id}
    <ItemView {row} {detail} {detailBusy} {detailProblem} {showingDoc} {onOpenDoc} {acts} />
  {/if}
{/if}

<style>
  /* round 8: the section word in its own colour (packs.css maps data-opt
     onto --opt-text); never on the dial */
  .opt{font-style:normal;color:var(--opt-text, inherit)}
  /* round 2's literal edit: the title live in the head, in its own type —
     a 1px accent line under it and the caret */
  .ed{display:block;width:fit-content;max-width:100%;min-width:6ch;outline:none;caret-color:var(--accent);
    box-shadow:0 1px 0 var(--accent);cursor:text}
  .ed:focus{box-shadow:0 1.5px 0 var(--accent)}
</style>
