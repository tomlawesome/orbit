<script>
  import { onMount } from "svelte";

  /**
   * POL-13's film grain, once (#445). Four screens carried this block inline
   * and had already drifted (slope 0.08 vs 0.09), so the slope is a prop that
   * preserves each screen's ratified value.
   *
   * Per-theme hooks (owner, 2026-08-15: grain colour and size must be able to
   * differ per pack): SVG filter attributes cannot read CSS custom properties,
   * so on mount the component syncs --grain-freq (size) and --grain-slope
   * (intensity) from the resolved pack if they are set. Unset, everything
   * renders exactly as before. Opacity and blend are pure CSS and live on the
   * shared .grain rule (--grain-opacity, --grain-blend). Colour needs a
   * ratified per-pack value before it gets a hook — recorded on #445.
   */
  let { slope = 0.08 } = $props();
  let host;

  onMount(() => {
    const style = getComputedStyle(host);
    const freq = style.getPropertyValue("--grain-freq").trim();
    const packSlope = style.getPropertyValue("--grain-slope").trim();
    if (freq) host.querySelector("feTurbulence").setAttribute("baseFrequency", freq);
    if (packSlope) host.querySelector("feFuncA").setAttribute("slope", packSlope);
  });
</script>

<svg class="grain" width="100%" height="100%" aria-hidden="true" bind:this={host}><filter id="gr">
  <feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2" stitchTiles="stitch"/>
  <feColorMatrix type="saturate" values="0"/>
  <feComponentTransfer><feFuncA type="linear" slope={slope}/></feComponentTransfer>
  <feComposite operator="in" in2="SourceGraphic"/>
</filter><rect width="100%" height="100%" filter="url(#gr)"/></svg>
