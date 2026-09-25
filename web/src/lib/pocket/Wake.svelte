<script>
  import { dismissWake, subscribeWake, undoWake } from "./wake.js";
  import { portal } from "./portal.js";

  /**
   * The wake's host (#1120, proposal §1.13). Mounted once, in the root
   * layout; screens raise a wake through wake.js, never by holding this.
   * It lives directly on <body> marked data-pocket-above, so an open sheet's
   * inert page leaves it live and its undo stays pressable above the sheet.
   *
   * Both live regions are always in the page and never hidden, empty at
   * rest: a region that appears together with its text is often not
   * announced at all, and the drawn bar is visibility:hidden at rest.
   */
  /** @type {import('./wake.js').WakeEntry | null} */
  let entry = $state(null);
  /* The drawn line keeps its words while it falls away. */
  let shown = $state("");
  $effect(() => subscribeWake((next) => {
    entry = next;
    if (next) shown = next.message;
  }));
</script>

<div class="p-wake-host" data-pocket-above use:portal>
  <span class="sr-only" role="status" aria-live="polite">{entry && !entry.failure ? entry.message : ""}</span>
  <span class="sr-only" role="alert" aria-live="assertive">{entry?.failure ? entry.message : ""}</span>
  <div class="p-wake" class:up={entry !== null} class:failure={entry?.failure}
     class:reversible={Boolean(entry?.undo) && !entry?.failure}>
    <!-- Announced by the regions above; drawn here. -->
    <span class="msg" aria-hidden="true">{shown}</span>
    {#if entry?.undo}
      <button class="p-pill act-accent undo" onclick={undoWake}>undo</button>
    {:else if entry}
      <button class="p-pill close" aria-label="Dismiss" onclick={() => dismissWake()}>×</button>
    {/if}
  </div>
</div>

<style>
  .p-wake-host{position:fixed;left:0;right:0;bottom:0;z-index:60;pointer-events:none;
    display:flex;justify-content:center;
    padding:0 var(--p-gutter) calc(12px + env(safe-area-inset-bottom))}
  .p-wake{pointer-events:auto;width:100%;max-width:var(--p-column);min-height:52px;
    display:flex;align-items:center;gap:12px;padding:4px 4px 4px 16px;
    background:var(--panel-raised);border:1px solid var(--line);
    border-radius:26px;box-shadow:inset 3px 0 0 var(--wake-act, var(--ok)), 0 8px 24px rgb(0 0 0 / .25);
    transform:translateY(calc(100% + 24px));visibility:hidden;
    transition:transform var(--p-wake) var(--p-ease),visibility 0s var(--p-wake)}
  .p-wake.up{transform:none;visibility:visible;transition-delay:0s}
  .msg{font:var(--p-type-meta)/1.4 var(--ui);color:var(--ink);min-width:0;
    overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .msg{flex:1}
  /* The leading rule (§5.2) says what happened: done in --ok, reversible
     in the accent, a failure in red. No blur: the raised panel is opaque
     enough, and this layer is fixed over scrolling content (§5.3). */
  .p-wake.reversible{--wake-act:var(--accent)}
  :global([data-theme=retrograde]) .p-wake.reversible{
    box-shadow:inset 3px 0 0 var(--accent), -3px 0 8px -4px var(--bloom), 0 8px 24px rgb(0 0 0 / .25)}
  .failure{--wake-act:var(--overdue);border-color:var(--overdue)}
  .failure .msg{color:var(--overdue-text)}
  .close{border-color:transparent;font-size:1.25rem}
  @media (prefers-reduced-motion:reduce){ .p-wake{transition:none} }
</style>
