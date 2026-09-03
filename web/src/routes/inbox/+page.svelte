<script>
  import { onMount } from "svelte";
  import { readInboxScreen, approveReceipt, dismissReceipt } from "$lib/data/workspace.js";
  import { money, ago, agoLong } from "$lib/format.js";
  import { daysUntil } from "$lib/data/chart.js";
  import { fillStarTiles } from "$lib/sky.js";
  import Chrome from "$lib/Chrome.svelte";
  import { resolve } from "$app/paths";
  import { SvelteMap } from "svelte/reactivity";
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

  /** @type {{ id: string | null, act: "approve" | "dismiss" | null }} */
  let armed = $state({ id: null, act: null });
  /** @type {string | null} */
  let busy = $state(null);
  /** @type {string | null} */
  let problem = $state(null);
  const operationIds = new SvelteMap();

  /**
   * Only `id` is ever read here, so this takes anything with one -- a review
   * receipt or a failed-to-process entry alike, both of which call in.
   * @param {{ id: string }} receipt
   * @param {"approve" | "dismiss"} act
   */
  async function tap(receipt, act) {
    problem = null;
    if (armed.id !== receipt.id || armed.act !== act) {
      armed = { id: receipt.id, act };
      return;
    }
    busy = receipt.id;
    try {
      if (act === "approve") {
        const found = need().suggestions.find((one) => one.receiptId === receipt.id);
        if (!operationIds.has(receipt.id)) operationIds.set(receipt.id, crypto.randomUUID());
        /* The review lane's own receipts are exactly receiptSuggestionsOf's
           input, so a receipt armed to approve is always found here. */
        const suggestion = /** @type {import('$lib/data/workspace.js').ReceiptSuggestion} */ (found);
        const result = await approveReceipt(suggestion, need().primary, operationIds.get(receipt.id));
        if (result.outcome === "partial_success") {
          problem = "The item is recorded, but its documents need another try — tap again to finish.";
          return;
        }
        operationIds.delete(receipt.id);
      } else {
        await dismissReceipt(receipt.id);
      }
      armed = { id: null, act: null };
      view = await readInboxScreen();
    } catch (error) {
      problem = /** @type {{ message?: string }} */ (error)?.message ?? String(error);
    } finally {
      busy = null;
    }
  }

  /** @param {string} iso */
  const short = (iso) =>
    new Date(iso).toLocaleDateString("en-GB", { day: "2-digit", month: "short", timeZone: "UTC" });
  /** @param {string} iso */
  const fullDate = (iso) =>
    new Date(iso).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric", timeZone: "UTC" });
  /* Filed dates carry their year only once it stops being obvious. */
  /** @param {string} iso */
  const filedDate = (iso) =>
    iso.slice(0, 4) === need().today.slice(0, 4) ? short(iso) : fullDate(iso);
  /* The filed dot follows the chart key — the item's urgency band, today. */
  /** @type {Record<string, string>} */
  const TONES = { overdue: "--overdue", "due-soon": "--warm", upcoming: "--upcoming", ok: "--ok", unscheduled: "--ink-faint" };
  /** @param {import('$lib/data/workspace.js').Receipt} receipt */
  const burnsIn = (receipt) => daysUntil(/** @type {string} */ (receipt.expiresAt).slice(0, 10), need().today);
  /* READ · SURE / READ · UNSURE — the parser's own confidence, two words. */
  /**
   * @param {import('$lib/data/workspace.js').Receipt} receipt
   * @param {string} field
   */
  const mark = (receipt, field) => {
    const evidence = receipt.fieldEvidence?.[field];
    if (!evidence) return null;
    return evidence.confidence === "low" ? "READ · UNSURE" : "READ · SURE";
  };
  /* The list API names no files yet (#467): the fixture carries the design's
     names; live data degrades to the honest count. */
  /** @param {import('$lib/data/workspace.js').Receipt} receipt */
  const chips = (receipt) =>
    receipt.attachments?.map(
      (a) => `◆ ${a.displayName} · ${Math.round(/** @type {number} */ (a.sizeBytes) / 1024)} KB · scanned clean`,
    ) ?? (receipt.attachmentCount
      ? [`◆ ${receipt.attachmentCount} document${receipt.attachmentCount === 1 ? "" : "s"} · scanned clean`]
      : []);
  const emptyQueue = $derived.by(() => {
    if (!view) return null;
    const current = need();
    return !current.review.length && !current.reading.length && !current.failed.length;
  });

  onMount(async () => {
    fillStarTiles(document.getElementById("fartile"), document.getElementById("neartile"));
    view = await readInboxScreen();
  });
</script>

<svelte:head><title>Orbit — inbox</title></svelte:head>

<div class="inbox-page">
<div class="sky" aria-hidden="true">
  <svg viewBox="0 0 1600 1000" preserveAspectRatio="xMidYMid slice">
    <g class="far" fill="var(--star-far)"><g id="fartile"></g><use href="#fartile" x="1600"/></g>
    <g class="near" fill="var(--star-near)"><g id="neartile"></g><use href="#neartile" x="1600"/></g>
  </svg>
</div>
<div class="vignette" aria-hidden="true"></div>

<Chrome user={view?.user} current="inbox"
        role={view ? `${view.household?.name ?? ""} · ${view.household?.canManage ? "owner" : "member"}` : ""} />

<div class="page">
  <header class="screen">
    <h1>Inbox</h1>
    <div class="sub">what your relay has caught · nothing enters your orbit without your say-so</div>
  </header>

  {#if view}
    {#if view.filed.length || !emptyQueue}
    <div class="lanes">
    <div class="lane filed">
      <div class="group">
        <h3>Filed{view.filed.length ? ` · ${view.filed.length}` : ""}</h3>
        {#each view.filed as entry (entry.itemId)}
          <a class="item" href={resolve("/item/[id]", { id: entry.itemId })}>
            <span class="dot" style="background:var({TONES[entry.band]})" aria-hidden="true"></span>
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
        <h3>For your review · {view.review.length}</h3>
        {#each view.review as receipt (receipt.id)}
          <div class="receipt">
            <div class="head">
              <span class="dot" aria-hidden="true"></span>
              <b>{receipt.proposal?.title ?? "Forwarded email"}</b>
              <small>caught {short(/** @type {string} */ (receipt.receivedAt))} · <span class="exp">burns up in {burnsIn(receipt)}d</span></small>
            </div>
            <div class="fields">
              {#if receipt.proposal?.provider}
                <div class="kv"><span>provider</span><b>{receipt.proposal.provider}{#if mark(receipt, "provider")}<span class="conf">{mark(receipt, "provider")}</span>{/if}</b></div>
              {/if}
              {#if receipt.proposal?.dueDate}
                <div class="kv"><span>renews</span><b>{fullDate(receipt.proposal.dueDate)}{#if mark(receipt, "dueDate")}<span class="conf">{mark(receipt, "dueDate")}</span>{/if}</b></div>
              {/if}
              {#if receipt.proposal?.costMinor}
                <div class="kv"><span>cost</span><b>{money(receipt.proposal.costMinor, receipt.proposal.currency ?? "GBP", true)}{#if mark(receipt, "costMinor")}<span class="conf">{mark(receipt, "costMinor")}</span>{/if}</b></div>
              {/if}
            </div>
            {#each chips(receipt) as chip (chip)}
              <span class="attach">{chip.split(" · scanned clean")[0]} · <span class="clean">scanned clean</span></span>
            {/each}
            <div class="actions">
              <button class="yes" disabled={busy === receipt.id} onclick={() => tap(receipt, "approve")}>
                {armed.id === receipt.id && armed.act === "approve" ? "tap again to approve" : "Add to orbit"}
              </button>
              <button disabled={busy === receipt.id} onclick={() => tap(receipt, "dismiss")}>
                {armed.id === receipt.id && armed.act === "dismiss" ? "tap again to dismiss" : "Dismiss"}
              </button>
              <span class="twotap">— both ask twice</span>
              <a href={resolve("/item/[id]", { id: receipt.id })}>review &amp; amend →</a>
            </div>
            {#if problem && armed.id === receipt.id}
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
        <h3>Still reading</h3>
        {#each view.reading as receipt (receipt.id)}
          <div class="reading">
            <i aria-hidden="true"></i>
            <div class="body">
              <b>A message arrived {agoLong(receipt.receivedAt, view.now)}</b>
              <span>{receipt.message}</span>
            </div>
          </div>
        {/each}
      </div>
    {/if}

    {#if view.failed.length}
      <div class="group">
        <h3>Failed to process</h3>
        {#each view.failed as failure (failure.id)}
          <div class="failed">
            <i aria-hidden="true"></i>
            <div class="body">
              <b>A message from {short(failure.receivedAt)}</b>
              <span>{failure.message}</span>
            </div>
            {#if failure.canDiscard}
              <button disabled={busy === failure.id} onclick={() => tap(failure, "dismiss")}>
                {armed.id === failure.id && armed.act === "dismiss" ? "tap again to remove" : "remove"}
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
      <div class="retention">unreviewed arrivals burn up after 45 days · originals stay in your mailbox — Orbit only ever reads copies</div>
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
            <b>{view.relay.address}</b>
            <span><span class="live">{view.relay.status}</span>{view.lastCaught ? ` · last caught ${ago(view.lastCaught, view.now)}` : ""}</span>
          </div>
          <a href={resolve("/settings/mail")}>your relay →</a>
        </div>
      </div>
    {/if}
  {/if}
</div>
</div>
