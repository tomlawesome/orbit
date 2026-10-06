<script>
  import { untrack } from "svelte";
  import Sheet from "./Sheet.svelte";
  import EntryForm from "../../routes/create/EntryForm.svelte";
  import { entryChanged, entryOfProposal, refusalOf, reviewItemOf } from "../../routes/create/entry.js";
  const uid = $props.id();

  /**
   * REVIEW & AMEND (#1120, proposal §2.5, §2.6; round 3 §4): create's form in
   * review mode in a full sheet, pre-filled with what the relay read, beside
   * ReviewCard.svelte. The inbox, home (a suggestion row's `review & amend →`
   * and the dial's hollow body, in place) and the receipt page all raise
   * this one. `onsave` approves the amended item into the chosen section and
   * answers whether it went in; the sheet closes when it did.
   * @typedef {{
   *   open?: boolean,
   *   title: string,
   *   proposal: import('$lib/data/workspace.js').ItemProposal | null | undefined,
   *   householdId: string | null,
   *   households?: import('../../routes/create/entry.js').FormHousehold[],
   *   readings?: import('./review.js').FormReading[],
   *   papers?: { id?: string | null, name: string, meta: string, drawable?: boolean }[],
   *   receiptId?: string | null,
   *   busy?: boolean,
   *   problem?: string | null,
   *   onsave: (item: import('$lib/data/workspace.js').ItemProposal, sectionId: string | null) => Promise<boolean>,
   * }} Props
   */
  /** @type {Props} */
  let {
    open = $bindable(false), title, proposal, householdId, households = [], readings = [], papers = [],
    receiptId = null, busy = false, problem = null, onsave,
  } = $props();

  /** @type {import('../../routes/create/entry.js').Entry | null} */
  let entry = $state(null);
  /** What the form started as (#1151 W1-S2), taken the same moment as
      `entry` — a scrim tap or drag-down used to discard an amended form
      outright; this is what lets the sheet ask first via confirmDiscard. */
  /** @type {import('../../routes/create/entry.js').Entry | null} */
  let start = $state(null);
  /* A fresh form each time the sheet rises, before it draws. */
  $effect.pre(() => {
    if (!open) return;
    untrack(() => {
      entry = entryOfProposal(proposal ?? {}, { householdId });
      start = $state.snapshot(entry);
    });
  });
  const household = $derived(households.find((one) => one.id === entry?.householdId) ?? null);
  const refusal = $derived(entry ? refusalOf(entry) : null);
  const dirty = () => Boolean(entry && start && entryChanged(entry, start));

  async function save() {
    if (!entry || refusal || busy) return;
    const currency = proposal?.currency ?? household?.currency ?? "GBP";
    if (await onsave(reviewItemOf(entry, currency), entry.sectionId)) open = false;
  }
</script>

<Sheet bind:open size="full" title="Review & amend" confirmDiscard={dirty}>
  {#if entry}
    <form id="{uid}-form" aria-label="Review {title}" onsubmit={(event) => { event.preventDefault(); save(); }}>
      <EntryForm bind:entry households={household ? [household] : []} mode="review" nested
                 disabled={busy} {readings} {papers} {receiptId} />
    </form>
    {#if problem}<p class="p-error" role="alert">{problem}</p>
    {:else if refusal}<p class="rv-refusal" id="{uid}-refusal">{refusal}</p>{/if}
  {/if}
  {#snippet foot()}
    <button type="submit" form="{uid}-form" class="p-pill filled rv-go" disabled={busy || Boolean(refusal)}
            aria-describedby={refusal ? `${uid}-refusal` : undefined}>
      {busy ? "adding…" : "add to orbit"}
    </button>
  {/snippet}
</Sheet>

<style>
  .rv-refusal{margin:12px 0 0;font:var(--p-type-meta)/1.4 var(--mono);color:var(--ink-mid)}
  .rv-go:disabled{opacity:.5;cursor:default;box-shadow:none}
</style>
