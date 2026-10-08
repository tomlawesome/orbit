<script>
  import { untrack } from "svelte";

  /**
   * THE PERIOD BAND, STOOD UP (#1319; round 7's band, kept in round 8): one
   * segmented band down the card, a cell per period (item-draft.js
   * periodChoices), once at the top to two years at the foot — the figure
   * large beside its unit, hairlines between. The chosen cell is filled in
   * the accent, as the calendar's chosen day is. Under it the calendar's
   * own foot line reads the cell under the pointer or the keys: its words,
   * and the date it would next come round to.
   *
   * A radio group: one cell in the tab order (the chosen one); every arrow
   * walks the cells, wrapping, Home and End the ends. Arrows move focus
   * only — a pick closes the card, so it waits for Enter, Space or a press.
   *
   * @typedef {{
   *   choices: import('./item-draft.js').Choice[],
   *   value: string | null,
   *   label: string,
   *   onpick: (value: string) => void,
   * }} Props
   */
  /** @type {Props} */
  let { choices, value, label, onpick } = $props();

  /** The cell in the tab order, and the foot's at rest: the chosen one, else the first. */
  let active = $state(untrack(() => Math.max(0, choices.findIndex((c) => c.value === value))));
  /** @type {number | null} */
  let hover = $state(null);
  /** @type {HTMLDivElement | undefined} */
  let group = $state();

  const shown = $derived(choices[hover ?? active]);

  const NEXT = new Set(["ArrowDown", "ArrowRight"]);
  const BACK = new Set(["ArrowUp", "ArrowLeft"]);

  /** @param {KeyboardEvent} event @param {number} i */
  function walk(event, i) {
    const n = choices.length;
    const to = event.key === "Home" ? 0 : event.key === "End" ? n - 1
      : NEXT.has(event.key) ? (i + 1) % n : BACK.has(event.key) ? (i - 1 + n) % n : null;
    if (to === null) return;
    event.preventDefault();
    active = to;
    /** @type {HTMLButtonElement | undefined} */ (group?.querySelectorAll("[role=radio]")[to])?.focus({ preventScroll: true });
  }

  /** @param {import('./item-draft.js').Choice} choice */
  const spoken = (choice) => (choice.note && choice.note !== "once" ? `${choice.words}, ${choice.note}` : choice.words);
</script>

<div class="band" role="radiogroup" aria-label={label} bind:this={group}>
  {#each choices as choice, i (choice.value)}
    <button type="button" class="cell" role="radio" aria-checked={choice.value === value} aria-label={spoken(choice)}
            tabindex={i === active ? 0 : -1}
            onclick={() => onpick(choice.value)} onkeydown={(e) => walk(e, i)} onfocus={() => (active = i)}
            onpointerenter={() => (hover = i)} onpointerleave={() => (hover = null)}>
      <b>{choice.figure ?? choice.words}</b>
      {#if choice.unit}<small>{choice.unit}</small>{/if}
    </button>
  {/each}
</div>
{#if shown}
  <div class="foot">
    <span class="when"><b>{shown.words}</b></span>
    <span class="rel">{shown.note ?? ""}</span>
  </div>
{/if}

<style>
  .band{display:grid;grid-template-columns:minmax(0,1fr);margin-top:10px;
        border:1px solid var(--line);border-radius:11px;overflow:hidden;background:var(--panel)}
  /* 52px tall: a 44px target with room */
  .cell{min-height:52px;border:0;border-top:1px solid var(--line-soft);border-radius:0;background:none;margin:0;
        padding:6px 16px;display:flex;flex-wrap:wrap;align-items:baseline;align-content:center;justify-content:center;gap:6px;
        font:var(--p-type-meta) var(--mono);color:var(--ink);text-align:center;cursor:pointer;
        transition:background .15s,color .15s}
  .cell:first-child{border-top:0}
  .cell>b{font-size:14.5px;font-weight:500}
  .cell>small{font:var(--p-type-meta) var(--mono);color:var(--ink-faint)}
  .cell:hover{background:var(--panel-raised)}
  .cell:focus-visible{outline:none;box-shadow:inset 0 0 0 1.5px var(--accent)}
  .cell[aria-checked=true],.cell[aria-checked=true]:hover{background:var(--accent-text);border-color:var(--accent-text);color:var(--bg)}
  .cell[aria-checked=true]>small{color:var(--bg)}
  .cell[aria-checked=true]:focus-visible{box-shadow:inset 0 0 0 2px var(--bg),inset 0 0 0 3.5px var(--accent-text)}
  /* the calendar's foot line */
  .foot{display:flex;justify-content:space-between;align-items:center;gap:12px;min-height:30px;margin-top:8px;
        padding-top:10px;border-top:1px solid var(--line-soft);font:var(--p-type-meta) var(--mono);color:var(--ink-mid)}
  .foot b{font-weight:500;color:var(--ink)}
  .rel{flex:none}
  @media (prefers-reduced-motion: reduce){
    .cell{transition:none}
  }
</style>
