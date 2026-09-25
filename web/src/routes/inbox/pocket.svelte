<script>
  import { flip } from "svelte/animate";
  import { SvelteMap } from "svelte/reactivity";
  import { resolve } from "$app/paths";
  import { approveReceipt, dismissReceipt, readInboxScreen } from "$lib/data/workspace.js";
  import { ago, agoLong, money } from "$lib/format.js";
  import { LOCKED, evidenceReadable, fieldState, receiptWords } from "$lib/data/metadata-status.js";
  import { daysUntil } from "$lib/data/chart.js";
  import ArmButton from "$lib/pocket/ArmButton.svelte";
  import Row from "$lib/pocket/Row.svelte";
  import Sheet from "$lib/pocket/Sheet.svelte";
  import Sky from "$lib/pocket/Sky.svelte";
  import { wake } from "$lib/pocket/wake.js";
  import EntryForm from "../create/EntryForm.svelte";
  import { entryOfProposal, refusalOf, reviewItemOf } from "../create/entry.js";

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
   * go (`canDiscard`) has `remove` behind a swipe (§1.5, owner decision §25);
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
  /** One operation id per receipt across retries (approveReceipt's contract). */
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
  /** @param {string} iso */
  const fullDate = (iso) =>
    new Date(iso).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric", timeZone: "UTC" });
  /** @param {string} iso */
  const filedDate = (iso) => (iso.slice(0, 4) === need().today.slice(0, 4) ? short(iso) : fullDate(iso));
  /** @param {Receipt} receipt */
  const titleOf = (receipt) => receipt.proposal?.title ?? "Forwarded email";
  /** @param {Receipt} receipt */
  const burnsIn = (receipt) =>
    receipt.expiresAt ? daysUntil(receipt.expiresAt.slice(0, 10), need().today) : null;
  /** @param {Receipt} receipt */
  const locked = (receipt) => fieldState(receipt.metadataStatus, "proposal") === LOCKED;
  /** The filed mark takes the item's urgency band today, as the desk's dot does. */
  /** @type {Record<string, string>} */
  const BANDS = { overdue: "over", "due-soon": "soon", upcoming: "up", ok: "ok", unscheduled: "ended" };

  /**
   * The readings, label and value and the parser's confidence in a word.
   * #941: a mark Orbit can no longer stand behind is dropped, not guessed.
   * @param {Receipt} receipt
   */
  function readingsOf(receipt) {
    const p = receipt.proposal ?? {};
    /** @param {string} field */
    const sure = (field) => {
      if (!evidenceReadable(receipt.metadataStatus)) return null;
      const evidence = receipt.fieldEvidence?.[field];
      return evidence ? evidence.confidence !== "low" : null;
    };
    /** @type {{ label: string, value: string, sure: boolean | null, field: "provider" | "reference" | "dueDate" | "cost" }[]} */
    const out = [];
    if (p.provider) out.push({ label: "provider", value: p.provider, sure: sure("provider"), field: "provider" });
    if (p.reference) out.push({ label: "reference", value: p.reference, sure: sure("reference"), field: "reference" });
    if (p.dueDate) out.push({
      label: p.scheduleKind === "expiry" ? "ends" : "renews", value: fullDate(p.dueDate), sure: sure("dueDate"), field: "dueDate",
    });
    if (p.costMinor) out.push({
      label: "cost", value: money(p.costMinor, p.currency ?? "GBP", true), sure: sure("costMinor"), field: "cost",
    });
    return out;
  }
  /**
   * The documents riding with the mail. The list API names no files yet
   * (#467): the fixture carries the design's names, live data the count.
   * @param {Receipt} receipt
   */
  const papersOf = (receipt) =>
    receipt.attachments?.map((a) => ({
      name: a.displayName ?? "document", meta: `${Math.round((a.sizeBytes ?? 0) / 1024)} KB`,
    })) ?? (receipt.attachmentCount
      ? [{ name: `${receipt.attachmentCount} document${receipt.attachmentCount === 1 ? "" : "s"}`, meta: "" }]
      : []);

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
      if (!operationIds.has(receipt.id)) operationIds.set(receipt.id, crypto.randomUUID());
      const result = await approveReceipt(suggestion, need().primary, operationIds.get(receipt.id), amended, sectionId);
      if (result.outcome === "partial_success") {
        problems.set(receipt.id, "The item is recorded, but its documents need another try: add it again to finish.");
        return false;
      }
      operationIds.delete(receipt.id);
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
      wake(`dismissed · ${titleOf(receipt)} · the original stays in your mailbox`);
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

  /* ---- review & amend: create's form in review mode (§2.5, §2.6) -------- */
  let reviewOpen = $state(false);
  /** @type {Receipt | null} */
  let reviewing = $state(null);
  /** @type {import('../create/entry.js').Entry | null} */
  let reviewEntry = $state(null);
  /** @type {string | null} */
  let reviewProblem = $state(null);
  const reviewHousehold = $derived.by(() => {
    if (!view || !reviewEntry) return null;
    return view.households.find((one) => one.id === reviewEntry?.householdId) ?? null;
  });
  const reviewRefusal = $derived(reviewEntry ? refusalOf(reviewEntry) : null);

  /** @param {Receipt} receipt */
  function openReview(receipt) {
    reviewing = receipt;
    reviewProblem = null;
    reviewEntry = entryOfProposal(receipt.proposal, { householdId: receipt.householdId ?? need().primary });
    reviewOpen = true;
  }
  /** @param {Receipt} receipt */
  const formReadings = (receipt) =>
    readingsOf(receipt).map((one) => ({
      ...one, sure: one.sure !== false,
      /* The form copies a reading back into its field as typed there. */
      value: one.field === "dueDate" ? /** @type {string} */ (receipt.proposal?.dueDate)
        : one.field === "cost" ? ((receipt.proposal?.costMinor ?? 0) / 100).toFixed(2) : one.value,
    }));

  async function saveReview() {
    if (!reviewing || !reviewEntry || reviewRefusal || busy) return;
    const receipt = reviewing;
    const currency = receipt.proposal?.currency ?? reviewHousehold?.currency ?? "GBP";
    const ok = await approve(receipt, reviewItemOf(reviewEntry, currency), reviewEntry.sectionId);
    if (ok) reviewOpen = false;
    else reviewProblem = problems.get(receipt.id) ?? "not added — try again";
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
    node.classList.add(filed ? "pki-filing" : "pki-burning");
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
    <header class="pki-head">
      <div class="pki-headline">
        <h1 class="p-title">Inbox</h1>
        <!-- The relay's dish (§1.10: art that survives whole stays), the
             inbox's own mark: it listens while the relay does. -->
        <div class="pki-dish" class:quiet={!view} aria-hidden="true"><span></span><span></span><span></span><i></i></div>
      </div>
      <p class="pki-sub">what your relay has caught · nothing enters your orbit without your say-so</p>
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
          <h2 class="pki-quiet-h" id="pki-quiet-h">your relay is listening · nothing waiting</h2>
          <p class="p-prose pki-quiet-p">Forward a bill, a renewal or a certificate to your relay address and it lands here for your say-so.</p>
          <p class="pki-alias">{view.relay.address}</p>
          <p class="pki-live"><span class="ok">{view.relay.status}</span>{view.lastCaught ? ` · last caught ${ago(view.lastCaught, view.now)}` : ""}</p>
          <a class="p-pill act-accent wide" href={resolve("/settings/mail")}>open the relay →</a>
        </section>
      {/if}

      {#if view.review.length}
        <section class="pki-lane" aria-labelledby="pki-review-h">
          <h2 class="p-caps pki-lanehead" id="pki-review-h">
            <span class="p-body sug" aria-hidden="true"></span>for your review<span class="pki-count">{view.review.length}</span>
          </h2>
          {#each view.review as receipt, index (receipt.id)}
            {@const days = burnsIn(receipt)}
            {@const unreadable = receiptWords(receipt.metadataStatus)}
            <article class="p-card proposed pki-receipt" style:--i={index} aria-labelledby="pki-r-{receipt.id}"
                     animate:flip={{ duration: 300 }} out:leave={{ id: receipt.id }}>
              <div class="pki-rhead">
                <span class="pki-touch" aria-hidden="true"><span class="p-body sug"></span></span>
                <div class="pki-rwords">
                  <h3 class="pki-rtitle" id="pki-r-{receipt.id}">{titleOf(receipt)}</h3>
                  <p class="pki-rwhen">caught {short(/** @type {string} */ (receipt.receivedAt))}{#if days !== null}&nbsp;· <span class:soon={days < 14}>burns up in {days}d</span>{/if}</p>
                </div>
              </div>

              {#if readingsOf(receipt).length}
                <dl class="pki-reads">
                  {#each readingsOf(receipt) as reading (reading.field)}
                    <div class="pki-read">
                      <dt>{reading.label}</dt>
                      <dd><span class="pki-val">{reading.value}</span>{#if reading.sure !== null}<span class="pki-sure" class:unsure={!reading.sure}>{reading.sure ? "sure" : "unsure"}</span>{/if}</dd>
                    </div>
                  {/each}
                </dl>
              {/if}

              {#each papersOf(receipt) as paper (paper.name)}
                <p class="pki-paper"><span class="p-paper" aria-hidden="true">◆</span><span><span class="pki-pname">{paper.name}</span>{#if paper.meta}{` · ${paper.meta}`}{/if}&nbsp;· <span class="clean">scanned clean</span></span></p>
              {/each}

              {#if unreadable}<p class="p-prose pki-unread">{unreadable}</p>{/if}

              <div class="pki-acts">
                {#if busy === receipt.id}
                  <button class="p-pill filled wide" disabled aria-busy={busyAct === "approve"}>
                    {#if busyAct === "approve"}<span class="p-body breathing pki-busy" aria-hidden="true"></span>adding…{:else}Add to orbit{/if}
                  </button>
                  <button class="p-pill wide" disabled aria-busy={busyAct === "dismiss"}>
                    {#if busyAct === "dismiss"}<span class="p-body breathing pki-busy" aria-hidden="true"></span>dismissing…{:else}Dismiss{/if}
                  </button>
                {:else}
                  {#if locked(receipt)}
                    <!-- Locked (#941): nothing to accept until an administrator
                         restores the key, so the way in is shown, and shut. -->
                    <button class="p-pill filled wide" disabled>Add to orbit</button>
                  {:else}
                    <ArmButton label="Add to orbit" armedLabel="tap again to add" danger={false} wide class="filled pki-yes"
                               name="Add {titleOf(receipt)} to your orbit" onfire={() => approve(receipt)} />
                  {/if}
                  <ArmButton label="Dismiss" armedLabel="tap again to dismiss" wide class="pki-no"
                             name="Dismiss {titleOf(receipt)}" onfire={() => dismiss(receipt)} />
                {/if}
              </div>
              {#if problems.get(receipt.id)}<p class="p-error" role="alert">{problems.get(receipt.id)}</p>{/if}
              {#if !locked(receipt)}
                <button class="pki-amend" disabled={busy === receipt.id} onclick={() => openReview(receipt)}>review &amp; amend →</button>
              {/if}
            </article>
          {/each}
        </section>
      {/if}

      {#if view.reading.length}
        <section class="pki-lane" aria-labelledby="pki-reading-h">
          <h2 class="p-caps pki-lanehead" id="pki-reading-h">
            <span class="p-body up breathing" aria-hidden="true"></span>still reading<span class="pki-count">{view.reading.length}</span>
          </h2>
          <div class="p-card pki-rows">
            {#each view.reading as receipt, index (receipt.id)}
              <div class="pki-slot" style:--i={index} animate:flip={{ duration: 300 }}>
                <Row title="A message arrived {agoLong(/** @type {string} */ (receipt.receivedAt), view.now)}"
                     meta={receipt.message ?? "Orbit is reading it"} metaFace="ui">
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
            <span class="p-body pki-failmark" aria-hidden="true"></span>failed to process<span class="pki-count">{view.failed.length}</span>
          </h2>
          <div class="p-card pki-rows">
            {#each view.failed as failure, index (failure.id)}
              <div class="pki-slot" style:--i={index} animate:flip={{ duration: 300 }} out:leave={{ id: failure.id }}>
                <Row title="A message from {short(failure.receivedAt)}" metaFace="ui"
                     meta={receiptWords(failure.metadataStatus) ?? failure.message}
                     acts={failure.canDiscard ? [{
                       label: "remove", name: `Remove the message from ${short(failure.receivedAt)}`, danger: true,
                       onact: () => removeFailed(failure),
                     }] : []}>
                  {#snippet mark()}<span class="p-body pki-failmark"></span>{/snippet}
                </Row>
              </div>
            {/each}
          </div>
          {#if view.failed.some((one) => one.canDiscard)}
            <p class="pki-hint">swipe a message to remove it · the original stays in your mailbox</p>
          {/if}
        </section>
      {/if}

      <section class="pki-lane" aria-labelledby="pki-filed-h">
        <h2 class="p-caps pki-lanehead" id="pki-filed-h">
          <span class="p-body ok" aria-hidden="true"></span>filed{#if view.filed.length}<span class="pki-count">{view.filed.length}</span>{/if}
        </h2>
        {#if view.filed.length}
          <div class="p-card pki-rows">
            {#each view.filed as entry, index (entry.itemId)}
              <div class="pki-slot" style:--i={index} animate:flip={{ duration: 300 }}>
                <Row title={entry.title ?? "a filed item"} href={resolve("/item/[[id]]", { id: entry.itemId })}
                     meta="from {entry.sourceDocument} · added {filedDate(/** @type {string} */ (entry.filedAt))}">
                  {#snippet mark()}<span class="p-body {BANDS[entry.band] ?? 'ended'}"></span>{/snippet}
                </Row>
              </div>
            {/each}
          </div>
          <p class="pki-hint">every item the relay has fed into your orbit · its documents ride with it</p>
        {:else}
          <div class="p-card proposed">
            <p class="p-empty pki-empty">nothing filed yet · add an arrival to your orbit and it lands here</p>
          </div>
        {/if}
      </section>

      {#if !emptyQueue}
        <p class="pki-foot">unreviewed arrivals burn up after 45 days · originals stay in your mailbox, Orbit only ever reads copies</p>
      {/if}
    {/if}
  </main>

  <Sheet bind:open={reviewOpen} size="full" title="Review & amend">
    {#if reviewing && reviewEntry}
      <form id="pki-review-form" aria-label="Review {titleOf(reviewing)}"
            onsubmit={(event) => { event.preventDefault(); saveReview(); }}>
        <EntryForm bind:entry={reviewEntry} households={reviewHousehold ? [reviewHousehold] : []} mode="review" nested
                   disabled={busy === reviewing.id} readings={formReadings(reviewing)} papers={papersOf(reviewing)} />
      </form>
      {#if reviewProblem}<p class="p-error" role="alert">{reviewProblem}</p>
      {:else if reviewRefusal}<p class="pki-refusal" id="pki-refusal">{reviewRefusal}</p>{/if}
      <button type="submit" form="pki-review-form" class="p-pill filled wide pki-go"
              disabled={busy === reviewing.id || Boolean(reviewRefusal)}
              aria-describedby={reviewRefusal ? "pki-refusal" : undefined}>
        {busy === reviewing.id ? "adding…" : "add to orbit"}
      </button>
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
  .pki-sub{margin:6px 0 0;font:var(--p-type-meta)/1.5 var(--mono);color:var(--ink-quiet);letter-spacing:.02em}

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
     the lane's own body in the desk's key, and a count bead. */
  .pki-lane{margin-top:var(--p-group-above)}
  .pki-lanehead{display:flex;align-items:center;gap:10px;margin:0 0 var(--p-group-below);padding:0 2px}
  /* The kit's .p-body.failed, under another name: the desk's own
     `.inbox-page .failed` (a whole card) would match the kit's class here,
     because this dialect is drawn inside .inbox-page. */
  :global(.p-body.pki-failmark){color:var(--degraded)}
  .pki-count{margin-left:auto;min-width:22px;height:22px;padding:0 7px;box-sizing:border-box;border-radius:11px;
    display:grid;place-items:center;border:1px solid var(--line);color:var(--ink-mid);letter-spacing:0}

  /* A REVIEW: the dashed pen of "not yet in orbit" (.p-card.proposed). */
  .pki-receipt{animation:pki-land 460ms var(--p-ease) both;animation-delay:calc(var(--i, 0) * 70ms)}
  .pki-rhead{display:flex;align-items:flex-start;gap:var(--p-row-gap)}
  .pki-touch{position:relative;flex:none;width:var(--p-row-mark);height:24px;display:grid;place-items:center}
  /* The mark touches down: one ring going out as the card lands. */
  .pki-touch::after{content:"";position:absolute;left:50%;top:50%;width:10px;height:10px;margin:-5px 0 0 -5px;
    border-radius:50%;border:1.5px solid var(--accent);opacity:0;
    animation:pki-touchdown 900ms var(--p-ease) both;animation-delay:calc(var(--i, 0) * 70ms + 260ms)}
  .pki-rwords{flex:1;min-width:0}
  .pki-rtitle{margin:0;font:600 var(--p-type-sheet)/1.3 var(--display);color:var(--ink);overflow-wrap:anywhere}
  .pki-rwhen{margin:4px 0 0;font:var(--p-type-meta)/1.4 var(--mono);color:var(--ink-quiet)}
  .pki-rwhen .soon{color:var(--warm-text)}

  /* Readings as rows: label left, value right, the confidence in a word
     under the value, so a long value wraps under itself and a pair never
     folds into four lines (§2.6, must not get wrong). */
  .pki-reads{margin:12px 0 4px;padding:0}
  .pki-read{display:grid;grid-template-columns:minmax(64px, auto) 1fr;gap:12px;align-items:baseline;
    padding:10px 2px;border-top:1px solid var(--line-soft)}
  .pki-read dt{font:var(--p-type-meta)/1.4 var(--mono);color:var(--ink-quiet)}
  .pki-read dd{margin:0;display:flex;flex-wrap:wrap;justify-content:flex-end;align-items:baseline;gap:4px 10px;text-align:right}
  .pki-val{font:500 .9375rem/1.35 var(--mono);color:var(--ink);overflow-wrap:anywhere}
  .pki-sure{font:var(--p-type-caps)/1 var(--mono);letter-spacing:var(--p-type-caps-track);text-transform:uppercase;
    color:var(--ok-text)}
  .pki-sure.unsure{color:var(--warm-text)}

  .pki-paper{display:grid;grid-template-columns:auto 1fr;align-items:baseline;gap:0 10px;margin:8px 0 0;padding:10px 12px;
    border:1px solid var(--line-soft);border-radius:12px;font:var(--p-type-meta)/1.5 var(--mono);color:var(--ink-mid)}
  .pki-pname{color:var(--ink);overflow-wrap:anywhere}
  .pki-paper .clean{color:var(--ok-text)}
  .pki-unread{margin:10px 0 0;color:var(--ink-mid)}

  /* The acts that are the point of the card (§1.5): full width, stacked,
     never side by side under 200px each (§2.6). */
  .pki-acts{display:flex;flex-direction:column;gap:var(--p-pill-gap);margin-top:16px}
  .pki-acts :global(.p-pill:disabled){opacity:.55;cursor:default;box-shadow:none}
  .pki-busy{display:inline-block;margin-right:10px;color:currentColor;box-shadow:none}
  /* Dismiss burns the arrival: its word takes the danger ink (§1.8). */
  .pki-acts :global(.pki-no){--act:var(--overdue);--act-text:var(--overdue-text)}
  /* Add to orbit, armed, stays the filled accent and lights up, rather than
     taking the red wash a dangerous act arms with: it is a yes. */
  .pki-acts :global(.p-pill.arm.filled.armed){background:var(--accent);border-color:var(--accent);
    box-shadow:0 0 0 3px color-mix(in srgb, var(--accent) 30%, transparent), var(--p-pill-glow)}
  .pki-amend{display:flex;align-items:center;justify-content:center;width:100%;min-height:var(--p-hit);margin-top:4px;
    appearance:none;border:0;background:none;padding:0;cursor:pointer;
    font:var(--p-type-meta)/1.2 var(--mono);color:var(--accent-text);letter-spacing:.02em}
  .pki-amend:disabled{opacity:.5}
  .pki-amend:focus-visible{outline:2px solid var(--accent);outline-offset:-2px;border-radius:8px}

  /* ROW LANES: rows flush on the card's glass (the kit's .flushcard). Each
     row sits in a slot for its motion, so the kit's row-to-row hairline is
     drawn here, from the text edge, as the rail. */
  .pki-rows{padding:4px 0;overflow:hidden;display:flex;flex-direction:column}
  .pki-slot{position:relative;animation:pki-land 420ms var(--p-ease) both;animation-delay:calc(var(--i, 0) * 50ms)}
  .pki-slot + .pki-slot::before{content:"";position:absolute;z-index:2;top:0;right:0;pointer-events:none;
    left:calc(var(--p-gutter) + var(--p-row-mark) + var(--p-row-gap));border-top:1px solid var(--line-soft)}
  .pki-hint{margin:8px 0 0;padding:0 4px;font:var(--p-type-meta)/1.5 var(--mono);color:var(--ink-quiet)}
  .pki-empty{margin:0}

  .pki-quiet{margin-top:20px}
  .pki-quiet-h{margin:0;font:600 var(--p-type-sheet)/1.3 var(--display);color:var(--ink)}
  .pki-quiet-p{margin:8px 0 14px;color:var(--ink-mid)}
  .pki-alias{margin:0;padding:12px;border:1px dashed color-mix(in srgb, var(--accent) 45%, var(--line-soft));border-radius:12px;
    font:500 var(--p-type-meta)/1.4 var(--mono);color:var(--accent-text);overflow-wrap:anywhere;text-align:center}
  .pki-live{margin:8px 0 16px;text-align:center;font:var(--p-type-meta)/1.4 var(--mono);color:var(--ink-quiet)}
  .pki-live .ok{color:var(--ok-text)}

  .pki-foot{margin:28px 0 0;text-align:center;font:var(--p-type-meta)/1.7 var(--mono);color:var(--ink-quiet)}

  .pki-refusal{margin:12px 0 0;font:var(--p-type-meta)/1.4 var(--mono);color:var(--ink-mid)}
  .pki-go{margin-top:12px}
  .pki-go:disabled{opacity:.5;cursor:default;box-shadow:none}

  /* The two ways out, set as the transition starts (leave()). */
  :global(.pki-filing){border-style:solid !important;border-color:var(--ok) !important}
  :global(.pki-filing) :global(.p-body.sug){background:var(--ok);border-color:var(--ok)}
  :global(.pki-burning){border-color:var(--warm) !important;
    background:linear-gradient(color-mix(in srgb, var(--warm) 10%, transparent), transparent), var(--panel) !important}

  @keyframes pki-land{from{opacity:0;transform:translateY(-14px) scale(.985)}}
  @keyframes pki-touchdown{0%{opacity:.9;transform:scale(1)}100%{opacity:0;transform:scale(3.2)}}

  @media (prefers-reduced-motion:reduce){
    .pki-dish span,.pki-receipt,.pki-slot,.pki-touch::after{animation:none}
  }
</style>
