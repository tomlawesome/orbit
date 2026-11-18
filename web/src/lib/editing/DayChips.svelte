<script>
  import { tick } from "svelte";
  import { addDays } from "./calendar.js";
  import { dayMonth } from "$lib/format.js";
  import { REMINDER_MAX, REMINDER_PRESETS, REMINDER_REFUSAL, reminderDayOf } from "./reminder-days.js";
  const uid = $props.id();

  /**
   * THE REMINDER DAYS (#1468, round 6 Q): the chooser card's body for "how
   * many days before the date to remind". One scale of day chips, 1 / 3 / 7 /
   * 14 / 30 / 60 / 90 and, as its last cell, a field to type any whole number
   * of days, 1 to 365 (#1892, design round-1 t-one-scale.html); any number
   * at once; a press turns one on or off and the card stays. The
   * calendar's foot line says what is chosen ("14 d and 30 d before") and,
   * when the item has a date, the days they land on.
   *
   * A saved or typed day that is no preset (21) stands in its place on the
   * scale, lit, with a cross: for it, off is removal. Typing a number that is
   * already a chip presses that chip (never a twin); already on, the chip
   * nudges and the line says so. One line under the grid carries, in turn,
   * the add, the refusal, "already chosen" and, at the cap of 8, why no more.
   *
   * @typedef {{
   *   days: number[],
   *   due: string | null,
   *   onpick: (value: string) => void,
   * }} Props
   */
  /** @type {Props} */
  let { days, due, onpick } = $props();

  const extra = $derived(days.filter((day) => !REMINDER_PRESETS.includes(day)));
  const scale = $derived([...new Set([...REMINDER_PRESETS, ...extra])].sort((a, b) => a - b));
  /* the cap (#1892): at REMINDER_MAX the off chips and the field are disabled;
     a saved item over it is never trimmed, only told how many must go */
  const capped = $derived(days.length >= REMINDER_MAX);
  const over = $derived(days.length - REMINDER_MAX);
  /** @type {HTMLInputElement | undefined} */
  let input = $state();
  let typed = $state("");
  /** @type {"none" | "add" | "refused" | "already"} */
  let voice = $state("none");
  let said = $state(0);
  /** @type {number | null} */
  let nudged = $state(null);
  /** @param {string} text */
  function typing(text) {
    typed = text;
    nudged = null;
    voice = text === "" ? "none" : reminderDayOf(text) === null ? "refused" : "add";
  }
  /* the chips that can take focus: a chip that is off at the cap is disabled */
  const enabled = (/** @type {number} */ day) => !capped || days.includes(day);
  const firstEnabled = $derived(scale.find(enabled));
  /** @type {HTMLElement | undefined} */
  let grid = $state();
  /* once the parent has repainted: focus the chip for `day`, or the field, or
     (when the field is disabled by the cap) the first chip still enabled */
  /** @param {number | null} day */
  async function refocus(day) {
    await tick();
    /** @type {HTMLElement | null | undefined} */
    const target = input && !input.disabled ? input
      : (day === null ? null : grid?.querySelector(`[data-day="${day}"]:not(:disabled)`)) ?? grid?.querySelector("button:not(:disabled)");
    target?.focus({ preventScroll: true });
  }
  /* reaching the cap closes the field: what was typed and the line it earned go with it */
  $effect(() => {
    if (capped) { typed = ""; voice = "none"; nudged = null; }
  });
  function commit() {
    const day = reminderDayOf(typed);
    if (day === null) { voice = "refused"; return; }
    typed = "";
    said = day;
    input?.focus({ preventScroll: true }); // the add button may be about to leave
    if (days.includes(day)) { voice = "already"; nudged = day; return; }
    voice = "none";
    nudged = null;
    onpick(String(day));
    refocus(day); // the field, or, if that added the eighth, the chip just added
  }
  /** @param {number} day */
  function press(day) {
    nudged = null;
    if (voice === "already") voice = "none";
    onpick(String(day));
    // a typed day's chip leaves with its removal: focus goes to the field, or
    // to a chip still enabled when the cap has closed the field, never the page
    if (!REMINDER_PRESETS.includes(day)) refocus(null);
  }
  const chosen = $derived([...days].sort((a, b) => a - b));
  const words = $derived(
    chosen.length === 0 ? "no reminders"
      : `${chosen.length > 1 ? `${chosen.slice(0, -1).map((day) => `${day} d`).join(", ")} and ` : ""}${chosen[chosen.length - 1]} d before`);
  const lands = $derived(due && chosen.length
    ? chosen.map((day) => dayMonth(addDays(due, -day))).reverse().join(" · ")
    : "");
</script>

<div class="grid" bind:this={grid} role="group" aria-label="Remind me this many days before">
  {#each scale as day (day)}
    {#if REMINDER_PRESETS.includes(day)}
      <button type="button" class="chip" class:nudge={nudged === day} aria-pressed={days.includes(day)} disabled={!enabled(day)} data-day={day}
              tabindex={day === firstEnabled ? 0 : undefined} onclick={() => press(day)}>{day}d</button>
    {:else}
      <button type="button" class="chip" class:nudge={nudged === day} data-extra data-day={day} aria-label={`${day}d, remove`}
              tabindex={day === firstEnabled ? 0 : undefined}
              onclick={() => press(day)}>{day}d<span class="x" aria-hidden="true">×</span></button>
    {/if}
  {/each}
  <div class="own" class:off={capped} class:has={typed !== ""} class:bad={voice === "refused"}>
    <input bind:this={input} type="text" inputmode="numeric" maxlength="3" disabled={capped} autocomplete="off" placeholder="other"
           aria-label="Another number of days before" aria-invalid={voice === "refused" ? "true" : undefined}
           aria-describedby={voice === "refused" ? `${uid}-refusal` : undefined}
           value={typed} oninput={(event) => typing(event.currentTarget.value)}
           onkeydown={(event) => { if (event.key === "Enter") { event.preventDefault(); commit(); } }}>
    <span class="unit" aria-hidden="true">d</span>
  </div>
</div>
<div class="line" class:warm={voice === "refused" || over > 0} aria-live="polite">
  {#if over > 0}
    <span class="in">{REMINDER_MAX} at most · turn {over} off to save</span>
  {:else if capped}
    <span class="in">{REMINDER_MAX} at most · turn one off to add more</span>
  {:else if voice === "add"}
    <button type="button" class="add" onclick={commit}>add {reminderDayOf(typed)} d <span class="kb">↵</span></button>
  {:else if voice === "refused"}
    <span class="in" id="{uid}-refusal">{REMINDER_REFUSAL}</span>
  {:else if voice === "already"}
    <span class="in">{said} d is already chosen</span>
  {/if}
</div>
<div class="foot">
  <span class="when"><b>{words}</b></span>
  <span class="rel">{lands}</span>
</div>

<style>
  /* the grid: four equal 44px cells (320px inside the card holds four at the floor) */
  .grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px;margin-top:12px}
  .chip{display:inline-flex;align-items:center;justify-content:center;gap:2px;min-height:var(--p-hit);min-width:0;padding:0 8px;margin:0;border-radius:22px;cursor:pointer;
        border:1px solid var(--line);background:var(--panel);color:var(--ink-mid);font:var(--p-type-meta) var(--mono);
        transition:background .15s,border-color .15s,color .15s}
  .chip:hover{color:var(--ink);border-color:var(--line)}
  .chip:focus-visible{outline:none;border-color:var(--accent);box-shadow:inset 0 0 0 1px var(--accent)}
  .chip[aria-pressed=true],.chip[data-extra]{border-color:var(--accent);color:var(--ink);
        background:color-mix(in srgb,var(--accent) 16%,var(--panel))}
  /* a typed day is lit and carries its cross: turning it off is removing it */
  .chip .x{color:var(--ink-quiet);margin-left:4px}
  .chip.nudge{animation:nudge .4s ease both}
  @keyframes nudge{30%{transform:translateX(-3px)}60%{transform:translateX(3px)}}
  /* the field: the kit's input in chip clothes, dashed as every "add your own" target is */
  .own{position:relative;display:flex;align-items:center;min-height:var(--p-hit);border-radius:22px;
       border:1.5px dashed color-mix(in srgb,var(--accent) 45%,var(--line-soft));transition:border-color .15s}
  .own:focus-within{border-color:var(--accent);border-style:solid}
  .own.bad{border-color:color-mix(in srgb,var(--warm) 70%,var(--line))}
  .own input{width:100%;min-width:0;height:100%;min-height:var(--p-hit);padding:0 8px;border:0;background:none;color:var(--ink);text-align:center;
       font:var(--p-type-meta) var(--mono);outline:none;-moz-appearance:textfield;appearance:textfield}
  .own input::-webkit-outer-spin-button,.own input::-webkit-inner-spin-button{-webkit-appearance:none;margin:0}
  .own input::placeholder{color:var(--ink-quiet)}
  .own .unit{position:absolute;right:11px;top:50%;transform:translateY(-50%);font:var(--p-type-meta) var(--mono);color:var(--ink-quiet);pointer-events:none;display:none}
  .own.has .unit{display:block}
  .own.has input{padding-right:22px}
  .chip:disabled,.own.off{opacity:.45;cursor:default}
  .chip:disabled:hover{color:var(--ink-mid)}
  /* one line, four voices in turn; it keeps its height so the card never jumps */
  .line{display:flex;align-items:center;min-height:24px;margin-top:4px;font:var(--p-type-meta) var(--mono);color:var(--ink-quiet);letter-spacing:.02em}
  .line .add{appearance:none;display:inline-flex;align-items:center;min-height:var(--p-hit);padding:0 10px;margin:calc((24px - var(--p-hit)) / 2) 0 calc((24px - var(--p-hit)) / 2) -10px;border:0;border-radius:15px;background:none;
        cursor:pointer;font:var(--p-type-meta) var(--mono);color:var(--accent)}
  .line .add:hover{background:color-mix(in srgb,var(--accent) 10%,transparent)}
  .line .add .kb{color:var(--ink-quiet);margin-left:8px}
  .line.warm{color:var(--warm-text)}
  .line .in{animation:errin .35s ease both}
  @keyframes errin{from{opacity:0;transform:translateY(-3px)}}
  /* the calendar's foot line */
  /* static: family.css, which some screens link, owns a fixed `.foot` (#1468) */
  .foot{position:static;text-align:left;letter-spacing:normal;z-index:auto;display:flex;flex-wrap:wrap;justify-content:space-between;align-items:center;gap:4px 12px;min-height:30px;margin-top:8px;
        padding-top:10px;border-top:1px solid var(--line-soft);font:var(--p-type-meta) var(--mono);color:var(--ink-mid)}
  .foot b{font-weight:500;color:var(--ink)}
  .when{min-width:0}
  .rel{flex:none}
  /* the phone, wherever the card stands (the sheet or inline): the field at the
     pocket's 16px floor so it never zooms, and no Enter hint on a number pad */
  @media (max-width: 839.98px), (max-height: 479.98px){
    .own input{font-size:var(--p-type-input)}
    /* the 44px tap floor: the slot, and the add that fills it (all voices share it, so nothing jumps) */
    .line{min-height:44px;margin-top:0}
    .line .add{min-height:44px}
    .line .add .kb{display:none}
  }
  @media (prefers-reduced-motion: reduce){
    .chip,.line .in{transition:none;animation:none}
  }
</style>
