<script>
  import { uuid } from "$lib/uuid.js";
  import { onDestroy, untrack } from "svelte";
  import { dryRunner } from "$lib/data/dry-run.js";
  import { readPendingApproval, readReminders } from "$lib/data/workspace.js";
  import Sheet from "./Sheet.svelte";
  import EntryForm from "../../routes/create/EntryForm.svelte";
  import { createCommandOf, entryChanged, entryOfProposal, reviewItemOf } from "../../routes/create/entry.js";
  import { reminderPairOf } from "../../routes/create/entry.js";
  const uid = $props.id();

  /**
   * REVIEW & AMEND (#1120, proposal §2.5, §2.6; round 3 §4): create's form in
   * review mode in a full sheet, pre-filled with what the relay read, beside
   * ReviewCard.svelte. The inbox, home (a suggestion row's `review & amend →`
   * and the dial's hollow body, in place) and the receipt page all raise
   * this one. `onsave` approves the amended item into the chosen section and
   * answers whether it went in; the sheet closes when it did.
   *
   * While the receipt has a pending approval pair (#1396, owner decision 7a)
   * -- `approval`, given or reported by the receipt's review read -- the
   * amend fields are not drawn: the approval finishes the earlier one with
   * the values it carried, so an amendment made now would not apply.
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
   *   approval?: import('$lib/data/workspace.js').PendingApproval | null,
   *   onsave: (item: import('$lib/data/workspace.js').ItemProposal | null, sectionId: string | null) => Promise<boolean>,
   * }} Props
   */
  /** @type {Props} */
  let {
    open = $bindable(false), title, proposal, householdId, households = [], readings = [], papers = [],
    receiptId = null, busy = false, problem = null, approval = null, onsave,
  } = $props();

  /* The review read's word on a pending approval, asked each time the sheet
     rises. The form is not offered until the read answers: an amendment made
     while a pair is pending would be dropped by the replay, so an unanswered
     check refuses, with a retry, rather than guesses. */
  /** @type {import('$lib/data/workspace.js').PendingApproval | null} */
  let reported = $state(null);
  let checked = $state(false);
  let checkFailed = $state(false);
  /** @type {{ receiptId: string, householdId: string } | null} */
  let query = null;
  const pending = $derived(Boolean(approval ?? reported));

  /** @type {import('../../routes/create/entry.js').Entry | null} */
  let entry = $state(null);
  /** What the form started as (#1151 W1-S2), taken the same moment as
      `entry` — a scrim tap or drag-down used to discard an amended form
      outright; this is what lets the sheet ask first via confirmDiscard. */
  /** @type {import('../../routes/create/entry.js').Entry | null} */
  let start = $state(null);
  /* Whether the member has set the reminders themselves, which a late answer
     from the settings read must not overwrite. */
  let reminderChosen = false;
  /** Counts openings, so an answer for an earlier opening is ignored. */
  let openings = 0;
  /* A fresh form each time the sheet rises, before it draws. */
  $effect.pre(() => {
    if (!open) { openings++; return; }
    untrack(() => {
      entry = entryOfProposal(proposal ?? {}, { householdId });
      start = $state.snapshot(entry);
      reminderChosen = false;
      /* The new item starts from the member's own reminder pair, as create's
         forms do; the form shows the default until it answers. The start
         moves with it, so the seeding alone is not an edit. */
      const opening = ++openings;
      readReminders().catch(() => null).then((reminders) => {
        if (opening !== openings || !entry || !start || reminderChosen) return;
        const pair = reminderPairOf(reminders);
        entry = { ...entry, reminderDays: [...pair] };
        start = { ...start, reminderDays: [...pair] };
      });
      reported = null;
      query = !approval && receiptId && householdId ? { receiptId, householdId } : null;
      checked = !query;
      checkFailed = false;
      if (query) check(opening);
    });
  });
  /** @param {number} opening */
  function check(opening) {
    if (!query) return;
    readPendingApproval(query.receiptId, query.householdId).then((pair) => {
      if (opening !== openings) return;
      reported = pair;
      checked = true;
      checkFailed = false;
    }, () => {
      if (opening === openings) checkFailed = true;
    });
  }
  const recheck = () => { checkFailed = false; check(openings); };
  $effect(() => {
    if (entry && start && JSON.stringify(entry.reminderDays) !== JSON.stringify(start.reminderDays)) reminderChosen = true;
  });
  const household = $derived(households.find((one) => one.id === entry?.householdId) ?? null);
  const dirty = () => Boolean(entry && start && entryChanged(entry, start));

  /* The engine's last word on the amended entry (ADR-0034, #1325), asked as
     the new item it would become: the same "not yet" rules the approval
     meets. "" until the first answer; null when it can be added. */
  /** @type {string | null} */
  let refusal = $state("");
  const standIn = uuid();
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
    if (!entry || busy || !checked) return;
    if (!pending && refusal !== null) return;
    const currency = proposal?.currency ?? household?.currency ?? "GBP";
    /* While a pair is pending no form is offered, so nothing here is an
       amendment: the approval finishes the earlier one and must not be told
       it dropped changes the reader had no field to make. */
    const amended = pending ? null : reviewItemOf(entry, currency, proposal ?? {});
    if (await onsave(amended, pending ? null : entry.sectionId)) open = false;
  }
</script>

<Sheet bind:open size="full" title="Review & amend" confirmDiscard={dirty}>
  {#if entry && pending}
    <form id="{uid}-form" aria-label="Review {title}" onsubmit={(event) => { event.preventDefault(); save(); }}>
      <p class="rv-pending" role="status">finishing your earlier approval</p>
    </form>
    {#if problem}<p class="p-error" role="alert">{problem}</p>{/if}
  {:else if entry && checked}
    <form id="{uid}-form" aria-label="Review {title}" onsubmit={(event) => { event.preventDefault(); save(); }}>
      <EntryForm bind:entry households={household ? [household] : []} mode="review" nested
                 disabled={busy} {readings} {papers} {receiptId} />
    </form>
    {#if problem}<p class="p-error" role="alert">{problem}</p>
    {:else if refusal}<p class="rv-refusal" id="{uid}-refusal">{refusal}</p>{/if}
  {:else if entry}
    <form id="{uid}-form" aria-label="Review {title}" onsubmit={(event) => { event.preventDefault(); save(); }}>
      {#if checkFailed}
        <p class="p-error" role="alert">Orbit could not check for an earlier approval. Nothing was added.</p>
        <button type="button" class="p-pill rv-again" onclick={recheck}>try again</button>
      {:else}
        <p class="rv-pending" role="status">checking for an earlier approval…</p>
      {/if}
    </form>
  {/if}
  {#snippet foot()}
    {@const held = busy || !checked || (!pending && refusal !== null)}
    <button type="submit" form="{uid}-form" class="p-pill filled rv-go" aria-disabled={held ? "true" : undefined}
            aria-describedby={!pending && refusal ? `${uid}-refusal` : undefined}>
      {busy ? "adding…" : "add to orbit"}
    </button>
  {/snippet}
</Sheet>

<style>
  .rv-refusal{margin:12px 0 0;font:var(--p-type-meta)/1.4 var(--mono);color:var(--ink-mid)}
  .rv-pending{margin:0;font:var(--p-type-meta)/1.4 var(--mono);color:var(--ink-mid)}
  .rv-go[aria-disabled="true"]{opacity:.5;cursor:default;box-shadow:none}
</style>
