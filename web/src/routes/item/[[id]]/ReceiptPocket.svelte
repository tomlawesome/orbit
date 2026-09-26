<script>
  import { goto } from "$app/navigation";
  import { resolve } from "$app/paths";
  import { approveReceipt, dismissReceipt } from "$lib/data/workspace.js";
  import { receiptWords, saveProblem } from "$lib/data/metadata-status.js";
  import ReviewCard from "$lib/pocket/ReviewCard.svelte";
  import ReviewSheet from "$lib/pocket/ReviewSheet.svelte";
  import Sky from "$lib/pocket/Sky.svelte";
  import {
    burnsInOf, caughtOf, formReadingsOf, papersOf, readingsOf, reviewLockedOf, reviewTitleOf,
  } from "$lib/pocket/review.js";
  import { wake } from "$lib/pocket/wake.js";

  /**
   * THE RECEIPT PAGE ON A PHONE (round 3 §4, #1140). `/item/<receiptId>` is
   * kept as a page because its address is what a reminder link reaches;
   * home and the inbox raise the review sheet in place instead. Under the
   * top chrome (the page mounts it, `← your sky` and the orb, like every
   * other hop): the inbox's review card verbatim, whose `review & amend →`
   * raises the same full sheet, and whose last line is the quiet way home,
   * `← your sky` -- "decide later", under the acts. Both acts leave the page
   * on success: the wake, and home. The desk keeps Suggestion.svelte.
   * @typedef {{
   *   item: import('$lib/data/workspace.js').ItemView,
   *   households?: import('../../create/entry.js').FormHousehold[],
   *   primary?: string | null,
   * }} Props
   */
  /** @type {Props} */
  let { item, households = [], primary = null } = $props();

  /* This page only mounts for a suggestion (+page.svelte's fork), so the
     item always carries the ReceiptSuggestion fields ItemView makes optional. */
  const suggestion = $derived(/** @type {import('$lib/data/workspace.js').ReceiptSuggestion} */ (item));
  const title = $derived(reviewTitleOf(item));

  /** @type {"approve" | "dismiss" | null} */
  let busy = $state(null);
  /** @type {string | null} */
  let problem = $state(null);
  /** One operation id across retries (approveReceipt's contract). */
  /** @type {string | null} */
  let operationId = null;

  const home = () => goto(resolve("/home"));

  /**
   * @param {import('$lib/data/workspace.js').ItemProposal | null} [amended]
   * @param {string | null} [sectionId]
   * @returns {Promise<boolean>} whether it entered the orbit
   */
  async function approve(amended = null, sectionId = null) {
    if (busy) return false;
    busy = "approve";
    problem = null;
    try {
      operationId ??= crypto.randomUUID();
      const result = await approveReceipt(suggestion, primary, operationId, amended, sectionId);
      if (result.outcome === "partial_success") {
        problem = "The item is recorded, but its documents need another try: add it again to finish.";
        return false;
      }
      operationId = null;
      wake(`added to your orbit · ${amended?.title ?? title}`);
      return true;
    } catch (error) {
      problem = saveProblem(/** @type {{ code?: string, message?: string }} */ (error));
      return false;
    } finally {
      busy = null;
    }
  }

  async function dismiss() {
    if (busy) return;
    busy = "dismiss";
    problem = null;
    try {
      await dismissReceipt(/** @type {string} */ (item.receiptId));
      wake(`dismissed · ${title}`);
      home();
    } catch (error) {
      problem = /** @type {{ message?: string }} */ (error)?.message ?? String(error);
    } finally {
      busy = null;
    }
  }

  /* ---- review & amend: the sheet the inbox and home raise too ---- */
  let reviewOpen = $state(false);
  /** @type {string | null} */
  let reviewProblem = $state(null);

  /**
   * @param {import('$lib/data/workspace.js').ItemProposal} amended
   * @param {string | null} sectionId
   */
  async function saveReview(amended, sectionId) {
    reviewProblem = null;
    const ok = await approve(amended, sectionId);
    if (ok) home();
    else reviewProblem = problem ?? "not added — try again";
    return ok;
  }
</script>

<div class="pk-receipt">
  <Sky />
  <main class="rc-column">
    <ReviewCard {title} caught={caughtOf(item.receivedAt)} burnsIn={burnsInOf(item, item.today)}
                readings={readingsOf(item)} papers={papersOf(item)} unreadable={receiptWords(item.metadataStatus)}
                locked={reviewLockedOf(item)} heading={1} {busy} {problem}
                onapprove={async () => { if (await approve()) home(); }} ondismiss={dismiss}
                onamend={() => { reviewProblem = null; reviewOpen = true; }}>
      {#snippet after()}
        <!-- Round 3 §4 rule 3: a decision screen ends with the way home. -->
        <a class="p-quiet rc-home" href={resolve("/home")}>← your sky</a>
      {/snippet}
    </ReviewCard>
  </main>
</div>

<ReviewSheet bind:open={reviewOpen} {title} proposal={item.proposal} householdId={item.householdId ?? primary}
             {households} readings={formReadingsOf(item)} papers={papersOf(item)}
             busy={busy === "approve"} problem={reviewProblem} onsave={saveReview} />

<style>
  .pk-receipt{position:relative;min-height:100dvh}
  .rc-column{position:relative;z-index:2;box-sizing:border-box;max-width:var(--p-column);margin:0 auto;
    padding:calc(var(--p-chrome) + env(safe-area-inset-top) + 8px) var(--p-gutter)
      calc(40px + env(safe-area-inset-bottom))}
  .rc-home{justify-content:center;margin-top:0}
</style>
