<script>
  import { flip } from "svelte/animate";
  import { SvelteMap } from "svelte/reactivity";
  import { resolve } from "$app/paths";
  import { approveWithOperation, dismissReceipt, readInboxScreen } from "$lib/data/workspace.js";
  import { ago, agoLong } from "$lib/format.js";
  import { receiptWords } from "$lib/data/metadata-status.js";
  import FailedRow from "$lib/pocket/FailedRow.svelte";
  import ReviewCard from "$lib/pocket/ReviewCard.svelte";
  import ReviewSheet from "$lib/pocket/ReviewSheet.svelte";
  import {
    burnsInOf, formReadingsOf, papersOf, readingsOf, reviewLockedOf, reviewTitleOf, stagedPreviewHref,
  } from "$lib/pocket/review.js";
  import Row from "$lib/pocket/Row.svelte";
  import Sheet from "$lib/pocket/Sheet.svelte";
  import StagedPage from "$lib/pocket/StagedPage.svelte";
  import Sky from "$lib/pocket/Sky.svelte";
  import { wake } from "$lib/pocket/wake.js";
  import { T_CLASS } from "../home/bands.js";

  /**
   * THE INBOX ON A PHONE (#1120, proposal §2.6). Server-rendered beside the
   * desk's lanes and chosen by CSS (the switch at the foot), as create's and
   * home's pockets are. The desk's three lanes stack in priority order: FOR
   * YOUR REVIEW, STILL READING, FAILED TO PROCESS, then FILED.
   *
   * A review is a card in the dashed pen of "not yet in orbit" with its
   * readings as rows and its two acts full width: `Add to orbit` and
   * `Dismiss` both arm on the first tap and fire on the second (ArmButton).
   * `review & amend →` raises create's form in review mode in a full sheet
   * (§1.4), pre-filled with the readings, and approves what was amended.
   * Readings, failures and filed items are rows. A failure the server lets
   * go (`canDiscard`) opens on a tap to `remove` (arms; review round §1.1);
   * one it keeps (still unavailable, or waiting on cleanup) has no act.
   *
   * Motion (§5): arrivals land (the card drops in and its mark touches down);
   * an approved card's dashed pen turns solid and it sinks toward FILED; a
   * dismissed one burns up. Reduced motion: all of it cuts.
   *
   * `view` is the page's, bound, so both dialects read one fetch.
   * @typedef {Awaited<ReturnType<typeof readInboxScreen>>} InboxView
   * @typedef {InboxView["review"][number]} Receipt
   * @typedef {InboxView["failed"][number]} Failure
   * @typedef {{ view: InboxView | null }} Props
   */
  /** @type {Props} */
  let { view = $bindable() } = $props();

  const need = () => /** @type {InboxView} */ (view);

  /** @type {string | null} */
  let busy = $state(null);
  /** @type {"approve" | "dismiss" | null} */
  let busyAct = $state(null);
  /** Per receipt: the red line under its pills (§1.13), until the next try. */
  const problems = new SvelteMap();
  /** One operation id per receipt across retries (approveWithOperation's contract). */
  const operationIds = new SvelteMap();
  /** How each departing card leaves: "filed" into the orbit, or "burn". */
  const exits = new SvelteMap();

  async function reload() {
    view = await readInboxScreen();
  }

  /* ---- words ----------------------------------------------------------- */
  /** @param {string} iso */
  const short = (iso) =>
    new Date(iso).toLocaleDateString("en-GB", { day: "2-digit", month: "short", timeZone: "UTC" });
  /** @param {Receipt} receipt */
  const titleOf = (receipt) => reviewTitleOf(receipt);
  /** @param {Receipt} receipt */
  const burnsIn = (receipt) => burnsInOf(receipt, need().today);
  /** The filed mark takes the item's urgency band today, as the desk's dot
   *  does — bands.js's own T_CLASS (#1151 W1-Q10), not a second copy that
   *  had already drifted from it (its own `ended` key, which T_CLASS
   *  carries too, is never actually hit via `??`, below). */

  const emptyQueue = $derived(
    view ? !view.review.length && !view.reading.length && !view.failed.length : false,
  );

  /* ---- acts ------------------------------------------------------------ */
  /**
   * @param {Receipt} receipt
   * @param {import('$lib/data/workspace.js').ItemProposal | null} [amended]
   * @param {string | null} [sectionId]
   * @returns {Promise<boolean>} whether it entered the orbit
   */
  async function approve(receipt, amended = null, sectionId = null) {
    problems.delete(receipt.id);
    busy = receipt.id;
    busyAct = "approve";
    try {
      /* The review lane's receipts are exactly receiptSuggestionsOf's input,
         so one armed to approve is always found. */
      const suggestion = /** @type {import('$lib/data/workspace.js').ReceiptSuggestion} */ (
        need().suggestions.find((one) => one.receiptId === receipt.id));
      const result = await approveWithOperation(suggestion, operationIds, need().primary, amended, sectionId);
      if ("partial" in result) {
        problems.set(receipt.id, result.message);
        return false;
      }
      exits.set(receipt.id, "filed");
      wake(`added to your orbit · ${amended?.title ?? titleOf(receipt)}`);
      await reload();
      return true;
    } catch (error) {
      problems.set(receipt.id, /** @type {{ message?: string }} */ (error)?.message ?? String(error));
      return false;
    } finally {
      busy = null;
      busyAct = null;
    }
  }

  /** @param {Receipt} receipt */
  async function dismiss(receipt) {
    problems.delete(receipt.id);
    busy = receipt.id;
    busyAct = "dismiss";
    try {
      await dismissReceipt(receipt.id);
      exits.set(receipt.id, "burn");
      wake(`dismissed · ${titleOf(receipt)}`);
      await reload();
    } catch (error) {
      problems.set(receipt.id, /** @type {{ message?: string }} */ (error)?.message ?? String(error));
    } finally {
      busy = null;
      busyAct = null;
    }
  }

  /** @param {Failure} failure */
  async function removeFailed(failure) {
    try {
      await dismissReceipt(failure.id);
      exits.set(failure.id, "burn");
      await reload();
    } catch (error) {
      wake(`not removed — ${/** @type {{ message?: string }} */ (error)?.message ?? String(error)}`, { failure: true });
    }
  }

  /* ---- review & amend: create's form in review mode (§2.5, §2.6), the
     sheet shared with home and the receipt page (ReviewSheet.svelte) ---- */
  let reviewOpen = $state(false);
  /** @type {Receipt | null} */
  let reviewing = $state(null);
  /** @type {string | null} */
  let reviewProblem = $state(null);

  /** @param {Receipt} receipt */
  function openReview(receipt) {
    reviewing = receipt;
    reviewProblem = null;
    reviewOpen = true;
  }
  /**
   * @param {import('$lib/data/workspace.js').ItemProposal} item
   * @param {string | null} sectionId
   */
  async function saveReview(item, sectionId) {
    if (!reviewing || busy) return false;
    const receipt = reviewing;
    const ok = await approve(receipt, item, sectionId);
    if (!ok) reviewProblem = problems.get(receipt.id) ?? "not added — try again";
    return ok;
  }

  /* ---- the paper (#1155): a review card's attachment line opens the page
     in a sheet of its own -- the decision (add / dismiss) stays on the card
     behind it, so this sheet carries no foot. ---- */
  let paperOpen = $state(false);
  /** @type {{ receipt: Receipt, paper: { id: string | null, name: string, drawable: boolean } } | null} */
  let openPaper = $state(null);
  /** @param {Receipt} receipt @param {{ id: string | null, name: string, drawable: boolean }} paper */
  function showPaper(receipt, paper) {
    if (!paper.id) return;
    openPaper = { receipt, paper };
    paperOpen = true;
  }

  /* ---- motion ---------------------------------------------------------- */
  const still = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
  /**
   * How a card or row leaves. Filed: the dashed pen turns solid, the mark
   * fills, and it sinks toward FILED. Burnt: a warm edge, and it lifts away.
   * Transform and opacity only (§5.3).
   * @param {HTMLElement} node
   * @param {{ id: string }} params
   */
  function leave(node, { id }) {
    if (still()) return { duration: 0 };
    const filed = exits.get(id) === "filed";
    /* A review's wrapper leaves; its card wears the way out. */
    (node.querySelector(".p-review") ?? node).classList.add(filed ? "pki-filing" : "pki-burning");
    return {
      duration: filed ? 520 : 420,
      /**
       * @param {number} t
       * @param {number} u
       */
      css: (t, u) => filed
        ? `transform:translateY(${u * 28}px) scale(${1 - u * 0.06});opacity:${Math.min(1, t * 1.6)}`
        : `transform:translateY(${-u * 12}px) scale(${1 + u * 0.02});opacity:${t}`,
    };
  }
</script>

<div class="pk-inbox">
  <Sky />
  <main class="pki-column">
    <!-- Round 3 §3.5: no subtitle; the promise is the act (owner's answer
         10b). -->
    <header class="pki-head">
      <div class="pki-headline">
        <h1 class="p-title">Inbox</h1>
        <!-- The relay's dish (§1.10: art that survives whole stays), the
             inbox's own mark: it listens while the relay does. -->
        <div class="pki-dish" class:quiet={!view} aria-hidden="true"><span></span><span></span><span></span><i></i></div>
      </div>
    </header>

    {#if !view}
      <div class="p-card" aria-busy="true" aria-label="Loading your inbox">
        <p class="p-caps">for your review</p>
        <div class="p-unlit"></div><div class="p-unlit"></div><div class="p-unlit"></div>
      </div>
    {:else}
      {#if emptyQueue}
        <!-- §2.6: the queue is empty, so the relay is the call to action. -->
        <section class="p-card proposed pki-quiet" aria-labelledby="pki-quiet-h">
          <h2 class="pki-quiet-h" id="pki-quiet-h">relay listening · nothing waiting</h2>
          <p class="pki-alias">{view.relay.address}</p>
          <p class="pki-live"><span class="ok">{view.relay.status}</span>{view.lastCaught ? ` · last caught ${ago(view.lastCaught, view.now)}` : ""}</p>
          <a class="p-pill act-accent wide" href={resolve("/settings/mail")}>open the relay →</a>
        </section>
      {/if}

      {#if view.review.length}
        <section class="pki-lane" aria-labelledby="pki-review-h">
          <h2 class="p-caps pki-lanehead" id="pki-review-h">
            <span class="p-body sug" aria-hidden="true"></span>for your review<span class="p-count">{view.review.length}</span>
          </h2>
          {#each view.review as receipt, index (receipt.id)}
            <div class="pki-card" animate:flip={{ duration: 300 }} out:leave={{ id: receipt.id }}>
              <ReviewCard title={titleOf(receipt)} caught={short(/** @type {string} */ (receipt.receivedAt))}
                          burnsIn={burnsIn(receipt)} readings={readingsOf(receipt)} papers={papersOf(receipt)}
                          unreadable={receiptWords(receipt.metadataStatus)} locked={reviewLockedOf(receipt)} {index}
                          busy={busy === receipt.id ? busyAct : null} problem={problems.get(receipt.id) ?? null}
                          onapprove={() => approve(receipt)} ondismiss={() => dismiss(receipt)}
                          onamend={() => openReview(receipt)} onpaper={(paper) => showPaper(receipt, paper)} />
            </div>
          {/each}
        </section>
      {/if}

      {#if view.reading.length}
        <section class="pki-lane" aria-labelledby="pki-reading-h">
          <h2 class="p-caps pki-lanehead" id="pki-reading-h">
            <span class="p-body up breathing" aria-hidden="true"></span>still reading<span class="p-count">{view.reading.length}</span>
          </h2>
          <div class="p-card pki-rows">
            {#each view.reading as receipt, index (receipt.id)}
              <div class="pki-slot" style:--i={index} animate:flip={{ duration: 300 }}>
                <Row title="A message arrived {agoLong(/** @type {string} */ (receipt.receivedAt), view.now)}" meta="still reading">
                  {#snippet mark()}<span class="p-body up breathing"></span>{/snippet}
                </Row>
              </div>
            {/each}
          </div>
        </section>
      {/if}

      {#if view.failed.length}
        <section class="pki-lane" aria-labelledby="pki-failed-h">
          <h2 class="p-caps pki-lanehead" id="pki-failed-h">
            <span class="p-body pki-failmark" aria-hidden="true"></span>failed to process<span class="p-count">{view.failed.length}</span>
          </h2>
          <div class="p-card pki-rows" data-row-group>
            {#each view.failed as failure, index (failure.id)}
              <div class="pki-slot" style:--i={index} animate:flip={{ duration: 300 }} out:leave={{ id: failure.id }}>
                <FailedRow {failure} onremove={() => removeFailed(failure)} />
              </div>
            {/each}
          </div>
          {#if view.failed.some((one) => one.canDiscard)}
            <p class="p-hint">tap a message to remove it</p>
          {/if}
        </section>
      {/if}

      <section class="pki-lane" aria-labelledby="pki-filed-h">
        <h2 class="p-caps pki-lanehead" id="pki-filed-h">
          <span class="p-body ok" aria-hidden="true"></span>filed{#if view.filed.length}<span class="p-count">{view.filed.length}</span>{/if}
        </h2>
        {#if view.filed.length}
          <div class="p-card pki-rows">
            {#each view.filed as entry, index (entry.itemId)}
              <div class="pki-slot" style:--i={index} animate:flip={{ duration: 300 }}>
                <!-- The date first and the file name last, so the guard
                     trims the name (round 3 §1, R5). -->
                <Row title={entry.title ?? "a filed item"} href={resolve(`/home?item=${encodeURIComponent(entry.itemId)}`)}
                     meta="added {short(/** @type {string} */ (entry.filedAt))}{entry.sourceDocument ? ` · ${entry.sourceDocument}` : ""}">
                  {#snippet mark()}<span class="p-body {T_CLASS[entry.band] ?? 'ended'}"></span>{/snippet}
                </Row>
              </div>
            {/each}
          </div>
        {:else}
          <div class="p-card proposed">
            <p class="p-empty pki-empty">nothing filed yet</p>
          </div>
        {/if}
      </section>

      {#if !emptyQueue}
        <p class="p-foot pki-foot">unreviewed arrivals burn up after 45d</p>
      {/if}
    {/if}
  </main>

  <ReviewSheet bind:open={reviewOpen} title={reviewing ? titleOf(reviewing) : ""} proposal={reviewing?.proposal}
               householdId={reviewing ? (reviewing.householdId ?? need().primary) : null}
               households={view?.households ?? []} readings={reviewing ? formReadingsOf(reviewing) : []}
               papers={reviewing ? papersOf(reviewing) : []} receiptId={reviewing?.id ?? null}
               busy={Boolean(reviewing && busy === reviewing.id)}
               problem={reviewProblem} onsave={saveReview} />

  <!-- #1155: the paper, opened from a review card's attachment line. No
       foot -- the decision (add / dismiss) stays on the card behind it. -->
  <Sheet bind:open={paperOpen} size="list" title={openPaper?.paper.name ?? ""}>
    {#if openPaper}
      <StagedPage href={stagedPreviewHref(openPaper.receipt.id, /** @type {string} */ (openPaper.paper.id))}
                  name={openPaper.paper.name} drawable={openPaper.paper.drawable} reader
                  itemTitle={titleOf(openPaper.receipt)} />
    {/if}
  </Sheet>
</div>

<style>
  /* THE DIALECT SWITCH: the same query as $lib/pocket/media.js. The desk's
     page goes; its chrome stays, because on a phone Chrome.svelte draws the
     kit's top chrome and the hatch. */
  .pk-inbox{display:none}
  @media (max-width:900px), (max-height:600px){
    .pk-inbox{display:block;position:relative;min-height:100dvh}
    :global(.inbox-page > :is(.sky, .vignette, .page)){display:none}
  }

  .pki-column{position:relative;z-index:2;box-sizing:border-box;max-width:var(--p-column);margin:0 auto;
    padding:calc(var(--p-chrome) + env(safe-area-inset-top) + 8px) var(--p-gutter)
      calc(40px + env(safe-area-inset-bottom))}
  .pki-head{margin:0 0 8px;padding:0 2px}
  .pki-headline{display:flex;align-items:center;justify-content:space-between;gap:12px}

  /* The dish: the desk's relay signal (inbox.css), three rings going out. */
  .pki-dish{position:relative;width:34px;height:34px;flex:none}
  .pki-dish i{position:absolute;inset:13px;border-radius:50%;background:var(--ok);box-shadow:0 0 0 2.5px var(--bg)}
  .pki-dish span{position:absolute;inset:0;border:1px solid var(--ok);border-radius:50%;opacity:0;
    animation:pki-signal 3s ease-out infinite}
  .pki-dish span:nth-child(2){animation-delay:1s}
  .pki-dish span:nth-child(3){animation-delay:2s}
  .pki-dish.quiet span{animation:none}
  @keyframes pki-signal{from{opacity:.7;transform:scale(.3)}to{opacity:0;transform:scale(1.4)}}

  /* LANES (§2.6): stacked in priority order, each head carrying its mark,
     the lane's own body in the desk's key, and the kit's count bead
     (kit.css .p-count, the one bead style, review round §1.6). */
  .pki-lane{margin-top:var(--p-group-above)}
  .pki-lanehead{display:flex;align-items:center;gap:10px;margin:0 0 var(--p-group-below);padding:0 2px}
  /* The kit's .p-body.failed, under another name: the desk's own
     `.inbox-page .failed` (a whole card) would match the kit's class here,
     because this dialect is drawn inside .inbox-page. */
  :global(.p-body.pki-failmark){color:var(--degraded)}

  /* A REVIEW is the shared ReviewCard (round 3 §4); its dashed pen, marks
     and acts are drawn there. */

  /* ROW LANES: rows flush on the card's glass (the kit's .flushcard). Each
     row sits in a slot for its motion, so the kit's row-to-row hairline is
     drawn here, from the text edge, as the rail. */
  .pki-rows{padding:4px 0;overflow:hidden;display:flex;flex-direction:column}
  .pki-slot{position:relative;animation:pki-land 420ms var(--p-ease) both;animation-delay:calc(var(--i, 0) * 50ms)}
  .pki-slot + .pki-slot::before{content:"";position:absolute;z-index:2;top:0;right:0;pointer-events:none;
    left:calc(var(--p-gutter) + var(--p-row-mark) + var(--p-row-gap));border-top:1px solid var(--line-soft)}
  .pki-empty{margin:0}

  .pki-quiet{margin-top:20px}
  .pki-quiet-h{margin:0;font:600 var(--p-type-sheet)/1.3 var(--display);color:var(--ink)}
  .pki-alias{margin:0;padding:12px;border:1px dashed color-mix(in srgb, var(--accent) 45%, var(--line-soft));border-radius:12px;
    font:500 var(--p-type-meta)/1.4 var(--mono);color:var(--accent-text);overflow-wrap:anywhere;text-align:center}
  .pki-live{margin:8px 0 16px;text-align:center;font:var(--p-type-meta)/1.4 var(--mono);color:var(--ink-quiet)}
  .pki-live .ok{color:var(--ok-text)}

  .pki-foot{margin:28px 0 0;text-align:center;font:var(--p-type-meta)/1.7 var(--mono);color:var(--ink-quiet)}

  /* The two ways out, set as the transition starts (leave()). */
  :global(.pki-filing){border-style:solid !important;border-color:var(--ok) !important}
  :global(.pki-filing) :global(.p-body.sug){background:var(--ok);border-color:var(--ok)}
  :global(.pki-burning){border-color:var(--warm) !important;
    background:linear-gradient(color-mix(in srgb, var(--warm) 10%, transparent), transparent), var(--panel) !important}

  @keyframes pki-land{from{opacity:0;transform:translateY(-14px) scale(.985)}}

  @media (prefers-reduced-motion:reduce){
    .pki-dish span,.pki-slot{animation:none}
  }
</style>
