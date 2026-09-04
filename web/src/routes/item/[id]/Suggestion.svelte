<script>
  import { onMount } from "svelte";
  import { goto } from "$app/navigation";
  import { resolve } from "$app/paths";
  import { mountItemSky } from "./sky.js";
  import { approveReceipt, dismissReceipt, readWorkspace } from "$lib/data/workspace.js";
  import "./item.css";

  /**
   * Amend-then-accept (#434), unchanged and unmoved in substance: a mail-in
   * suggestion opens at the item's own address, every proposed field editable,
   * fields read from the document carrying the from-document mark, and
   * acceptance the only path into the household.
   *
   * WHY IT LIVES IN ITS OWN COMPONENT NOW (#458). The belt took over /item as
   * the item screen, but a suggestion is not an item: it has no due date in
   * the manifest, no seat in the band and no neighbours in time, because it is
   * not in the household yet. Putting it at the apex of a belt would be
   * drawing a body that does not exist. So the address forks — the belt for
   * what Orbit holds, this card for what is only proposed — and this half
   * keeps the retired item view's own sheet (item.css), imported HERE so the
   * belt's page never loads a stylesheet that fights it. The page imports this
   * component lazily for the same reason.
   */
  /** @type {{ item: import('$lib/data/workspace.js').ItemView }} */
  let { item } = $props();

  let busy = $state(false);
  /** @type {string | null} */
  let problem = $state(null);

  /** @param {string} text */
  const minorOf = (text) => {
    const value = Number.parseFloat(String(text).replace(",", "."));
    return Number.isFinite(value) ? Math.round(value * 100) : undefined;
  };

  /* A suggestion always carries a (possibly empty) proposal from the parser
     -- see ItemView's own doc comment -- so this narrows what's already
     guaranteed rather than changing behaviour. */
  const proposal = /** @type {NonNullable<typeof item.proposal>} */ (item.proposal);

  /* Initialised synchronously: the first render must already know its
     values — an effect lands after render. */
  let sform = $state({
    title: proposal.title ?? "Forwarded email",
    provider: proposal.provider ?? "",
    reference: proposal.reference ?? "",
    cost: proposal.costMinor != null ? (proposal.costMinor / 100).toFixed(2) : "",
    dueDate: proposal.dueDate ?? "",
    recurrenceMonths: proposal.recurrenceMonths ?? "",
  });
  let acceptArmedDismiss = $state(false);
  /** @type {string | null} */
  let acceptOpId = null;
  /** @param {string} field */
  const marked = (field) => Boolean(item?.fieldEvidence?.[field]);

  async function accept() {
    busy = true;
    problem = null;
    try {
      acceptOpId ??= crypto.randomUUID();
      /** @type {import('$lib/data/workspace.js').ItemProposal} */
      const amended = { title: sform.title.trim() || "Forwarded email", currency: item.currency };
      if (proposal.subtype) amended.subtype = proposal.subtype;
      if (sform.provider.trim()) amended.provider = sform.provider.trim();
      if (sform.reference.trim()) amended.reference = sform.reference.trim();
      const cost = minorOf(sform.cost);
      if (cost !== undefined) amended.costMinor = cost;
      if (sform.dueDate) {
        amended.dueDate = sform.dueDate;
        if (proposal.scheduleKind) {
          amended.scheduleKind = proposal.scheduleKind;
          const months = Number(sform.recurrenceMonths);
          if (months) amended.recurrenceMonths = months;
        }
      }
      const workspace = await readWorkspace();
      const fallback = workspace.activeHouseholdId ?? workspace.households[0]?.id ?? null;
      /* This card only mounts for a suggestion (#458's fork), so item always
         carries the ReceiptSuggestion fields ItemView makes optional. */
      const suggestion = /** @type {import('$lib/data/workspace.js').ReceiptSuggestion} */ (item);
      const result = await approveReceipt(suggestion, fallback, acceptOpId, amended);
      if (result.outcome === "partial_success") {
        problem = "The item is recorded, but its documents need another try — accept again to finish.";
        return;
      }
      acceptOpId = null;
      /* Accepted: it is an item now, so it has a seat in the belt. */
      await goto(result.itemId ? resolve("/item/[id]", { id: result.itemId }) : resolve("/home"));
    } catch (error) {
      problem = /** @type {{ message?: string }} */ (error)?.message ?? String(error);
    } finally {
      busy = false;
    }
  }

  async function dismissSuggestion() {
    if (!acceptArmedDismiss) {
      acceptArmedDismiss = true;
      return;
    }
    busy = true;
    problem = null;
    try {
      /* Same suggestion-only invariant as accept(): receiptId is always set. */
      await dismissReceipt(/** @type {string} */ (item.receiptId));
      await goto(resolve("/home"));
    } catch (error) {
      problem = /** @type {{ message?: string }} */ (error)?.message ?? String(error);
      acceptArmedDismiss = false;
    } finally {
      busy = false;
    }
  }

  /* POL-11: every page's sky drifts. Decorative and aria-hidden. */
  /** @type {HTMLDivElement | undefined} */
  let sky;
  onMount(() => mountItemSky(/** @type {Element} */ (sky)));
</script>

<svelte:head>
  <link rel="stylesheet" href="/screens/family.css" />
  <title>{sform.title} — Orbit</title>
</svelte:head>

<div class="sky" aria-hidden="true" bind:this={sky}></div>

<div class="stage">
  <article class="glass item-card" style="--act:var(--ok)">
    <input class="name-title" bind:value={sform.title} aria-label="name"
           class:sugg={marked("title")}>
    <div class="sub">suggested from your documents · {item.sourceDocument}</div>

    <div class="panel">
      <div class="row2">
        <div class="field" class:sugg={marked("dueDate")}>
          <label for="s-due">renews / due</label>
          <input id="s-due" type="date" bind:value={sform.dueDate}></div>
        <div class="field" class:sugg={marked("recurrenceMonths")}>
          <label for="s-recur">orbital period (months)</label>
          <input id="s-recur" inputmode="numeric" bind:value={sform.recurrenceMonths}></div>
      </div>
      <div class="row2">
        <div class="field" class:sugg={marked("provider")}>
          <label for="s-provider">provider</label>
          <input id="s-provider" bind:value={sform.provider} placeholder="optional"></div>
        <div class="field" class:sugg={marked("reference")}>
          <label for="s-reference">reference</label>
          <input id="s-reference" bind:value={sform.reference} placeholder="optional"></div>
      </div>
      <div class="field mono" class:sugg={marked("costMinor")}>
        <label for="s-cost">cost</label>
        <input id="s-cost" inputmode="decimal" bind:value={sform.cost} placeholder="optional"></div>
      {#if (item.attachmentCount ?? 0) > 0}
        <div class="note">◆ {item.sourceDocument} will be attached on acceptance</div>
      {/if}
      <div class="save-row">
        <button class="btn-primary" disabled={busy || !sform.title.trim()} onclick={accept}>
          accept into orbit
        </button>
        <button class="btn-quiet" style="--act:var(--overdue)" disabled={busy} onclick={dismissSuggestion}>
          {acceptArmedDismiss ? "tap again to dismiss" : "dismiss"}
        </button>
        <a class="back" style="margin-top:0" href={resolve("/home")}>← back to your orbit</a>
      </div>
      {#if problem}
        <div class="problem" role="alert">{problem}</div>
      {/if}
      <div class="note">nothing is created without your acceptance — an
        unaccepted suggestion simply expires and is purged</div>
    </div>
  </article>
</div>
<div class="vignette" aria-hidden="true"></div>
