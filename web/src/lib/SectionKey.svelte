<script>
  /*
   * The key under the sky (#1466, round 6 M, m-colour-by-mark.html `.key`):
   * one dot and name for each colour a visible section wears, in the four
   * colours' order, each named for the first visible section (by position)
   * that wears it (chart.js `sectionKeyOf`). The desk centres it near the
   * sky's foot; the phone sets it under the sky, wrapping.
   */
  import { sectionKeyOf } from "$lib/data/chart.js";

  /** @type {{ sections: any[] | null | undefined, layout?: "desk" | "pocket" }} */
  let { sections, layout = "desk" } = $props();
  const entries = $derived(sectionKeyOf(sections));
</script>

{#if entries.length}
  <div class="key" class:pocket={layout === "pocket"} aria-label="Section colours" role="group">{#each entries as one (one.colour)}<span><i style="background:var(--c-{one.colour})"></i>{one.name}</span>{/each}</div>
{/if}

<style>
  /* M's rules, in rem so the text-size step reaches them; M's --ink-2 is the app's --ink-mid. */
  .key{position:absolute;left:50%;bottom:34px;transform:translateX(-50%);display:flex;gap:22px;font:0.71875rem var(--mono);color:var(--ink-mid);white-space:nowrap}
  .key i{display:inline-block;width:9px;height:9px;border-radius:50%;margin-right:7px;vertical-align:-1px}
  .key.pocket{font-size:0.75rem;position:static;transform:none;flex-wrap:wrap;white-space:normal;gap:8px 18px;margin-top:14px}
</style>
