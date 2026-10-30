<script>
  /**
   * The "Focusing on the anomaly" reticle (#1356, web-23): create-v3's focus
   * block, drawn on the desk's create reading lane, the phone's create form
   * and the document preview card. The path data is the ratified one; it
   * lives here once.
   *
   * It carries no styles. Each caller sizes and animates it through its own
   * class (`.sweep` turns, `.pull` breathes), so the size, spacing and
   * reduced-motion rules stay with the surface that owns them.
   */
  /** @type {{ class?: string }} */
  let { class: className = "reticle" } = $props();
</script>

<svg class={className} viewBox="0 0 96 96" aria-hidden="true">
  <circle cx="48" cy="48" r="43" fill="none" stroke="var(--chart-line)" stroke-width="1"
          stroke-dasharray="3 7" opacity=".8"/>
  <g class="sweep">
    <line x1="48" y1="5" x2="48" y2="14" stroke="var(--accent)" stroke-width="1.2" opacity=".8"/>
    <line x1="48" y1="82" x2="48" y2="91" stroke="var(--accent)" stroke-width="1.2" opacity=".35"/>
  </g>
  <g class="pull" fill="none" stroke="var(--accent)" stroke-width="1.1" opacity=".7">
    <path d="M 26 18 H 18 V 26"/><path d="M 70 18 H 78 V 26"/>
    <path d="M 26 78 H 18 V 70"/><path d="M 70 78 H 78 V 70"/>
  </g>
  <circle cx="48" cy="48" r="16" fill="none" stroke="var(--chart-line)" stroke-width="1" opacity=".9"/>
  <circle cx="48" cy="48" r="1.8" fill="var(--accent)"/>
</svg>
