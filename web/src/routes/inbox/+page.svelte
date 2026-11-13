<script>
  import { onMount } from "svelte";
  import { readInboxScreen } from "$lib/data/workspace.js";
  import { heldForSenderCheck, heldWords } from "$lib/data/inbox.js";
  import { ago, agoLong, dayMonth, dayMonthYear } from "$lib/format.js";
  import { daysWords } from "$lib/data/engine-limits.js";
  import { LOCKED, fieldState, receiptWords } from "$lib/data/metadata-status.js";
  import { papersOf, readingsOf } from "$lib/pocket/review.js";
  import { MAIL_DISMISS, MAIL_KEEPS, RENEW_MAIL, addedDay, dueWords } from "$lib/data/already-held.js";
  import { burnsInOf } from "$lib/pocket/review.js";
  import { failureWords } from "$lib/pocket/words.js";
  import { BAND_VAR } from "$lib/data/bands.js";
  import PageSky from "$lib/PageSky.svelte";
  import Chrome from "$lib/Chrome.svelte";
  import { addressUsable, copyRelayAddress, relayAddressLabel } from "$lib/relay-address.js";
  import { createArm } from "$lib/arm.js";
  import { resolve } from "$app/paths";
  import { SvelteMap } from "svelte/reactivity";
  import Pocket from "./pocket.svelte";
  import { createReceiptActs } from "./acts.js";
  import "./inbox.css";

  /**
   * Inbox — the relay queue (#463), three lanes since §14 (#472). Built from
   * design/v19/inbox.html: Filed (what the mail became) → For your review →
   * Still reading / Failed to process, stacking to one column on a phone.
   * Nothing enters the orbit from here without two deliberate taps (#434's
   * protocol, shared with home's rows), and unreviewed arrivals burn up
   * after 45 days. §15: the relay lives on the helm — its bar appears here
   * only when the QUEUE is empty (review + reading + failed), where the
   * address is the call to action; Filed may still hold items.
   */
  /** @type {Awaited<ReturnType<typeof readInboxScreen>> | null} */
  let view = $state(null);
  /* The template only calls into `view` from inside `{#if view}`, but that
     guard doesn't reach into these standalone functions' closures, so this
     asserts what the call sites already guarantee rather than duplicating
     the check. */
  const need = () => /** @type {NonNullable<typeof view>} */ (view);

  /* One arm for every receipt's two buttons (lib/arm.js), keyed "<id>:<act>":
     4 s, scroll, Escape and a tap elsewhere put it down again. */
  /** @type {string | boolean} */
  let armed = $state(false);
  const arm = createArm({ onchange: (next) => (armed = next) });
  /** @param {{ id: string }} receipt @param {"approve" | "dismiss"} act */
  const isArmed = (receipt, act) => armed === `${receipt.id}:${act}`;
  /** The receipt whose last act failed, so its problem line stays up. */
  let problemId = $state(/** @type {string | null} */ (null));
  /** @type {string | null} */
  let busy = $state(null);
  /** @type {string | null} */
  let problem = $state(null);
  /* The decision itself is acts.js's, the phone's too: here, the arm and
     where the busy receipt and its problem show. */
  const receiptActs = createReceiptActs({
    view: need,
    operationIds: new SvelteMap(),
    reload: async () => { view = await readInboxScreen(); },
    say: (id, words) => {
      problem = words;
      if (words) problemId = id;
    },
    busy: (id) => { busy = id; },
  });

  /**
   * Only `id` is ever read here, and whether it is held for a sender check
   * (#1650), so this takes anything with one -- a review receipt or a
   * failed-to-process entry alike, both of which call in.
   * @param {{ id: string, needsSenderCheck?: boolean, classification?: string }} receipt
   * @param {"approve" | "dismiss"} act
   * @param {HTMLElement | null} button
   */
  async function tap(receipt, act, button) {
    problem = null;
    /* #1650: held mail cannot be added; its control is shaded, and a press that
       reaches here anyway sends nothing. */
    if (act === "approve" && heldForSenderCheck(receipt)) return;
    if (!arm.tap(`${receipt.id}:${act}`, button)) return;
    await receiptActs.decide(receipt, act);
  }

  /* Filed dates carry their year only once it stops being obvious. */
  /** @param {string} iso */
  const filedDate = (iso) =>
    iso.slice(0, 4) === need().today.slice(0, 4) ? dayMonth(iso) : dayMonthYear(iso);
  /* The filed dot follows the chart key — the item's urgency band, today. */
  /** @param {import('$lib/data/workspace.js').Receipt} receipt */
  const burnsIn = (receipt) => burnsInOf(receipt, need().today);
  /* "Still reading" only ever holds receipts that have already arrived. */
  /** @param {import('$lib/data/workspace.js').Receipt} receipt */
  const readAgo = (receipt) => agoLong(/** @type {string} */ (receipt.receivedAt), need().now);
  /* Why Orbit cannot read a message, in the member's words, or null when it
     can. Locked: intact, waiting for an administrator -- there is nothing to
     review and nothing to accept, so those two ways in go, and the receipt
     stays queued rather than being retired as a failure. Damaged: Orbit's copy
     is gone, but the member's own mailbox still has the original, so every
     action stays and the words say to forward it again. */
  /** @param {import('$lib/data/workspace.js').Receipt | import('$lib/data/workspace.js').MailFailure} receipt */
  const unreadable = (receipt) => receiptWords(receipt.metadataStatus);
  /** @param {import('$lib/data/workspace.js').Receipt} receipt */
  const locked = (receipt) => fieldState(receipt.metadataStatus, "proposal") === LOCKED;
  const emptyQueue = $derived.by(() => {
    if (!view) return null;
    const current = need();
    return !current.review.length && !current.reading.length && !current.failed.length;
  });

  onMount(async () => {
    view = await readInboxScreen();
  });
</script>

<svelte:head><title>Orbit — inbox</title></svelte:head>

<div class="inbox-page">
<PageSky />

<Chrome user={view?.user} current="inbox" household={view?.household} />

<!-- #1120, proposal §2.6: the pocket's own inbox, chosen by CSS. -->
<Pocket bind:view />

<div class="page" role="main">
  <header class="screen">
    <h1>Inbox</h1>
    <div class="sub">what your relay has caught · nothing enters your orbit without your say-so</div>
  </header>

  {#if view}
    {#if view.filed.length || !emptyQueue}
    <div class="lanes">
    <div class="lane filed">
      <div class="group">
        <h2>Filed{view.filed.length ? ` · ${view.filed.length}` : ""}</h2>
        {#each view.filed as entry (entry.itemId)}
          <a class="item" href={resolve(`/home?item=${encodeURIComponent(entry.itemId)}`)}>
            <span class="dot" style="background:var({BAND_VAR[entry.band]})" aria-hidden="true"></span>
            <div class="flex"><b>{entry.title}</b><span>from {entry.sourceDocument} · added {filedDate(/** @type {string} */ (entry.filedAt))}</span></div>
          </a>
        {/each}
        {#if view.filed.length}
          <div class="note">every item the relay has ever fed into your orbit —<br>tap one to open it; its documents ride with it</div>
        {:else}
          <!-- No filed route yet (#467): the lane states its own law instead. -->
          <div class="note">nothing filed yet — approve an arrival<br>and it lands here, its documents riding with it</div>
        {/if}
      </div>
    </div>

    <div class="lane">
    {#if view.review.length}
      <div class="group">
        <h2>For your review · {view.review.length}</h2>
        {#each view.review as receipt (receipt.id)}
          {@const flagged = papersOf(receipt).filter((paper) => paper.flagged).length}
          {@const without = flagged > 1 ? "Add without them" : "Add without it"}
          <div class="receipt">
            <div class="head">
              <span class="dot" aria-hidden="true"></span>
              <b>{receipt.proposal?.title ?? "Forwarded email"}</b>
              <small>caught {dayMonth(/** @type {string} */ (receipt.receivedAt))}{#if burnsIn(receipt) !== null} · <span class="exp">burns up in {burnsIn(receipt)}d</span>{/if}</small>
            </div>
            <div class="fields">
              {#each readingsOf(receipt) as reading (reading.field)}
                <div class="kv"><span>{reading.label}</span>
                  <b>{reading.value}{#if reading.sure !== null}<span class="conf">{reading.sure ? "READ · SURE" : "READ · UNSURE"}</span>{/if}</b></div>
              {/each}
            </div>
            {#each papersOf(receipt, need()) as paper (paper.id ?? paper.name)}
              {#if paper.drawable}
                <!-- #1319: the suggestion's home drawer, where its paper opens the preview -->
                <a class="attach" href={resolve(`/home?item=${encodeURIComponent(receipt.id)}`)}>
                  ◆ <span class="name">{paper.name}</span>{#if paper.meta} · {paper.meta}{/if}{#if paper.clean} · <span class="clean">scanned clean</span>{/if} · <span class="view">view →</span>
                </a>
              {:else}
                <span class="attach">◆ {paper.name}{#if paper.clean} · <span class="clean">scanned clean</span>{/if}</span>
              {/if}
              {#if paper.flagged}
                <!-- #1398 (placement note 56231): under the paper it is about,
                     in the #1437 line's grammar; a virus is the card's one red. -->
                <div class="dupline flag" role="alert"><span class="bead" aria-hidden="true"></span>
                  <p><b>The scanner flagged a virus or malware inside attachment: "{paper.name}"</b></p>
                  <p>{without} adds the mail and its other attachments; Discard everything drops the mail and all its attachments. {flagged > 1 ? "The flagged files are never added." : "The flagged file is never added."}</p>
                </div>
              {:else if paper.held}
                {@const held = paper.held}
                <!-- #1437 (design/v19/duplicate-alert/round-1, A): under the
                     paper it is about, in the receipt's own grammar. No new
                     button: Add to orbit is the keep-anyway path (owner 5a). -->
                <div class="dupline" role="status"><span class="bead" aria-hidden="true"></span>
                  <p><b>Already in your orbit.</b> This is the same file, byte for byte, as <b>{held.displayName}</b>{held.entry ? ` on ${held.entry.title}` : ""}, added {addedDay(held.addedAt)}. {MAIL_KEEPS}.</p>
                  {#if held.entry && paper.renewal !== null && paper.renewal !== undefined}
                    <p class="renew">{dueWords(held.entry.title, paper.renewal)} {RENEW_MAIL}</p>
                  {/if}
                  <div class="row">{#if held.entry}<a href={resolve(`/home?item=${encodeURIComponent(held.entry.itemId)}`)}>open {held.displayName} →</a>{/if}<span>{MAIL_DISMISS}</span></div>
                </div>
              {/if}
            {/each}
            <!-- The card's own quiet mono (.twotap), not an alarm colour: one
                 of these two states is a wait and the other has a remedy the
                 member can carry out, and neither is this screen's emergency. -->
            {#if unreadable(receipt)}
              <div class="twotap" style="margin-top:10px">{unreadable(receipt)}</div>
            {/if}
            <!-- #1568: a retryable suggestion (an interrupted approval) says
                 what happened and what to do, in the server's own words. -->
            {#if receipt.classification === "retry"}
              <div class="twotap" style="margin-top:10px">{receipt.message}</div>
            {/if}
            <!-- #1650 (notes 54816, 55326): held until the sending address is
                 checked. In the same quiet mono: the remedy is the member's. -->
            {#if heldForSenderCheck(receipt)}
              <div class="twotap" style="margin-top:10px">{heldWords(receipt)}</div>
            {/if}
            <div class="actions">
              {#if heldForSenderCheck(receipt)}
                <button class="yes" disabled>Add to orbit</button>
              {:else}
              <button class="yes" disabled={busy === receipt.id || locked(receipt)} onclick={(event) => tap(receipt, "approve", event.currentTarget)}>
                {#if flagged}{isArmed(receipt, "approve") ? "tap again to add" : without}{:else}{isArmed(receipt, "approve") ? "tap again to approve" : "Add to orbit"}{/if}
              </button>
              {/if}
              <button disabled={busy === receipt.id} onclick={(event) => tap(receipt, "dismiss", event.currentTarget)}>
                {#if flagged}{isArmed(receipt, "dismiss") ? "tap again to discard" : "Discard everything"}{:else}{isArmed(receipt, "dismiss") ? "tap again to dismiss" : "Dismiss"}{/if}
              </button>
              <span class="twotap">— both ask twice</span>
              {#if !locked(receipt)}
                {#if !heldForSenderCheck(receipt)}
                <a href={resolve(`/home?item=${encodeURIComponent(receipt.id)}`)}>review &amp; amend →</a>
                {/if}
              {/if}
            </div>
            {#if problem && problemId === receipt.id}
              <div class="mail-problem">{problem}</div>
            {/if}
          </div>
        {/each}
      </div>
    {/if}
    </div><!-- /middle lane -->

    <div class="lane">
    {#if view.reading.length}
      <div class="group">
        <h2>Still reading</h2>
        {#each view.reading as receipt (receipt.id)}
          <div class="reading">
            <i aria-hidden="true"></i>
            <div class="body">
              <b>A message arrived {readAgo(receipt)}</b>
              <span>{receipt.message}</span>
            </div>
          </div>
        {/each}
      </div>
    {/if}

    {#if view.failed.length}
      <div class="group">
        <h2>Failed to process</h2>
        {#each view.failed as failure (failure.id)}
          <div class="failed">
            <i aria-hidden="true"></i>
            <div class="body">
              <b>A message from {dayMonth(failure.receivedAt)}</b>
              <span>{unreadable(failure) ?? `${failureWords(failure)} · ${failure.message}`}</span>
              <!-- decide()'s line for this entry: a refused remove, or done-but-unread
                   when only the read after a landed remove failed (inbox/acts.js). -->
              {#if problem && problemId === failure.id}
                <div class="mail-problem">{problem}</div>
              {/if}
            </div>
            {#if failure.canDiscard}
              <button disabled={busy === failure.id} onclick={(event) => tap(failure, "dismiss", event.currentTarget)}>
                {isArmed(failure, "dismiss") ? "tap again to remove" : "remove"}
              </button>
            {/if}
          </div>
        {/each}
      </div>
    {/if}
    </div><!-- /third lane -->
    </div><!-- /lanes -->
    {/if}

    {#if !emptyQueue}
      <div class="retention">unreviewed arrivals burn up after {daysWords(view.retention?.receiptDays)} · originals stay in your mailbox — Orbit only ever reads copies</div>
    {:else}
      <div class="quietnote">
        <div class="dish" aria-hidden="true"><span></span><span></span><span></span><i></i></div>
        <p>the dish is listening — nothing waiting<br>forward a document to your relay address and it lands here</p>
        <!-- §15: the relay wears its hat here only — with nothing in the
             queue, the address is the call to action. Filed may still hold
             items; what governs this is the QUEUE being empty. -->
        <div class="relaybar">
          <div class="dish" aria-hidden="true"><span></span><span></span><span></span><i></i></div>
          <div class="alias">
            <button class="copy" disabled={!addressUsable(view.relay.address)} onclick={() => view && copyRelayAddress(view.relay.address)}
                    aria-label={relayAddressLabel(view.relay.address)}>
              <b>{view.relay.address}</b>
              <small aria-hidden="true">{addressUsable(view.relay.address) ? "click to copy" : ""}</small>
            </button>
            <span><span class="live">{view.relay.status}</span>{view.lastCaught ? ` · last caught ${ago(view.lastCaught, view.now)}` : ""}</span>
          </div>
          <a href={`${resolve("/settings")}#mail`}>your relay →</a>
        </div>
      </div>
    {/if}
  {/if}
</div>
</div>
