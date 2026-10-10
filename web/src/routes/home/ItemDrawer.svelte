<script>
  /*
   * WHAT A MANIFEST ROW OPENS INTO ON A PHONE (#1120, review round §2.1):
   * the desk's ItemView (ItemView.svelte) at the pocket's scale, as the
   * `detail` of the kit's Row. Key/value lines in the desk's order -- due,
   * snoozed until, section, type, orbital period, cost, provider,
   * reference, reminders -- then the notes, then the papers (#1319: notes
   * above documents), each `name · size · added <date>` (review round
   * §6.f) and each opening the preview sheet; then the foot row
   * (FootRow.svelte), as the desk's.
   *
   * A component rather than a snippet in pocket.svelte, for the reason
   * ItemView.svelte gives: a snippet's parameter has nowhere to carry its
   * type that both the type checker and the production bundler accept.
   */
  import { every, longDate, money } from "$lib/format.js";
  import { DAMAGED, LOCKED, NOTES_WORDS, REFERENCE_WORDS, fieldState, itemLocked } from "$lib/data/metadata-status.js";
  import { sectionColourOf, typeColourOf } from "$lib/option-colour.js";
  import { T_CLASS } from "$lib/data/bands.js";
  import FootRow from "./FootRow.svelte";
  import EditRows from "./EditRows.svelte";

  /** A paper as the search reads it (pocket-search.js), carrying the belt's
      own row since #1319, so it opens the preview sheet.
      @typedef {import('./pocket-search.js').SearchDocument & Partial<import('$lib/data/belt.js').BeltDocumentRow>} Paper */

  /** @type {{
   *   one: { id: string, title: string, band: string, dueDate: string | null, days: number | null, section: string | null,
   *          recurrenceMonths: number | null, costMinor: number | null, currency: string, costIsEstimate: boolean,
   *          state?: string | null, restorable?: boolean },
   *   raw?: import('$lib/data/workspace.js').WorkspaceItem,
   *   papers: Paper[],
   *   reading?: boolean,
   *   problem?: string | null,
   *   showingPaper?: string | null,
   *   onopenpaper?: (paper: Paper, from: HTMLElement) => void,
   *   acts?: import('./drawer-acts.js').DrawerActs,
   * }} */
  let {
    one, raw = undefined, papers, reading = false, problem = null, showingPaper = null, onopenpaper = undefined,
    acts = undefined,
  } = $props();

  const tlabel = $derived(one.days === null ? "" : one.days < 0 ? `T+${-one.days}d` : `T−${one.days}d`);
  const referenceState = $derived(fieldState(raw?.metadataStatus, "reference"));
  const notesState = $derived(fieldState(raw?.metadataStatus, "notes"));

  /* #1319 stage 2: editing in the rows, or asking for a completion
     (drawer-modes.svelte.js), as on the desk; the title edits live in the
     row's head (pocket.svelte hands the kit Row its `heading`). */
  const mode = $derived(!acts ? "read" : acts.modes.edit.id === one.id ? "edit"
    : acts.modes.completing?.id === one.id ? "complete" : "read");
  const snoozing = $derived(Boolean(acts && acts.modes.foot?.key === "snooze" && acts.modes.id === one.id));
  /* round 8: the section and type words wear their own colour */
  const sectionOpt = $derived(sectionColourOf(acts?.sections.find((s) => s.id === raw?.sectionId)));
</script>

{#if acts && mode !== "read"}
  <EditRows modes={acts.modes} sections={acts.sections} pocket snoozedUntil={raw?.snoozedUntil ?? null}
            costLocked={itemLocked(raw?.metadataStatus)} />
{:else}
<div class="p-kv"><span>due</span>
  <b class={T_CLASS[one.band] ?? ""}>{one.dueDate ? `${tlabel} · ${longDate(one.dueDate)}` : "unscheduled"}</b></div>
{#if raw?.snoozedUntil}<div class="p-kv"><span>snoozed until</span><b>{longDate(raw.snoozedUntil)}</b></div>{/if}
{#if one.section}<div class="p-kv"><span>section</span><b class="opt" data-opt={sectionOpt}>{one.section}</b></div>{/if}
{#if raw?.subtype}<div class="p-kv"><span>type</span><b class="opt" data-opt={typeColourOf(raw.subtype)}>{raw.subtype}</b></div>{/if}
{#if one.recurrenceMonths}<div class="p-kv"><span>orbital period</span><b>{every(one.recurrenceMonths)}</b></div>{/if}
<div class="p-kv"><span>cost</span><b>{money(one.costMinor, one.currency, one.costIsEstimate)}</b></div>
{#if raw?.provider}<div class="p-kv"><span>provider</span><b>{raw.provider}</b></div>{/if}
{#if raw?.reference}
  <div class="p-kv"><span>reference</span><b>{raw.reference}</b></div>
{:else if referenceState === DAMAGED || referenceState === LOCKED}
  <div class="p-kv"><span>reference</span><b class="ended">{REFERENCE_WORDS[referenceState]}</b></div>
{/if}
{#if raw?.reminderDays?.length}
  <div class="p-kv"><span>reminders</span><b>{raw.reminderDays.map((d) => `${d}d before`).join(" · ")}</b></div>
{/if}
<!-- #1319 (owner, 2026-10-08): notes above documents, as on the desk. -->
{#if raw?.notes}
  <h3 class="p-caps">Notes</h3>
  <p class="p-prose note">{raw.notes}</p>
{:else if notesState === DAMAGED || notesState === LOCKED}
  <h3 class="p-caps">Notes</h3>
  <p class="p-prose note quiet">{NOTES_WORDS[notesState]}</p>
{/if}
{/if}
{#if papers.length || reading}
  <h3 class="p-caps">Documents</h3>
  {#each papers as paper (paper.id)}
    {@const on = showingPaper === paper.id}
    <!-- #1319: a paper opens the preview as the phone's bottom sheet, here
         rather than on the belt; the page in it opens the reader. -->
    <button type="button" class="paper" class:showing={on} data-doc-row aria-haspopup="dialog"
            aria-current={on ? "true" : undefined} aria-label="Open {paper.name}"
            onclick={(event) => onopenpaper?.(paper, event.currentTarget)}>
      <span class="p-paper" aria-hidden="true">◆</span><span class="name">{paper.name}</span>{#if paper.meta}<span class="meta">{paper.meta}</span>{/if}
    </button>
  {:else}
    <div class="p-unlit"></div>
  {/each}
{/if}
{#if acts}
  <!-- #1319: the desk's foot row, at the pocket's scale. -->
  <FootRow title={one.title} pocket busy={acts.busy} {mode} {snoozing} onrestore={acts.onrestore}
           discarding={acts.modes.discardArmed} standing={one.restorable ? "ended" : one.state ? "done" : null}
           onsnooze={acts.onsnooze} oncomplete={acts.oncomplete} onattach={acts.onattach}
           onretire={acts.onretire} oncopy={acts.oncopy} onedit={acts.onedit}
           onsave={acts.onsave} onrecord={acts.onrecord} oncancel={acts.oncancel}
           held={acts.modes.edit.refused} />
{/if}
{#if problem || acts?.problem}<p class="p-error" role="alert">{problem ?? acts?.problem}</p>{/if}

<style>
  .p-kv{align-items:baseline}
  .p-kv span{flex:none}
  .p-kv b{min-width:0;text-align:right;overflow-wrap:anywhere}
  .p-caps{margin:16px 0 4px}
  .paper{display:flex;align-items:baseline;flex-wrap:wrap;gap:4px 8px;margin:0;padding:10px 0;
    width:100%;min-height:var(--p-hit);box-sizing:border-box;text-align:left;cursor:pointer;
    background:none;border:0;border-bottom:1px solid var(--line-soft);-webkit-appearance:none;appearance:none;
    font:var(--p-type-meta)/1.4 var(--mono);color:var(--ink);-webkit-tap-highlight-color:transparent}
  .paper:focus-visible{outline:2px solid var(--accent);outline-offset:2px;border-radius:4px}
  /* the open one wears the accent at its left edge and on its name (round 3) */
  .paper.showing{border-left:3px solid var(--accent);padding-left:8px}
  .paper.showing .name{color:var(--accent-text)}
  .paper .name{min-width:0;overflow-wrap:anywhere}
  .paper .meta{color:var(--ink-quiet)}
  /* name · size · added <date> (review round §6.f): what the data holds, no
     more; a part it lacks is left out, never a dash. */
  .paper .meta::before{content:"· "}
  .note{margin:0;color:var(--ink-mid)}
  .note.quiet{color:var(--ink-quiet)}
  /* round 8: a section or type value in its own colour */
  .opt{color:var(--opt-text, inherit)}
</style>
