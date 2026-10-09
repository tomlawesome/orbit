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
  import FootRow from "./FootRow.svelte";
  import EditRows from "./EditRows.svelte";
  import { sectionColourOf, typeColourOf } from "$lib/option-colour.js";
  import { every, longDate, money, tminus } from "$lib/format.js";
  import { DAMAGED, LOCKED, NOTES_WORDS, REFERENCE_WORDS, fieldState, itemLocked } from "$lib/data/metadata-status.js";

  /**
   * @typedef {import('$lib/data/chart.js').CorridorRow} CorridorRowData
   * @typedef {import('$lib/data/workspace.js').ItemView} ItemViewData
   * @typedef {import('$lib/data/workspace.js').DrawerDocument} DrawerDocument
   * @typedef {import('./drawer-acts.js').DrawerActs} DrawerActs
   */
  /** @type {{
   *   row: CorridorRowData,
   *   detail: ItemViewData | null,
   *   detailBusy: boolean,
   *   detailProblem: string | null,
   *   showingDoc: string | null,
   *   onOpenDoc: (doc: DrawerDocument, from: HTMLElement) => void,
   *   acts: DrawerActs,
   * }} */
  let { row, detail, detailBusy, detailProblem, showingDoc, onOpenDoc, acts } = $props();

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

  /* #941: the corridor's expanded detail shows the same two Tier 1 fields as
     the item screen, and hid the same two states behind the same truthiness
     test. Same vocabulary, from the one module that owns it -- the state has
     to be visible wherever the field is, or a member reads a damaged note as
     one they never wrote on whichever screen they happened to open. */
  const referenceState = $derived(fieldState(detail?.metadataStatus, "reference"));
  const notesState = $derived(fieldState(detail?.metadataStatus, "notes"));

  /* #1319 stage 2: what the drawer is doing besides reading — editing in
     the rows, or asking for a completion (drawer-modes.svelte.js). */
  const modes = $derived(acts.modes);
  const mode = $derived(modes.edit.id === row.id ? "edit" : modes.completing?.id === row.id ? "complete" : "read");
  const snoozing = $derived(modes.foot?.key === "snooze" && modes.id === row.id);
  /* round 8: the section and type words wear their own colour */
  const sectionOpt = $derived(sectionColourOf(acts.sections.find((one) => one.id === detail?.sectionId)));
</script>

<div class="itemview" id="{row.id}-view" role="region" aria-label="{row.title} — full detail">
  {#if detailProblem}
    <div class="ivproblem" role="alert">{detailProblem}</div>
  {:else if !detail}
    <div class="ivnote">{detailBusy ? "reading…" : ""}</div>
  {:else}
    {#if mode !== "read"}
      <EditRows {modes} sections={acts.sections} snoozedUntil={detail.snoozedUntil} status={detail.status}
                costLocked={itemLocked(detail.metadataStatus)} />
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
      <div class="kv"><span>section</span><b class="opt" data-opt={sectionOpt}>{detail.section}</b></div>
    {/if}
    {#if detail.subtype}
      <div class="kv"><span>type</span><b class="opt" data-opt={typeColourOf(detail.subtype)}>{detail.subtype}</b></div>
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
    {:else if referenceState === DAMAGED}
      <div class="kv"><span>reference</span>
        <b class="failed"><i aria-hidden="true"></i>{REFERENCE_WORDS[DAMAGED]}</b></div>
    {:else if referenceState === LOCKED}
      <div class="kv"><span>reference</span><b class="locked">{REFERENCE_WORDS[LOCKED]}</b></div>
    {/if}
    {#if detail.reminderDays?.length}
      <div class="kv"><span>reminders</span>
        <b>{detail.reminderDays.map((d) => `${d}d before`).join(" · ")}</b></div>
    {/if}
    <!-- #1319 (owner, 2026-10-08): notes above documents. -->
    {#if detail.notes}
      <h2>notes</h2>
      <p class="ivnotes">{detail.notes}</p>
    {:else if notesState}
      <h2>notes</h2>
      <p class="ivnotes {notesState === DAMAGED ? 'failed' : 'locked'}">{NOTES_WORDS[notesState]}</p>
    {/if}
    {/if}
    {#if detail.documents?.length}
      <h2>documents</h2>
      <!-- #1319, round 3: every row opens the preview card, the honest
           states too -- the card says "still scanning" or "removed" itself.
           The open one wears the accent at its left edge and says so. -->
      {#each detail.documents as document (document.id)}
        {@const on = showingDoc === document.id}
        <button type="button" class="doc" class:showing={on} data-doc-row aria-haspopup="dialog"
                aria-current={on ? "true" : undefined} aria-label="Open {document.name}"
                onclick={(event) => onOpenDoc(document, event.currentTarget)}>
          <span class="mark" aria-hidden="true">◆</span>
          <span class="name">{document.name}<small>{document.meta}</small></span>
          <em class="go" aria-hidden="true">{on ? "showing" : "open →"}</em>
        </button>
      {/each}
    {/if}
    <!-- #1319 (owner-decisions §34): the foot row holds every act the belt
         had; `manage this item →` is gone, the drawer is the item now. -->
    <FootRow title={row.title} busy={acts.busy} {mode} {snoozing} onrestore={acts.onrestore}
             discarding={acts.modes.discardArmed} standing={row.restorable ? "ended" : row.state ? "done" : null}
             onsnooze={acts.onsnooze} oncomplete={acts.oncomplete} onattach={acts.onattach}
             onretire={acts.onretire} oncopy={acts.oncopy} onedit={acts.onedit}
             onsave={acts.onsave} onrecord={acts.onrecord} oncancel={acts.oncancel}
             held={acts.modes.edit.refused} />
    {#if acts.problem}<div class="ivproblem" role="alert">{acts.problem}</div>{/if}
  {/if}
</div>

<style>
  /* round 8: a section or type value in its own colour (packs.css maps
     data-opt onto --opt-text). Written as `.kv b.opt`, not `.opt`: a bare
     `.opt` lost to home.css's `.itemview .kv b{color:var(--ink)}`, so the
     desk drawer's values stayed ink while the row's section word wore its
     colour. */
  .kv b.opt{color:var(--opt-text, var(--ink))}
</style>
