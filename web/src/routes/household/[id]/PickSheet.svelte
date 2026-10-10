<script>
  import Sheet from "$lib/pocket/Sheet.svelte";
  import PickList from "$lib/editing/PickList.svelte";
  import Tiles from "$lib/editing/Tiles.svelte";

  /**
   * THE PICK SHEET (#1338, #1332): the phone's bottom sheet around a shared
   * chooser body. The phone's household opens it from its rows; the desk's
   * household opens it under 1200px, and above that stands the chooser card
   * beside the field (or under the section's row) instead.
   *
   *   · "timezone", "currency": the shared pick list (PickList.svelte);
   *   · "section": the tiles of "where do these entries go?" (Tiles.svelte,
   *     the chooser card's own body), one per `choices`, titled `heading`.
   *     Picking a tile chooses; closing any other way calls `oncancel`.
   * @typedef {{
   *   open?: boolean,
   *   kind: "timezone" | "currency" | "section",
   *   value: string | null,
   *   onchoose: (value: string) => void,
   *   choices?: import('$lib/editing/item-draft.js').Choice[],
   *   heading?: string,
   *   oncancel?: () => void,
   * }} Props
   */
  /** @type {Props} */
  let { open = $bindable(false), kind, value, onchoose, choices = [], heading = "", oncancel = undefined } = $props();

  let picked = false;
  /** @param {string} chosen */
  function pick(chosen) {
    picked = true;
    open = false;
    onchoose(chosen);
  }
  function closed() {
    const chose = picked;
    picked = false;
    if (!chose) oncancel?.();
  }
  const title = $derived(kind === "section" ? `Choose ${heading}` : kind === "currency" ? "Currency" : "Time zone");
</script>

<Sheet bind:open size={kind === "section" ? "callout" : "list"} {title} onclose={closed}>
  <!-- mounted only while open: a fresh filter each time -->
  {#if open}
    {#if kind === "section"}
      <Tiles {choices} {value} label="sections" cols={2} onpick={pick} />
    {:else}
      <PickList {kind} value={value ?? ""} onpick={pick} />
    {/if}
  {/if}
</Sheet>
