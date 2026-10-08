<script>
  import { tick, untrack } from "svelte";
  import { longDate, tminus } from "$lib/format.js";
  import { DOW, DOW_LONG, MONTHS_LONG, bandOf, isoOf, monthGrid, relWords, restingDay, spokenDate, stepDay } from "./calendar.js";

  /**
   * THE CHOOSER'S MONTH CALENDAR (#1319; round 8's `editing-date`, rounds
   * 4-5 for its shape): the month, ‹ and › either side; six weeks of seven,
   * Monday first; and a foot line reading the day under the pointer or the
   * keys — its long date, and its T-minus in the corridor's band colour
   * with the distance in words — with `today` beside it when the month is
   * another. The chosen day is filled in the accent; today is ringed.
   *
   * A grid (calendar.js stepDay): arrows a day or a week, Home and End the
   * week's ends, PageUp and PageDown a month (Shift, a year); one day at a
   * time is in the tab order, and it is the day the foot reads. A day
   * pressed is picked.
   *
   * @typedef {{
   *   value: string | null,
   *   today: string,
   *   onpick: (value: string) => void,
   * }} Props
   */
  /** @type {Props} */
  let { value, today, onpick } = $props();

  const start = untrack(() => value ?? today);
  let year = $state(Number(start.slice(0, 4)));
  let month = $state(Number(start.slice(5, 7)) - 1);
  /** The day in the tab order, and the foot's at rest. */
  let draft = $state(start);
  /** The day under the pointer, which the foot reads while it is there. @type {string | null} */
  let hover = $state(null);

  const weeks = $derived(monthGrid(year, month, today));
  const shown = $derived(hover ?? draft);
  const away = $derived(Number(today.slice(0, 4)) !== year || Number(today.slice(5, 7)) - 1 !== month);
  const title = $derived(`${MONTHS_LONG[month]} ${year}`);

  /** @type {HTMLDivElement | undefined} */
  let grid = $state();

  /** @param {string} iso */
  function show(iso) {
    year = Number(iso.slice(0, 4));
    month = Number(iso.slice(5, 7)) - 1;
    draft = iso;
  }

  /** @param {string} iso */
  async function focusDay(iso) {
    await tick();
    /** @type {HTMLButtonElement | null | undefined} */
    const cell = grid?.querySelector(`[data-iso="${iso}"]`);
    cell?.focus({ preventScroll: true });
  }

  /** ‹ and ›: the month either side, the draft held to it. @param {number} n */
  function turn(n) {
    const first = isoOf(year, month + n, 1);
    const y = Number(first.slice(0, 4));
    const m = Number(first.slice(5, 7)) - 1;
    year = y;
    month = m;
    draft = restingDay(y, m, draft, value);
  }

  function toToday() {
    show(today);
    focusDay(today);
  }

  /** @param {KeyboardEvent} event @param {string} iso */
  function step(event, iso) {
    const to = stepDay(iso, event.key, event.shiftKey);
    if (!to) return;
    event.preventDefault();
    show(to);
    focusDay(to);
  }
</script>

<div class="cal">
  <div class="nav">
    <button type="button" class="arrow" aria-label="Previous month" onclick={() => turn(-1)}>
      <svg viewBox="0 0 12 12" aria-hidden="true"><path d="M7.5 2 3.5 6 7.5 10" /></svg>
    </button>
    <b aria-live="polite">{title}</b>
    <button type="button" class="arrow" aria-label="Next month" onclick={() => turn(1)}>
      <svg viewBox="0 0 12 12" aria-hidden="true"><path d="M4.5 2 8.5 6 4.5 10" /></svg>
    </button>
  </div>
  <div class="grid" role="grid" aria-label={title} bind:this={grid}>
    <div class="row" role="row">
      {#each DOW as dow, i (dow)}
        <span class="dow" role="columnheader" aria-label={DOW_LONG[i]}>{dow}</span>
      {/each}
    </div>
    {#each weeks as week (week[0].iso)}
      <div class="row" role="row">
        {#each week as d (d.iso)}
          <div class="cell" role="gridcell" aria-selected={d.iso === value}>
            <button type="button" class="day" class:off={d.off} class:past={d.past} class:today={d.today}
                    class:chosen={d.iso === value} data-iso={d.iso} tabindex={d.iso === draft ? 0 : -1}
                    aria-label={`${spokenDate(d.iso)}${d.today ? ", today" : ""}`}
                    onclick={() => onpick(d.iso)} onkeydown={(e) => step(e, d.iso)} onfocus={() => (draft = d.iso)}
                    onpointerenter={() => (hover = d.iso)} onpointerleave={() => (hover = null)}>{d.day}</button>
          </div>
        {/each}
      </div>
    {/each}
  </div>
  <div class="foot">
    <span class="when"><b>{longDate(shown)}</b></span>
    <span class="rel {bandOf(shown, today)}">{tminus(shown, today)} · {relWords(shown, today)}</span>
    {#if away}
      <button type="button" class="today-btn" onclick={toToday}>today</button>
    {/if}
  </div>
</div>

<style>
  .nav{display:grid;grid-template-columns:44px minmax(0,1fr) 44px;align-items:center;height:44px;margin:2px 0 0}
  .nav b{text-align:center;font:var(--p-type-meta) var(--mono);font-weight:500;color:var(--ink);letter-spacing:.02em}
  .arrow{width:44px;height:44px;border:0;background:none;border-radius:50%;cursor:pointer;color:var(--ink-mid);
         display:grid;place-items:center;padding:0}
  .arrow svg{width:12px;height:12px;fill:none;stroke:currentColor;stroke-width:1.6}
  .arrow:hover{color:var(--ink);background:var(--panel)}
  .arrow:focus-visible{outline:none;color:var(--ink);box-shadow:inset 0 0 0 1.5px var(--accent)}
  .grid{display:grid;grid-template-columns:repeat(7,minmax(0,1fr));row-gap:2px;margin-top:4px}
  .row,.cell{display:contents}
  /* the weekday heads are tracked caps, so they may sit on the 12px floor */
  .dow{text-align:center;font:var(--p-type-caps) var(--mono);text-transform:uppercase;color:var(--ink-faint);
       letter-spacing:.08em;height:26px;line-height:26px}
  .day{aspect-ratio:1;min-height:44px;border:0;background:none;padding:0;margin:0;border-radius:50%;cursor:pointer;
       font:var(--p-type-meta) var(--mono);color:var(--ink);display:grid;place-items:center;
       transition:background .15s,color .15s}
  .day.past{color:var(--ink-mid)}
  .day.off{color:var(--ink-faint);opacity:.55}
  .day.today{box-shadow:inset 0 0 0 1px var(--ink-mid)}
  .day:hover{background:var(--panel);color:var(--ink);opacity:1}
  .day:focus-visible{outline:none;box-shadow:inset 0 0 0 1.5px var(--accent);color:var(--ink);opacity:1}
  .day.chosen,.day.chosen:hover{background:var(--accent-text);color:var(--bg);opacity:1;font-weight:600}
  .day.chosen.today{box-shadow:0 0 0 2px var(--bg),0 0 0 3px var(--accent-text)}
  .day.chosen:focus-visible{box-shadow:0 0 0 2px var(--bg),0 0 0 3.5px var(--accent-text)}
  /* the line under the grid, its T-minus in the corridor's band colour */
  .foot{display:flex;justify-content:space-between;align-items:center;gap:12px;min-height:30px;margin-top:8px;
        padding-top:10px;border-top:1px solid var(--line-soft);font:var(--p-type-meta) var(--mono);color:var(--ink-mid)}
  .foot b{font-weight:500;color:var(--ink)}
  .when{min-width:0}
  .rel{flex:none;margin-left:auto}
  .rel.over{color:var(--overdue-text)}
  .rel.soon{color:var(--warm-text)}
  .rel.up{color:var(--upcoming-text)}
  .rel.ok{color:var(--ok-text)}
  .today-btn{flex:none;height:30px;padding:0 10px;margin-right:-10px;border:0;border-radius:999px;background:none;cursor:pointer;
             font:var(--p-type-caps) var(--mono);letter-spacing:.12em;text-transform:uppercase;color:var(--ink-mid)}
  .today-btn:hover{color:var(--ink)}
  .today-btn:focus-visible{outline:none;color:var(--accent-text);box-shadow:inset 0 0 0 1.5px var(--accent)}
  @media (max-width:1199.98px){
    .day{min-height:46px}
  }
  @media (prefers-reduced-motion: reduce){
    .day{transition:none}
  }
</style>
