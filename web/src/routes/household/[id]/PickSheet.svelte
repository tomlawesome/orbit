<script>
  import Sheet from "$lib/pocket/Sheet.svelte";
  import PickList from "$lib/editing/PickList.svelte";

  /**
   * THE TIME-ZONE / CURRENCY SHEET (#1338): the phone's bottom sheet around
   * the shared pick list (PickList.svelte). The phone's household opens it
   * from its rows; the desk's household opens it under 1200px, and above that
   * stands the chooser card beside the field instead.
   * @typedef {{
   *   open?: boolean,
   *   kind: "timezone" | "currency",
   *   value: string,
   *   onchoose: (value: string) => void,
   * }} Props
   */
  /** @type {Props} */
  let { open = $bindable(false), kind, value, onchoose } = $props();
</script>

<Sheet bind:open size="list" title={kind === "currency" ? "Currency" : "Time zone"}>
  <!-- mounted only while open: a fresh filter each time -->
  {#if open}
    <PickList {kind} {value} onpick={(picked) => { open = false; onchoose(picked); }} />
  {/if}
</Sheet>
