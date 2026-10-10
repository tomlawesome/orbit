<script>
  import Sheet from "$lib/pocket/Sheet.svelte";
  import { currencyOptions, zoneLabel, zoneOptions } from "$lib/pick-lists.js";

  /**
   * THE TIME-ZONE / CURRENCY PICKER (#1338): the phone's list sheet, with its
   * filter, now shared by the desk's household screen and the phone's. The
   * list is the shared pick-lists' own: every zone or currency the runtime
   * knows, the six favourites first. A stored value that is not among them
   * stays at the head rather than vanishing, so opening the picker never
   * re-points what is stored.
   * @typedef {{
   *   open?: boolean,
   *   kind: "timezone" | "currency",
   *   value: string,
   *   onchoose: (value: string) => void,
   * }} Props
   */
  /** @type {Props} */
  let { open = $bindable(false), kind, value, onchoose } = $props();

  let query = $state("");
  const currency = $derived(kind === "currency");
  const all = $derived.by(() => {
    if (!open) return [];
    const list = currency ? currencyOptions() : zoneOptions();
    return list.some((row) => row.value === value)
      ? list
      : [{ value, label: currency ? value : zoneLabel(value) }, ...list];
  });
  const shown = $derived.by(() => {
    const needle = query.trim().toLowerCase();
    return needle ? all.filter((row) => row.label.toLowerCase().includes(needle)) : all;
  });
  /* a fresh filter each time the sheet opens */
  $effect(() => { if (open) query = ""; });
</script>

<Sheet bind:open size="list" title={currency ? "Currency" : "Time zone"}>
  <input class="pick-filter" type="search" enterkeyhint="search"
         aria-label={currency ? "Find a currency" : "Find a time zone"}
         placeholder={currency ? "find a currency" : "find a city or region"} bind:value={query}>
  <div class="pick-options" role="listbox" aria-label={currency ? "Currencies" : "Time zones"}>
    {#each shown as row (row.value)}
      <button class="pick-option" role="option" aria-selected={value === row.value}
              onclick={() => { open = false; onchoose(row.value); }}>{row.label}</button>
    {:else}
      <p class="p-empty pick-inset">nothing matches “{query.trim()}”</p>
    {/each}
  </div>
</Sheet>

<style>
  .pick-filter{box-sizing:border-box;width:100%;min-height:48px;margin:4px 0 8px;padding:0 14px;border-radius:12px;
    border:1px solid var(--line);background:color-mix(in srgb, var(--bg) 55%, transparent);color:var(--ink);
    font:var(--p-type-body)/1.2 var(--ui)}
  .pick-filter:focus{outline:2px solid var(--accent);outline-offset:1px;border-color:transparent}
  .pick-filter::placeholder{color:var(--ink-quiet)}
  .pick-options{display:flex;flex-direction:column}
  .pick-option{appearance:none;min-height:var(--p-row-min);padding:0 4px;border:0;border-bottom:1px solid var(--line-soft);
    background:none;text-align:left;font:var(--p-type-body)/1.3 var(--ui);color:var(--ink);cursor:pointer}
  .pick-option[aria-selected=true]{color:var(--accent-text);font-weight:600}
  .pick-option:active{background:var(--panel-raised)}
  .pick-option:focus-visible{outline:2px solid var(--accent);outline-offset:-2px}
  .pick-inset{margin-left:var(--p-gutter);margin-right:var(--p-gutter)}
</style>
