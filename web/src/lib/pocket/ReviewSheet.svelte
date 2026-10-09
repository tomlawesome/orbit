<script>
  import { onDestroy, untrack } from "svelte";
  import { dryRunner } from "$lib/data/dry-run.js";
  import Sheet from "./Sheet.svelte";
  import EntryForm from "../../routes/create/EntryForm.svelte";
  import { createCommandOf, entryChanged, entryOfProposal, reviewItemOf } from "../../routes/create/entry.js";
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
  const dirty = () => Boolean(entry && start && entryChanged(entry, start));

  /* The engine's last word on the amended entry (ADR-0034, #1325), asked as
     the new item it would become: the same "not yet" rules the approval
     meets. "" until the first answer; null when it can be added. */
  /** @type {string | null} */
  let refusal = $state("");
  const standIn = crypto.randomUUID();
  const commandNow = () => entry && household
    ? createCommandOf($state.snapshot(entry), { householdId: household.id, currency: household.currency ?? "GBP", id: standIn })
    : null;
  const dryRun = dryRunner({ onanswer: (answer) => { refusal = answer; } });
  let asked = false;
  $effect(() => {
    if (!open || !entry) { asked = false; refusal = ""; dryRun.stop(); return; }
    JSON.stringify(entry); // every field is the question
    if (asked) dryRun.ask(commandNow);
    else { asked = true; dryRun.now(commandNow); }
  });
  onDestroy(() => dryRun.stop());

  async function save() {
    if (!entry || refusal !== null || busy) return;
    const currency = proposal?.currency ?? household?.currency ?? "GBP";
    if (await onsave(reviewItemOf(entry, currency, proposal ?? {}), entry.sectionId)) open = false;
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
    <button type="submit" form="{uid}-form" class="p-pill filled rv-go" aria-disabled={busy || refusal !== null ? "true" : undefined}
            aria-describedby={refusal ? `${uid}-refusal` : undefined}>
      {busy ? "adding…" : "add to orbit"}
    </button>
  {/snippet}
</Sheet>

<style>
  .rv-refusal{margin:12px 0 0;font:var(--p-type-meta)/1.4 var(--mono);color:var(--ink-mid)}
  .rv-go[aria-disabled="true"]{opacity:.5;cursor:default;box-shadow:none}
</style>
