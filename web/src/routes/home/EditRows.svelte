<script>
  /*
   * THE DRAWER'S ROWS, LIVE (#1319 stage 2; owner-decisions §34; design/v19/
   * belt-purpose/round-8/m-colour-per-option.html, `editing` and its
   * choosers). Editing happens in the read view's own rows, with no form:
   * the labels stay, the values stay right-aligned mono, and only the value
   * is live — a 1px accent line under it and the caret. Due date, section,
   * type and orbital period are the value with a small chevron; pressed, the
   * row is lit and the screen stands the chooser card beside the drawer (the
   * phone's bottom sheet). Snoozed until and status are not fields — snooze
   * and complete set them — so they stay read-only lines.
   *
   * COMPLETING (owner, 2026-10-08: "it asks for the date, and pre-populates
   * to the current day, the cost you entered before, if you did and any
   * notes"): the same grammar for the completion's three values — the date
   * through the calendar, the cost and the notes typed in place.
   *
   * The desk (ItemView.svelte) and the phone (ItemDrawer.svelte) alike; the
   * title edits in the row's head at both widths (CorridorRow.svelte, and
   * the kit Row's `heading` on the phone).
   */
  import { longDate } from "$lib/format.js";
  import { periodWords } from "$lib/editing/item-draft.js";
  import { sectionColourOf, typeColourOf } from "$lib/option-colour.js";
  import { COST_LOCKED } from "$lib/data/metadata-status.js";

  /** @type {{
   *   modes: import('./drawer-modes.svelte.js').DrawerModes,
   *   sections: import('./drawer-modes.svelte.js').SectionChoice[],
   *   pocket?: boolean,
   *   snoozedUntil?: string | null,
   *   status?: string | null,
   *   costLocked?: boolean,
   * }} */
  let { modes, sections, pocket = false, snoozedUntil = null, status = null, costLocked = false } = $props();

  const kv = $derived(pocket ? "p-kv" : "kv");
  const draft = $derived(modes.edit.draft);
  const completing = $derived(modes.completing);
  const lit = $derived(modes.choosingKey);
  const section = $derived(sections.find((one) => one.id === draft?.sectionId) ?? null);

  /** @param {"due" | "section" | "type" | "months"} key @param {string} label @param {MouseEvent} event */
  const choose = (key, label, event) => modes.edit.choose(key, label, /** @type {HTMLElement} */ (event.currentTarget));

  /* One line each: Enter moves on to the next value rather than breaking
     the line (the notes keep their Enter). */
  /** @param {KeyboardEvent} event */
  function onkeydown(event) {
    const target = /** @type {HTMLElement} */ (event.target);
    if (event.key !== "Enter" || !target.matches?.("[data-ed]") || target.dataset.ed === "notes") return;
    event.preventDefault();
    const rows = /** @type {HTMLElement} */ (event.currentTarget);
    const all = [...rows.querySelectorAll("[data-ed], [data-pick]")];
    /** @type {HTMLElement | undefined} */ (all[all.indexOf(target) + 1])?.focus();
  }
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="rows" class:pocket data-edit-rows {onkeydown}>
  {#snippet chevron()}<svg viewBox="0 0 10 10" aria-hidden="true"><path d="M3.5 2 6.5 5 3.5 8"/></svg>{/snippet}
  {#if draft}
    <div class={kv} class:choosing={lit === "due"}><span>due</span>
      <button type="button" class="pick" data-pick aria-haspopup="dialog" aria-expanded={lit === "due"}
              aria-label="due: {draft.dueDate ? longDate(draft.dueDate) : 'unscheduled'}"
              onclick={(event) => choose("due", "due", event)}>
        <span>{draft.dueDate ? longDate(draft.dueDate) : "unscheduled"}</span>{@render chevron()}</button></div>
    {#if snoozedUntil}<div class={kv}><span>snoozed until</span><b>{longDate(snoozedUntil)}</b></div>{/if}
    {#if status && status !== "active"}<div class={kv}><span>status</span><b>{status}</b></div>{/if}
    <div class={kv} class:choosing={lit === "section"}><span>section</span>
      <button type="button" class="pick" data-pick aria-haspopup="dialog" aria-expanded={lit === "section"}
              aria-label="section: {section?.name ?? 'none'}" onclick={(event) => choose("section", "section", event)}>
        <span class="opt" data-opt={sectionColourOf(section)}>{section?.name ?? "none"}</span>{@render chevron()}</button></div>
    <div class={kv} class:choosing={lit === "type"}><span>type</span>
      <button type="button" class="pick" data-pick aria-haspopup="dialog" aria-expanded={lit === "type"}
              aria-label="type: {draft.kind ?? 'none'}" onclick={(event) => choose("type", "type", event)}>
        <span class="opt" data-opt={typeColourOf(draft.kind)}>{draft.kind ?? "none"}</span>{@render chevron()}</button></div>
    <div class={kv} class:choosing={lit === "months"}><span>orbital period</span>
      <button type="button" class="pick" data-pick aria-haspopup="dialog" aria-expanded={lit === "months"}
              aria-label="orbital period: {periodWords(draft.recurrence)}"
              onclick={(event) => choose("months", "orbital period", event)}>
        <span>{periodWords(draft.recurrence)}</span>{@render chevron()}</button></div>
    <div class={kv}><span>cost</span>
      <b class="ed" contenteditable="plaintext-only" spellcheck="false" role="textbox" tabindex="0"
         aria-label="cost" data-ed="cost" bind:textContent={draft.cost}></b></div>
    <div class={kv}><span>provider</span>
      <b class="ed" contenteditable="plaintext-only" spellcheck="false" role="textbox" tabindex="0"
         aria-label="provider" data-ed="provider" bind:textContent={draft.provider}></b></div>
    <div class={kv}><span>reference</span>
      <b class="ed" contenteditable="plaintext-only" spellcheck="false" role="textbox" tabindex="0"
         aria-label="reference" data-ed="reference" bind:textContent={draft.reference}></b></div>
    <div class={kv}><span>reminders</span>
      <b class="ed" contenteditable="plaintext-only" spellcheck="false" role="textbox" tabindex="0"
         aria-label="reminders" data-ed="reminders" bind:textContent={draft.reminders}></b></div>
    {#if pocket}<h3 class="p-caps">Notes</h3>{:else}<h4>notes</h4>{/if}
    <div class="notes ed" class:ivnotes={!pocket} class:p-prose={pocket} contenteditable="plaintext-only" spellcheck="true"
       role="textbox" tabindex="0" aria-multiline="true" aria-label="notes" data-ed="notes"
       bind:textContent={draft.notes}></div>
  {:else if completing}
    <div class={kv} class:choosing={lit === "done"}><span>completed on</span>
      <button type="button" class="pick" data-pick aria-haspopup="dialog" aria-expanded={lit === "done"}
              aria-label="completed on: {longDate(completing.completedDate)}"
              onclick={(event) => modes.chooseDone(/** @type {HTMLElement} */ (event.currentTarget))}>
        <span>{longDate(completing.completedDate)}</span>{@render chevron()}</button></div>
    <div class={kv}><span>cost</span>
      {#if costLocked}
        <b class="locked">locked</b>
      {:else}
        <b class="ed" contenteditable="plaintext-only" spellcheck="false" role="textbox" tabindex="0"
           aria-label="cost" data-ed="cost" bind:textContent={completing.cost}></b>
      {/if}</div>
    {#if costLocked}<p class="lockednote">{COST_LOCKED}</p>{/if}
    {#if pocket}<h3 class="p-caps">Notes</h3>{:else}<h4>notes</h4>{/if}
    <div class="notes ed" class:ivnotes={!pocket} class:p-prose={pocket} contenteditable="plaintext-only" spellcheck="true"
       role="textbox" tabindex="0" aria-multiline="true" aria-label="notes" data-ed="notes"
       bind:textContent={completing.notes}></div>
  {/if}
</div>

<style>
  .rows{display:contents}
  .kv,.p-kv{position:relative;align-items:center}
  .kv:last-of-type{border-bottom:1px solid var(--line-soft)}
  .p-kv>span{flex:none}

  /* EDIT IS LITERAL (round 2): only the value is live — a 1px accent line
     under it and the caret, no boxes, no placeholders, no other type. */
  .ed{outline:none;caret-color:var(--accent);box-shadow:0 1px 0 var(--accent);cursor:text;border-radius:0;
    min-width:4ch;display:inline-block;text-align:right;white-space:pre-wrap;overflow-wrap:anywhere}
  .ed:focus{box-shadow:0 1.5px 0 var(--accent)}
  .notes.ed{display:block;text-align:left;min-height:1.6em;margin:0}
  .pocket .notes{color:var(--ink)}
  .locked{color:var(--ink-quiet);font-weight:450}
  .lockednote{font:10.5px var(--mono);color:var(--ink-quiet);line-height:1.6;margin:6px 2px 0}

  /* THE CHOSEN VALUES (round 4, H): the value as it reads, a small chevron
     after it; pressed, the row is lit in the accent. The 44px target comes
     out of the row's own height, so nothing moves. */
  .pick{position:relative;display:inline-flex;align-items:center;gap:7px;cursor:pointer;font:inherit;
    color:var(--ink);font-weight:500;background:none;border:0;padding:0;box-shadow:0 1px 0 var(--accent);
    -webkit-tap-highlight-color:transparent}
  .pick::before{content:"";position:absolute;left:-8px;right:-8px;top:50%;height:44px;transform:translateY(-50%)}
  .pick svg{width:9px;height:9px;fill:none;stroke:var(--ink-mid);stroke-width:1.6;flex:none}
  .pick:focus-visible{outline:none;box-shadow:0 1.5px 0 var(--accent)}
  .pick:hover svg{stroke:var(--ink)}
  .choosing>span{color:var(--accent-text)}
  .choosing .pick{color:var(--accent-text);box-shadow:0 1.5px 0 var(--accent)}
  .choosing .pick svg{stroke:var(--accent-text)}
  /* round 8: the section and type words wear their own colour, lit or not */
  .opt{color:var(--opt-text, inherit)}
</style>
