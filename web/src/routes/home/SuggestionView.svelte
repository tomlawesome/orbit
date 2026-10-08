<script>
  /*
   * WHAT A SUGGESTION ROW OPENS INTO ON THE DESK (#1145, owner 2026-09-27:
   * "let the suggested items open as a drawer like the manifest items"). The
   * filed row's drawer is ItemView.svelte; this is its twin for the relay's
   * catch, in the same .itemview grammar: key/value lines -- the readings,
   * each with how sure the relay was, then when it burns up -- the paper it
   * came in, the two decisions that used to sit on the row at rest (#434's
   * two taps, one operation id per receipt), and the foot: `copy link` and
   * `review & amend →`.
   *
   * REVIEWED HERE, NOT ON THE BELT (#1319; owner-decisions §34: "suggestions
   * are reviewed in their home drawer", superseding §27's belt card).
   * Everything the belt's card did is done in this drawer:
   *   - the paper it came in opens the preview card beside the drawer, as a
   *     filed item's documents do (round 3), with the belt's own staged
   *     states (`Not yet in orbit.`) -- attached on acceptance;
   *   - `review & amend →` puts the drawer's own rows into editing
   *     (EditRows.svelte, the item drawer's grammar: the labels stay, only
   *     the value is live, the choosers stand beside), the proposal standing
   *     in for the item it would become; `add to orbit` and `cancel` take
   *     the decisions' place, and the title edits in the row's head;
   *   - a locked proposal (#941) cannot be amended, only dismissed.
   *
   * The phone has its own (SuggestionDrawer.svelte, the kit's Row detail);
   * both read the readings from review.js so the two say one thing.
   *
   * A component rather than a snippet for the reason ItemView.svelte gives.
   */
  import EditRows from "./EditRows.svelte";
  import { longDate } from "$lib/format.js";
  import { burnsInOf, readingsOf, reviewLockedOf } from "$lib/pocket/review.js";
  import { receiptWords } from "$lib/data/metadata-status.js";
  import { suggestionPapersOf } from "$lib/data/belt.js";

  /**
   * @typedef {import('$lib/data/chart.js').CorridorRow} CorridorRowData
   * @typedef {import('$lib/data/workspace.js').ReceiptSuggestion} ReceiptSuggestion
   * @typedef {import('$lib/data/workspace.js').DrawerDocument} DrawerDocument
   */
  /** @type {{
   *   row: CorridorRowData,
   *   suggestion: ReceiptSuggestion,
   *   busyReceipt: string | null,
   *   armed: { id: string | null, act: "approve" | "dismiss" | null },
   *   mailProblem: string | null,
   *   today: string,
   *   onReceiptTap: (suggestion: ReceiptSuggestion, act: "approve" | "dismiss") => void,
   *   copied: boolean,
   *   onCopyAddress: () => void,
   *   showingDoc: string | null,
   *   onOpenDoc: (doc: DrawerDocument, from: HTMLElement) => void,
   *   acts: import('./drawer-acts.js').DrawerActs,
   * }} */
  let {
    row, suggestion, busyReceipt, armed, mailProblem, today, onReceiptTap, copied, onCopyAddress,
    showingDoc, onOpenDoc, acts,
  } = $props();

  const readings = $derived(readingsOf(suggestion));
  const burnsIn = $derived(burnsInOf(suggestion, today));
  const burnsOn = $derived(suggestion.expiresAt ? longDate(suggestion.expiresAt.slice(0, 10)) : null);
  /* #941: nothing to add until an administrator restores the key; the way in
     is shown, and shut. Dismiss stays, so a receipt is never trapped. */
  const locked = $derived(reviewLockedOf(suggestion));
  const unreadable = $derived(receiptWords(suggestion.metadataStatus));
  /* The papers by name where the list names them (#467), else the count,
     each the belt's staged row, so the preview card can open it. */
  const papers = $derived(suggestionPapersOf(suggestion));
  const busy = $derived(busyReceipt === row.id);
  /* A fixture suggestion (#454) has no mail behind it and nothing to decide. */
  const decidable = $derived(Boolean(suggestion.receiptId));
  /* #1319: the rows are being amended */
  const amending = $derived(acts.modes.edit.id === row.id);
  const adding = $derived(amending && acts.modes.edit.busy);
</script>

<div class="itemview suggestview" id="{row.id}-view" role="region" aria-label="{row.title} — suggested, not yet in orbit">
  {#if amending}
    <EditRows modes={acts.modes} sections={acts.sections} />
  {:else}
    {#each readings as reading (reading.field)}
      <div class="kv"><span>{reading.label}</span>
        <b>{reading.value}{#if reading.sure !== null}<i class="sure" class:unsure={!reading.sure}>{reading.sure ? "sure" : "unsure"}</i>{/if}</b></div>
    {/each}
    {#if burnsOn}
      <div class="kv"><span>burns up</span>
        <b class:soon={burnsIn !== null && burnsIn < 14}>{burnsIn !== null ? `in ${burnsIn}d · ` : ""}{burnsOn}</b></div>
    {/if}
  {/if}
  {#if papers.length}
    <h4>documents</h4>
    <!-- #1319: the paper it came in opens the preview card beside the
         drawer, as a filed item's documents do; the card says itself when
         Orbit has no page for it. -->
    {#each papers as paper (paper.id)}
      {@const on = showingDoc === paper.id}
      <button type="button" class="doc" class:showing={on} data-doc-row aria-haspopup="dialog"
              aria-current={on ? "true" : undefined} aria-label="Open {paper.name}"
              onclick={(event) => onOpenDoc(paper, event.currentTarget)}>
        <span class="mark" aria-hidden="true">◆</span>
        <span class="name">{paper.name}<small>{paper.meta}</small></span>
        <em class="go" aria-hidden="true">{on ? "showing" : "open →"}</em>
      </button>
    {/each}
  {/if}
  {#if unreadable}
    <p class="unread">{unreadable}</p>
  {/if}
  {#if decidable && amending}
    <!-- #1319: while the rows are amended, `add to orbit` and `cancel` take
         the decisions' place, as save and cancel take the pills' in a filed
         item's drawer. -->
    <div class="actions" role="group" aria-label="Amending {row.title}">
      <button class="yes" disabled={adding || acts.modes.edit.refused} onclick={acts.onaccept}>{adding ? "adding…" : "add to orbit"}</button>
      <button disabled={adding} class:armed={acts.modes.discardArmed} onclick={acts.oncancel}
              >{acts.modes.discardArmed ? "discard changes?" : "cancel"}</button>
    </div>
    {#if acts.modes.edit.problem ?? acts.modes.edit.refusal}
      <div class="mail-problem" role="alert">{acts.modes.edit.problem ?? acts.modes.edit.refusal}</div>
    {/if}
  {:else if decidable}
    <!-- #434: approval is the boundary between untrusted mail and the
         household, so it takes two deliberate taps — the first arms, the
         second fires. One operation id per receipt makes the write
         idempotent under any retry (home's tapReceipt). -->
    <div class="actions" role="group" aria-label="Decide">
      <button class="yes" disabled={busy || locked} onclick={() => onReceiptTap(suggestion, "approve")}>
        {armed.id === row.id && armed.act === "approve" ? "tap again to approve" : "Add to orbit"}
      </button>
      <button disabled={busy} onclick={() => onReceiptTap(suggestion, "dismiss")}>
        {armed.id === row.id && armed.act === "dismiss" ? "tap again to dismiss" : "Dismiss"}
      </button>
    </div>
    {#if mailProblem && armed.id === row.id}
      <div class="mail-problem" role="alert">{mailProblem}</div>
    {/if}
  {/if}
  <div class="ivfoot">
    <button class="ivcopy" onclick={onCopyAddress}>{copied ? "link copied" : "copy link"}</button>
    {#if decidable && !locked && !amending}
      <button type="button" class="ivfull ivamend" disabled={busy} onclick={acts.onamend}>review &amp; amend →</button>
    {/if}
  </div>
</div>
