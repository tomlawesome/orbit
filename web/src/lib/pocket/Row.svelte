<script>
  import ArmButton from "./ArmButton.svelte";
  import { mountRow } from "./row.js";

  /**
   * THE ROW (#1120, proposal §1.5): one line of any pocket list.
   *
   *   ●  Title in 16px ui, one line, ellipsis          T-16d
   *      meta in 13px, wraps                          29 Aug
   *   24px mark column · 12px gap · 56px min height · 16px side padding
   *
   * The whole row is the tap target when it navigates (`href`) or summons a
   * sheet (`onactivate`). Its management acts sit behind a horizontal swipe
   * (row.js, owner decision §25): at rest the row shows no extra buttons.
   * A `danger` act still arms on its first tap and fires on its second.
   * With `onmove`, the row can be reordered from the keyboard (Alt-↑/↓) and
   * by screen reader (hidden "Move … up/down" buttons); the long press is
   * the list's (reorder.js, `use:mountReorder` on the list).
   *
   * Every act's `name` is its full accessible name, object included:
   * { label: "remove", name: "Remove Emma Lawson", onact, danger: true }.
   * @typedef {{
   *   title: string,
   *   meta?: string,
   *   trail?: string,
   *   trailSub?: string,
   *   trailTone?: string,
   *   href?: string,
   *   onactivate?: () => void,
   *   current?: boolean,
   *   acts?: import("./row.js").RowAct[],
   *   onmove?: (direction: -1 | 1) => void,
   *   mark?: import('svelte').Snippet,
   *   below?: import('svelte').Snippet,
   * }} Props
   */
  /** @type {Props} */
  let {
    title,
    meta = "",
    trail = "",
    trailSub = "",
    trailTone = "",
    href = undefined,
    onactivate = undefined,
    current = false,
    acts = [],
    onmove = undefined,
    mark = undefined,
    below = undefined,
  } = $props();

  /** @type {HTMLElement | undefined} */
  let row = $state();
  /** @type {ReturnType<typeof mountRow> | undefined} */
  let control;
  $effect(() => {
    if (!row) return;
    control = mountRow(row);
    return () => control?.destroy();
  });

  /** @param {import("./row.js").RowAct} act */
  async function run(act) {
    await act.onact();
    control?.close(true);
  }

  /** @param {KeyboardEvent} event */
  function onkeydown(event) {
    if (!onmove || !event.altKey) return;
    if (event.key === "ArrowUp") { event.preventDefault(); onmove(-1); }
    else if (event.key === "ArrowDown") { event.preventDefault(); onmove(1); }
  }
  /** @param {KeyboardEvent} event */
  function onkeyactivate(event) {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    onactivate?.();
  }
  /** @param {KeyboardEvent} event */
  function onfacekey(event) {
    if (onactivate) onkeyactivate(event);
    onkeydown(event);
  }
  const keys = $derived(
    [acts.length ? "ArrowLeft ArrowRight" : "", onmove ? "Alt+ArrowUp Alt+ArrowDown" : ""].filter(Boolean).join(" ")
    || undefined,
  );
</script>

<div class="p-row" class:current class:has-acts={acts.length > 0} data-row bind:this={row}>
  <!-- One face whatever the row does: a link when it navigates, a button
       when it summons a sheet, a focusable group when its only job for the
       keyboard is to reach its acts (← →) or move (Alt-↑/↓), else inert.
       A dynamic element rather than four branches sharing a snippet: a
       snippet here is hoisted by the compiler and drags the script's doc
       comments into a declaration the production bundler cannot parse. -->
  <svelte:element this={href ? "a" : "div"} class="face" data-row-face
      href={href || undefined}
      role={href ? undefined : onactivate ? "button" : acts.length || onmove ? "group" : undefined}
      aria-label={!href && !onactivate && (acts.length || onmove) ? title : undefined}
      aria-current={href && current ? "page" : undefined}
      tabindex={href ? undefined : onactivate || acts.length || onmove ? 0 : undefined}
      aria-keyshortcuts={keys}
      onclick={onactivate}
      onkeydown={onfacekey}>
    <span class="mark" aria-hidden="true">{@render mark?.()}</span>
    <span class="text">
      <span class="title">{title}</span>
      {#if meta}<span class="meta">{meta}</span>{/if}
    </span>
    {#if trail || trailSub}
      <span class="trail" style:color={trailTone || undefined}>{trail}{#if trailSub}<small>{trailSub}</small>{/if}</span>
    {/if}
  </svelte:element>
  {#if acts.length}
    <div class="acts" data-row-acts>
      {#each acts as act (act.name)}
        {#if act.danger}
          <!-- "tap again" alone: the row's slot is narrow, and the full words
               ("tap again to remove Emma Lawson") are the accessible name. -->
          <ArmButton label={act.label} armedLabel="tap again" name={act.name} tabindex={-1} onfire={() => run(act)} />
        {:else}
          <button class="p-pill" tabindex="-1" aria-label={act.name} onclick={() => run(act)}>{act.label}</button>
        {/if}
      {/each}
    </div>
  {/if}
  {#if onmove}
    <button class="sr-only move" tabindex="-1" onclick={() => onmove(-1)}>Move {title} up</button>
    <button class="sr-only move" tabindex="-1" onclick={() => onmove(1)}>Move {title} down</button>
  {/if}
</div>
{#if below}<div class="p-row-below">{@render below()}</div>{/if}

<style>
  /* clip, not hidden: hidden can still scroll, and focusing a pill that is
     still sliding in would scroll the row and close it (row.js onScroll). */
  .p-row{position:relative;overflow:clip;border-radius:12px}
  .face{position:relative;z-index:1;display:flex;align-items:center;gap:var(--p-row-gap);
    min-height:var(--p-row-min);padding:6px var(--p-gutter);box-sizing:border-box;
    background:linear-gradient(var(--panel), var(--panel)), var(--bg);color:var(--ink);text-decoration:none;
    touch-action:pan-y;-webkit-tap-highlight-color:transparent;transition:background-color 120ms}
  a.face,[role=button].face{cursor:pointer}
  a.face:active,[role=button].face:active{background:var(--panel-raised)}
  .face:focus-visible{outline:2px solid var(--accent);outline-offset:-2px}
  .mark{flex:none;width:var(--p-row-mark);display:grid;place-items:center;color:var(--ink-mid)}
  .mark:empty{display:none}
  .text{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px}
  .title{font:500 var(--p-type-body)/1.3 var(--ui);color:var(--ink);
    white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .current .title{color:var(--accent-text)}
  .meta{font:var(--p-type-meta)/1.4 var(--ui);color:var(--ink-quiet)}
  .trail{flex:none;text-align:right;font:500 var(--p-type-meta)/1.3 var(--mono);color:var(--ink-mid)}
  .trail small{display:block;font-size:var(--p-type-meta);color:var(--ink-quiet);font-weight:400}

  /* THE ACT TRAY (Fable, #1120): the face never moves. The tray slides over
     it from the trailing edge, as wide as its pills and never wider than
     the row less 120px, so the mark and at least 56px of the title always
     show. Off the row at rest and unseen (opacity, never visibility or
     display, so a screen reader still reaches the acts: owner decision §25).
     row.js moves it with the finger and clears that for the CSS to settle. */
  .acts{position:absolute;z-index:2;top:0;right:0;bottom:0;max-width:calc(100% - 120px);
    display:flex;align-items:center;justify-content:flex-end;gap:6px;padding:0 8px;box-sizing:border-box;
    background:var(--panel-raised);opacity:0;transform:translateX(100%);
    transition:transform var(--p-spring) var(--p-ease),opacity var(--p-spring)}
  /* Tray pills: still 44 tall, 14px mono labels, 10px sides. */
  .acts :global(.p-pill){padding:0 10px;font-size:.875rem}
  /* :global because row.js sets these attributes, so the compiler cannot
     see them in the template and would drop the rule as unused. */
  :global(.p-row[data-open]) .acts,:global(.p-row[data-swiping]) .acts{opacity:1}
  :global(.p-row[data-open]) .acts{transform:none}
  /* Swiped: the text column gives the tray its room (row.js sets
     --p-row-tray to the tray's width) and the title ellipsises; the meta
     line keeps its height so the list does not jump, and the trail goes. */
  :global(.p-row[data-open]) .face,:global(.p-row[data-swiping]) .face{
    padding-right:max(var(--p-gutter), var(--p-row-tray, 0px))}
  :global(.p-row[data-open]) .meta,:global(.p-row[data-swiping]) .meta{visibility:hidden}
  :global(.p-row[data-open]) .trail,:global(.p-row[data-swiping]) .trail{display:none}

  /* The global .sr-only leaves a button's own padding and border, which
     would draw a small visible box. */
  .move{padding:0;border:0;margin:-1px}

  /* Long-press lift (reorder.js). */
  :global(.p-row[data-lifted]){z-index:3;overflow:visible;box-shadow:0 10px 28px rgb(0 0 0 / .35);
    transition:none}
  :global([data-reordering]) .face{-webkit-user-select:none;user-select:none;-webkit-touch-callout:none}
  .p-row-below{display:flex;flex-wrap:wrap;gap:var(--p-pill-gap);padding:0 var(--p-gutter) 12px
    calc(var(--p-gutter) + var(--p-row-mark) + var(--p-row-gap))}
  .p-row-below > :global(*){flex:1 1 40%}
  /* Reduced motion: the tray appears and goes without sliding. */
  @media (prefers-reduced-motion:reduce){ .acts{transition:none} }
</style>
