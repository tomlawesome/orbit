<script>
  /*
   * WHAT A SUGGESTION ROW OPENS INTO ON THE DESK (#1145, owner 2026-09-27:
   * "let the suggested items open as a drawer like the manifest items"). The
   * filed row's drawer is ItemView.svelte; this is its twin for the relay's
   * catch, in the same .itemview grammar: key/value lines -- the readings,
   * each with how sure the relay was, then when it burns up -- the paper it
   * came in, the two decisions that used to sit on the row at rest (#434's
   * two taps, one operation id per receipt), and the foot: `copy link` and
   * `review in the belt →`, which is `manage this item →`'s twin because the
   * belt is where the proposed fields are amended.
   *
   * The phone has its own (SuggestionDrawer.svelte, the kit's Row detail);
   * both read the readings from review.js so the two say one thing.
   *
   * A component rather than a snippet for the reason ItemView.svelte gives.
   */
  import { resolve } from "$app/paths";
  import { longDate } from "$lib/format.js";
  import { burnsInOf, readingsOf, reviewLockedOf } from "$lib/pocket/review.js";
  import { receiptWords } from "$lib/data/metadata-status.js";

  /**
   * @typedef {import('$lib/data/chart.js').CorridorRow} CorridorRowData
   * @typedef {import('$lib/data/workspace.js').ReceiptSuggestion} ReceiptSuggestion
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
   * }} */
  let { row, suggestion, busyReceipt, armed, mailProblem, today, onReceiptTap, copied, onCopyAddress } = $props();

  const readings = $derived(readingsOf(suggestion));
  const burnsIn = $derived(burnsInOf(suggestion, today));
  const burnsOn = $derived(suggestion.expiresAt ? longDate(suggestion.expiresAt.slice(0, 10)) : null);
  /* #941: nothing to add until an administrator restores the key; the way in
     is shown, and shut. Dismiss stays, so a receipt is never trapped. */
  const locked = $derived(reviewLockedOf(suggestion));
  const unreadable = $derived(receiptWords(suggestion.metadataStatus));
  /* The papers by name where the list names them (#467), else the count. */
  const papers = $derived(
    suggestion.attachments?.length
      ? suggestion.attachments.map((one) => one.displayName ?? "forwarded document")
      : (suggestion.attachmentCount ? [suggestion.sourceDocument] : []));
  const busy = $derived(busyReceipt === row.id);
  /* A fixture suggestion (#454) has no mail behind it and nothing to decide. */
  const decidable = $derived(Boolean(suggestion.receiptId));
</script>

<div class="itemview suggestview" id="{row.id}-view" role="region" aria-label="{row.title} — suggested, not yet in orbit">
  {#each readings as reading (reading.field)}
    <div class="kv"><span>{reading.label}</span>
      <b>{reading.value}{#if reading.sure !== null}<i class="sure" class:unsure={!reading.sure}>{reading.sure ? "sure" : "unsure"}</i>{/if}</b></div>
  {/each}
  {#if burnsOn}
    <div class="kv"><span>burns up</span>
      <b class:soon={burnsIn !== null && burnsIn < 14}>{burnsIn !== null ? `in ${burnsIn}d · ` : ""}{burnsOn}</b></div>
  {/if}
  {#if papers.length}
    <h4>documents</h4>
    {#each papers as name, index (index)}
      <div class="doc">◆<span>{name}<small>attached on acceptance</small></span></div>
    {/each}
  {/if}
  {#if unreadable}
    <p class="unread">{unreadable}</p>
  {/if}
  {#if decidable}
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
    {#if decidable}
      <a class="ivfull" href={resolve("/item/[[id]]", { id: row.id })}>review in the belt →</a>
    {/if}
  </div>
</div>
