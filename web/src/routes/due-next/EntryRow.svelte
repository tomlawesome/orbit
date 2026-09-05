<script>
  /*
   * One corridor row (#461), split out of +page.svelte so `row` can carry a
   * real prop type (#624/#782): the identical `{#snippet entry(row)}` inline
   * in +page.svelte's template has nowhere to put the annotation — a
   * `{#snippet}` parameter is one of the positions where svelte-check accepts
   * an inline `@type` cast but the production rolldown build does not. A
   * component's `$props()` destructuring is a plain `<script>` statement, so
   * it takes the same annotation the rest of this file already relies on.
   */
  import { resolve } from "$app/paths";
  import { money } from "$lib/format.js";
  import { BAND_VAR, T_CLASS } from "./bands.js";

  /** @type {{ row: import('$lib/data/chart.js').CorridorRow }} */
  let { row } = $props();

  /* $derived, not const: a prop read at the top level of a component's
     script is captured once, so a row reused for a different entry would
     keep the first entry's label and meta. */
  const tlabel = $derived(row.days < 0 ? `T+${-row.days}d` : `T−${row.days}d`);
  /* Due next never passes corridorOf() any suggestions (that's home's job),
     so a due-next row's own dueDate/household are never actually null --
     but the shared CorridorRow type allows for the suggestion shape too, so
     this stays honest rather than asserting it away. */
  /** @param {string | null} iso */
  const short = (iso) =>
    iso
      ? new Date(iso + "T00:00:00Z").toLocaleDateString("en-GB", { day: "2-digit", month: "short", timeZone: "UTC" })
      : "";
  const meta = $derived(
    [row.section, row.provider, row.costMinor ? money(row.costMinor, row.currency, row.costIsEstimate) : null].filter(
      Boolean,
    ),
  );
</script>

<a class="item" href={resolve("/item/[id]", { id: row.id })}>
  <span class="planet" class:ter={row.kind === "inspection"} class:con={row.kind === "renewal"}
        style="color:var({BAND_VAR[row.band]})"><i></i></span>
  <div class="body"><b>{row.title}</b><span><span class="sys" class:away={row.away}
    >{(row.household ?? "").toUpperCase()}</span>{meta.length ? ` · ${meta.join(" · ")}` : ""}</span></div>
  <div class="t {T_CLASS[row.band]}">{tlabel}<small>{short(row.dueDate)}</small></div>
</a>
