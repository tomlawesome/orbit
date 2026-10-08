<script>
  import { untrack } from "svelte";

  /**
   * THE TILES (#1319; round 6's tiles, round 8's colour per option): a grid
   * of glass plates, one choice each — sections two by two, types three
   * across. A tile with a colour (option-colour.js) carries
   * `data-opt="<colour>"`, which packs.css maps onto --opt / --opt-text: at
   * rest it is glass washed in its colour and edged in it, hovered the wash
   * deepens and the edge goes full, chosen it is filled solid with the
   * page's ink reversed (--opt-ink in the light packs). A tile with no
   * colour (a document's own kind) wears the accent, as the calendar's
   * chosen day does.
   *
   * A radio group: one tile in the tab order (the chosen one); left and
   * right walk the tiles in order, wrapping, up and down move a row, Home
   * and End the ends. Arrows move focus only — a pick closes the card, so
   * it waits for Enter, Space or a press.
   *
   * @typedef {{
   *   choices: import('./item-draft.js').Choice[],
   *   value: string | null,
   *   label: string,
   *   cols: number,
   *   onpick: (value: string) => void,
   * }} Props
   */
  /** @type {Props} */
  let { choices, value, label, cols, onpick } = $props();

  /** The tile in the tab order: the chosen one, else the first. */
  let active = $state(untrack(() => Math.max(0, choices.findIndex((c) => c.value === value))));
  /** @type {HTMLDivElement | undefined} */
  let group = $state();

  /** @param {KeyboardEvent} event @param {number} i */
  function walk(event, i) {
    const n = choices.length;
    const to = event.key === "Home" ? 0 : event.key === "End" ? n - 1
      : event.key === "ArrowLeft" ? (i - 1 + n) % n : event.key === "ArrowRight" ? (i + 1) % n
      : event.key === "ArrowUp" ? (i - cols >= 0 ? i - cols : i)
      : event.key === "ArrowDown" ? (i + cols < n ? i + cols : i) : null;
    if (to === null) return;
    event.preventDefault();
    active = to;
    /** @type {HTMLButtonElement | undefined} */ (group?.querySelectorAll("[role=radio]")[to])?.focus({ preventScroll: true });
  }
</script>

<div class="tiles" role="radiogroup" aria-label={label} bind:this={group} style:--cols={cols}>
  {#each choices as choice, i (choice.value)}
    <button type="button" class="tile" role="radio" aria-checked={choice.value === value}
            data-opt={choice.colour ?? undefined} tabindex={i === active ? 0 : -1}
            onclick={() => onpick(choice.value)} onkeydown={(e) => walk(e, i)} onfocus={() => (active = i)}>
      <b>{choice.words}</b>
      {#if choice.note}<small>{choice.note}</small>{/if}
    </button>
  {/each}
</div>

<style>
  .tiles{display:grid;gap:8px;margin-top:10px;grid-template-columns:repeat(var(--cols,2),minmax(0,1fr))}
  /* 60px tall: a 44px target with room to breathe */
  .tile{min-height:60px;border:1px solid var(--line-soft);background:var(--panel);border-radius:12px;cursor:pointer;
        padding:8px;margin:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:4px;
        font:var(--p-type-meta) var(--mono);color:var(--ink);text-align:center;overflow-wrap:anywhere;
        transition:background .15s,border-color .15s,color .15s}
  .tile>b{font-weight:500}
  .tile>small{font:var(--p-type-meta) var(--mono);color:var(--ink-faint);letter-spacing:.02em}
  .tile:hover{background:var(--panel-raised);border-color:var(--line)}
  .tile:focus-visible{outline:none;border-color:var(--accent);box-shadow:inset 0 0 0 1px var(--accent)}
  .tile[aria-checked=true],.tile[aria-checked=true]:hover{background:var(--accent-text);border-color:var(--accent-text);color:var(--bg)}
  .tile[aria-checked=true]>small{color:var(--bg);opacity:.78}
  .tile[aria-checked=true]:focus-visible{box-shadow:0 0 0 2px var(--bg),0 0 0 3.5px var(--accent-text)}
  /* round 8: a colour per option */
  .tile[data-opt]{border-color:color-mix(in srgb,var(--opt) 60%,var(--line-soft));background-color:var(--panel);
       background-image:linear-gradient(color-mix(in srgb,var(--opt) 14%,transparent),color-mix(in srgb,var(--opt) 14%,transparent))}
  .tile[data-opt]:hover{border-color:var(--opt);background-color:var(--panel-raised);
       background-image:linear-gradient(color-mix(in srgb,var(--opt) 24%,transparent),color-mix(in srgb,var(--opt) 24%,transparent))}
  .tile[data-opt]:focus-visible{border-color:var(--accent);box-shadow:inset 0 0 0 1px var(--accent)}
  .tile[data-opt][aria-checked=true],.tile[data-opt][aria-checked=true]:hover{background-image:none;background-color:var(--opt-text);
       border-color:var(--opt-text);color:var(--opt-ink,var(--bg))}
  .tile[data-opt][aria-checked=true]>small{color:var(--opt-ink,var(--bg))}
  .tile[data-opt][aria-checked=true]:focus-visible{box-shadow:0 0 0 2px var(--bg),0 0 0 3.5px var(--opt-text)}
  @media (prefers-reduced-motion: reduce){
    .tile{transition:none}
  }
</style>
