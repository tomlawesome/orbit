<script>
  /*
   * WHAT A MANIFEST ROW OPENS INTO ON A PHONE (#1120, review round §2.1):
   * the desk's ItemView (ItemView.svelte) at the pocket's scale, as the
   * `detail` of the kit's Row. Key/value lines in the desk's order -- due,
   * snoozed until, section, type, orbital period, cost, provider,
   * reference, reminders -- then the papers, then the notes. The acts and
   * `copy link` are the row's own (pocket.svelte).
   *
   * A component rather than a snippet in pocket.svelte, for the reason
   * ItemView.svelte gives: a snippet's parameter has nowhere to carry its
   * type that both the type checker and the production bundler accept.
   */
  import { every, longDate, money } from "$lib/format.js";
  import { DAMAGED, LOCKED, NOTES_WORDS, REFERENCE_WORDS, fieldState } from "$lib/data/metadata-status.js";

  /** @type {{
   *   one: { id: string, title: string, band: string, dueDate: string | null, days: number | null, section: string | null,
   *          recurrenceMonths: number | null, costMinor: number | null, currency: string, costIsEstimate: boolean },
   *   raw?: import('$lib/data/workspace.js').WorkspaceItem,
   *   papers: { id: string, name: string, meta?: string }[],
   *   reading?: boolean,
   *   problem?: string | null,
   * }} */
  let { one, raw = undefined, papers, reading = false, problem = null } = $props();

  /** @type {Record<string, string>} */
  const TONE = { overdue: "over", "due-soon": "soon", upcoming: "up", ok: "ok", ended: "ended" };
  const tlabel = $derived(one.days === null ? "" : one.days < 0 ? `T+${-one.days}d` : `T−${one.days}d`);
  const referenceState = $derived(fieldState(raw?.metadataStatus, "reference"));
  const notesState = $derived(fieldState(raw?.metadataStatus, "notes"));
</script>

<div class="p-kv"><span>due</span>
  <b class={TONE[one.band] ?? ""}>{one.dueDate ? `${tlabel} · ${longDate(one.dueDate)}` : "unscheduled"}</b></div>
{#if raw?.snoozedUntil}<div class="p-kv"><span>snoozed until</span><b>{longDate(raw.snoozedUntil)}</b></div>{/if}
{#if one.section}<div class="p-kv"><span>section</span><b>{one.section}</b></div>{/if}
{#if raw?.subtype}<div class="p-kv"><span>type</span><b>{raw.subtype}</b></div>{/if}
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
{#if papers.length || reading}
  <h3 class="p-caps">Documents</h3>
  {#each papers as paper (paper.id)}
    <!-- Not tappable here, as on the desk: the belt is where a paper opens. -->
    <p class="paper"><span class="p-paper" aria-hidden="true">◆</span><span class="name">{paper.name}</span><span class="meta">{paper.meta}</span></p>
  {:else}
    <div class="p-unlit"></div>
  {/each}
{/if}
{#if raw?.notes}
  <h3 class="p-caps">Notes</h3>
  <p class="p-prose note">{raw.notes}</p>
{:else if notesState === DAMAGED || notesState === LOCKED}
  <h3 class="p-caps">Notes</h3>
  <p class="p-prose note quiet">{NOTES_WORDS[notesState]}</p>
{/if}
{#if problem}<p class="p-error" role="alert">{problem}</p>{/if}

<style>
  .p-kv{align-items:baseline}
  .p-kv span{flex:none}
  .p-kv b{min-width:0;text-align:right;overflow-wrap:anywhere}
  .p-caps{margin:16px 0 4px}
  .paper{display:flex;align-items:baseline;flex-wrap:wrap;gap:4px 8px;margin:0;padding:6px 0;
    font:var(--p-type-meta)/1.4 var(--mono);color:var(--ink)}
  .paper .name{min-width:0;overflow-wrap:anywhere}
  .paper .meta{color:var(--ink-quiet)}
  .note{margin:0;color:var(--ink-mid)}
  .note.quiet{color:var(--ink-quiet)}
</style>
