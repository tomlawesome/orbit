<script>
  import { createArm, disarmOnElsewhere } from "./arm.js";

  /**
   * A dangerous act's pill (#1120, proposal §1.8): the first tap arms it and
   * does nothing else, the second fires `onfire`. Disarms after 4s, on
   * scroll, on any other tap, on Escape (arm.js).
   *
   * `label` is what the pill says ("remove"); `name` is its full accessible
   * name where the label alone would be ambiguous ("Remove Emma Lawson").
   * @type {{
   *   label: string,
   *   armedLabel?: string,
   *   name?: string,
   *   onfire: () => unknown,
   *   danger?: boolean,
   *   wide?: boolean,
   *   ms?: number,
   *   tabindex?: number,
   *   class?: string,
   * }}
   */
  let {
    label,
    armedLabel = `tap again to ${label.replace(/\s*→$/, "").toLowerCase()}`,
    name = undefined,
    onfire,
    danger = true,
    wide = false,
    ms = undefined,
    tabindex = undefined,
    class: extra = "",
  } = $props();

  let armed = $state(false);
  const arm = createArm({ ms: () => ms, onchange: (next) => (armed = next) });

  /** @type {HTMLButtonElement | undefined} */
  let button = $state();
  $effect(() => {
    if (!armed || !button) return;
    return disarmOnElsewhere(button, arm.disarm);
  });
  $effect(() => () => arm.disarm());

  const lower = (/** @type {string} */ text) => text.charAt(0).toLowerCase() + text.slice(1);
  const accessibleName = $derived(
    name === undefined ? undefined : armed ? `tap again to ${lower(name)}` : name,
  );

  function onclick() {
    if (arm.tap()) onfire();
  }
</script>

<button bind:this={button} class="p-pill arm {extra}" class:danger class:wide class:armed
        aria-label={accessibleName} {tabindex} {onclick}>
  <span class="rest" aria-hidden={armed}>{label}</span>
  <span class="set" aria-hidden={!armed}>{armedLabel}</span>
</button>

<style>
  /* The two words share one cell and crossfade (§1.9, 150ms), so the pill
     does not jump width when it arms: it is as wide as the longer one. */
  .arm{display:inline-grid;place-items:center}
  .arm.wide{display:grid}
  .arm span{grid-area:1/1;transition:opacity var(--p-arm) ease}
  .arm .set{opacity:0}
  .arm.armed .rest{opacity:0}
  .arm.armed .set{opacity:1}
  .arm.armed{border-color:var(--overdue)}
  @media (prefers-reduced-motion:reduce){ .arm span{transition:none} }
</style>
