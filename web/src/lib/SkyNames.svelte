<script>
  /*
   * Planet names on a dial (#1461): the labels and leaders skyLabelsOf placed,
   * drawn as core.js `render` draws them (design/v19/home-sun/round-6/src/core.js):
   * ink-mid text haloed in the ground colour, a hairline leader where the
   * placer gave one. Dial units throughout; `scale` is scene px per dial unit,
   * which turns the mock-up's 3px halo and 1px leader back into dial units.
   * Names are not interactive and are hidden from screen readers: every planet
   * already has its accessible name.
   */
  /** @type {{ names: { labels: { id: string, title: string, x: number, y: number, leader: { x1: number, y1: number, x2: number, y2: number } | null }[], font: number, scale: number } }} */
  let { names } = $props();
</script>

<g class="sky-names" aria-hidden="true">
  {#each names.labels as l (l.id)}
    {#if l.leader}
      <line x1={l.leader.x1} y1={l.leader.y1} x2={l.leader.x2} y2={l.leader.y2}
            stroke="var(--ink-faint)" stroke-width={1 / names.scale} stroke-opacity=".8"/>
    {/if}
    <text data-label={l.id} x={l.x} y={l.y} dy=".35em" text-anchor="middle" font-size={names.font}
          font-family="var(--ui)" fill="var(--ink-mid)" stroke="var(--bg)" stroke-width={3 / names.scale}
          paint-order="stroke" stroke-linejoin="round">{l.title}</text>
  {/each}
</g>

<style>
  .sky-names, .sky-names :global(*) { pointer-events: none; }
</style>
