<script>
  import { currencyOptions, zoneLabel, zoneOptions } from "$lib/pick-lists.js";

  /**
   * THE PICK LIST (#1338): the time-zone / currency chooser's body, a filter
   * box over a listbox. The desk's chooser card wears it beside the pressed
   * field and the phone's bottom sheet wears it too (PickSheet.svelte), so
   * the two cannot drift. The list is the shared pick-lists' own: every zone
   * or currency the runtime knows, the six favourites first. A stored value
   * that is not among them stays at the head rather than vanishing, so
   * opening the picker never re-points what is stored.
   *
   * Keys: in the filter box, Down moves to the first option and Enter picks
   * the first one shown; on an option, Down and Up walk the options (Up from
   * the first returns to the filter box), Home and End the ends, Enter or a
   * press picks it. One option is in the tab order at a time (roving
   * tabindex); the filter box is `tabindex="0"` so the chooser card's focus
   * lands on it. Escape is not handled here: it bubbles to the card or sheet.
   *
   * A fresh list has a fresh filter: the owner mounts it when it opens.
   * @typedef {{
   *   kind: "timezone" | "currency",
   *   value: string,
   *   onpick: (value: string) => void,
   * }} Props
   */
  /** @type {Props} */
  let { kind, value, onpick } = $props();

  let query = $state("");
  /** The option in the tab order. */
  let active = $state(0);
  /** @type {HTMLInputElement | undefined} */
  let filter = $state();
  /** @type {HTMLDivElement | undefined} */
  let list = $state();

  const currency = $derived(kind === "currency");
  const all = $derived.by(() => {
    const rows = currency ? currencyOptions() : zoneOptions();
    return rows.some((row) => row.value === value)
      ? rows
      : [{ value, label: currency ? value : zoneLabel(value) }, ...rows];
  });
  const shown = $derived.by(() => {
    const needle = query.trim().toLowerCase();
    return needle ? all.filter((row) => row.label.toLowerCase().includes(needle)) : all;
  });
  /* the tab stop stays on a row that is still shown */
  const stop = $derived(Math.min(active, Math.max(0, shown.length - 1)));

  /** @param {number} index */
  function focusOption(index) {
    active = index;
    /** @type {HTMLElement | undefined} */ (list?.querySelectorAll("[role=option]")[index])?.focus({ preventScroll: false });
  }

  /** @param {KeyboardEvent} event */
  function fromFilter(event) {
    if (event.key === "ArrowDown" && shown.length) {
      event.preventDefault();
      focusOption(0);
    } else if (event.key === "Enter") {
      event.preventDefault();
      if (shown.length) onpick(shown[0].value);
    }
  }

  /** @param {KeyboardEvent} event @param {number} i */
  function fromOption(event, i) {
    const last = shown.length - 1;
    if (event.key === "ArrowDown") { event.preventDefault(); focusOption(Math.min(i + 1, last)); }
    else if (event.key === "ArrowUp") {
      event.preventDefault();
      if (i === 0) filter?.focus(); else focusOption(i - 1);
    } else if (event.key === "Home") { event.preventDefault(); focusOption(0); }
    else if (event.key === "End") { event.preventDefault(); focusOption(last); }
  }
</script>

<input class="pick-filter" type="search" tabindex="0" enterkeyhint="search" autocomplete="off"
       aria-label={currency ? "Find a currency" : "Find a time zone"}
       placeholder={currency ? "find a currency" : "find a city or region"}
       bind:value={query} bind:this={filter} onkeydown={fromFilter}>
<div class="pick-options" role="listbox" aria-label={currency ? "Currencies" : "Time zones"} bind:this={list}>
  {#each shown as row, i (row.value)}
    <button type="button" class="pick-option" role="option" aria-selected={value === row.value}
            tabindex={i === stop ? 0 : -1} onfocus={() => (active = i)}
            onkeydown={(event) => fromOption(event, i)} onclick={() => onpick(row.value)}>{row.label}</button>
  {:else}
    <p class="p-empty pick-inset">nothing matches “{query.trim()}”</p>
  {/each}
</div>

<style>
  /* doubled class: the desk's `.household-page .field input` would otherwise
     win where the card stands inside a field */
  .pick-filter.pick-filter{box-sizing:border-box;width:100%;min-height:48px;margin:4px 0 8px;padding:0 14px;border-radius:12px;
    border:1px solid var(--line);background:color-mix(in srgb, var(--bg) 55%, transparent);color:var(--ink);
    font:var(--p-type-body)/1.2 var(--ui)}
  .pick-filter:focus{outline:2px solid var(--accent);outline-offset:1px;border-color:transparent}
  .pick-filter::placeholder{color:var(--ink-quiet)}
  .pick-options{display:flex;flex-direction:column}
  .pick-option{appearance:none;min-height:var(--p-row-min);padding:0 4px;border:0;border-bottom:1px solid var(--line-soft);
    background:none;text-align:left;font:var(--p-type-body)/1.3 var(--ui);color:var(--ink);cursor:pointer}
  .pick-option[aria-selected=true]{color:var(--accent-text);font-weight:600}
  .pick-option:hover{background:var(--panel-raised)}
  .pick-option:active{background:var(--panel-raised)}
  .pick-option:focus-visible{outline:2px solid var(--accent);outline-offset:-2px}
  .pick-inset{margin-left:var(--p-gutter);margin-right:var(--p-gutter)}
</style>
