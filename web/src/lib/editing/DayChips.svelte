<script>
  import { addDays } from "./calendar.js";
  import { dayMonth } from "$lib/format.js";

  /**
   * THE REMINDER DAYS (#1468, round 6 Q): the chooser card's body for "how
   * many days before the date to remind". Day chips, 7 / 14 / 30 / 60 / 90,
   * any number at once; a press turns one on or off and the card stays. The
   * calendar's foot line says what is chosen ("14 d and 30 d before") and,
   * when the item has a date, the days they land on.
   *
   * A saved day that is not among the chips (the default 3) stays visible
   * and can be turned off: it stands after the chips as a chip of its own,
   * pressed, with a cross. It is outside the labelled group so the group is
   * the five the design draws; the row lays them out as one.
   *
   * @typedef {{
   *   days: number[],
   *   due: string | null,
   *   onpick: (value: string) => void,
   * }} Props
   */
  /** @type {Props} */
  let { days, due, onpick } = $props();

  const CHIPS = [7, 14, 30, 60, 90];
  const extra = $derived(days.filter((day) => !CHIPS.includes(day)).sort((a, b) => a - b));
  const chosen = $derived([...days].sort((a, b) => a - b));
  const words = $derived(
    chosen.length === 0 ? "no reminders"
      : `${chosen.length > 1 ? `${chosen.slice(0, -1).map((day) => `${day} d`).join(", ")} and ` : ""}${chosen[chosen.length - 1]} d before`);
  const lands = $derived(due && chosen.length
    ? chosen.map((day) => dayMonth(addDays(due, -day))).reverse().join(" · ")
    : "");
</script>

<div class="chips">
  <div class="set" role="group" aria-label="Remind me this many days before">
    {#each CHIPS as day, i (day)}
      <button type="button" class="chip" aria-pressed={days.includes(day)}
              tabindex={i === 0 ? 0 : undefined} onclick={() => onpick(String(day))}>{day}d</button>
    {/each}
  </div>
  {#each extra as day (day)}
    <button type="button" class="chip" data-extra aria-label={`${day}d, remove`} onclick={() => onpick(String(day))}>{day}d<span aria-hidden="true">&nbsp;×</span></button>
  {/each}
</div>
<div class="foot">
  <span class="when"><b>{words}</b></span>
  <span class="rel">{lands}</span>
</div>

<style>
  .chips{display:flex;flex-wrap:wrap;gap:8px;margin-top:12px}
  .set{display:contents}
  /* 44px targets, as the phone's chips */
  .chip{min-height:var(--p-hit);min-width:var(--p-hit);padding:0 14px;margin:0;border-radius:22px;cursor:pointer;
        border:1px solid var(--line);background:var(--panel);color:var(--ink-mid);font:var(--p-type-meta) var(--mono);
        transition:background .15s,border-color .15s,color .15s}
  .chip:hover{color:var(--ink);border-color:var(--line)}
  .chip:focus-visible{outline:none;border-color:var(--accent);box-shadow:inset 0 0 0 1px var(--accent)}
  .chip[aria-pressed=true],.chip[data-extra]{border-color:var(--accent);color:var(--ink);
        background:color-mix(in srgb,var(--accent) 16%,var(--panel))}
  /* the calendar's foot line */
  /* static: family.css, which some screens link, owns a fixed `.foot` (#1468) */
  .foot{position:static;text-align:left;letter-spacing:normal;z-index:auto;display:flex;flex-wrap:wrap;justify-content:space-between;align-items:center;gap:4px 12px;min-height:30px;margin-top:8px;
        padding-top:10px;border-top:1px solid var(--line-soft);font:var(--p-type-meta) var(--mono);color:var(--ink-mid)}
  .foot b{font-weight:500;color:var(--ink)}
  .when{min-width:0}
  .rel{flex:none}
  @media (prefers-reduced-motion: reduce){
    .chip{transition:none}
  }
</style>
