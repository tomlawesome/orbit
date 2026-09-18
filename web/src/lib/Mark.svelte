<script>
  import { MARKS } from "./marks.js";

  /**
   * One section mark (#867), drawn from the shared table (marks.js) so the
   * Sections card, the manifest and the dial's section legend never keep
   * their own copy of the figures. Every element below is a real Svelte
   * node built from the table's own numbers — no `{@html}`, no raw markup
   * travelling through this component.
   *
   * Renders as a plain span by default (manifest, dial legend — read only)
   * or as a real button (`tag="button"`) for the Sections card's swap
   * trigger and its tray's radio options, so the caller's own click and
   * keyboard handling lands on a real interactive element rather than a
   * div wearing a role.
   *
   * No JSDoc `@type` in this snippet's own parameter list: rolldown's build
   * mis-parses one there (the note in household/[id]/+page.svelte, bisected
   * for #624). The ternary defaults give every prop the type an annotation
   * would without one.
   */
  let {
    icon,
    accent = (true ? null : ""),
    size = 17,
    tag = (true ? "span" : "button"),
    class: klass = "mark",
    ...rest
  } = $props();
  const glyph = $derived(MARKS[icon] ?? MARKS.home);
</script>

<svelte:element
  this={tag}
  class={klass}
  style="--sec:var({accent ? `--sec-${accent}` : "--ink-faint"})"
  {...rest}
>
  <svg width={size} height={size} viewBox="0 0 16 16">
    {#each glyph.rects ?? [] as rect (rect.x + "," + rect.y)}
      <rect x={rect.x} y={rect.y} width={rect.width} height={rect.height} rx={rect.rx} />
    {/each}
    {#each glyph.paths ?? [] as path (path.d)}
      <path d={path.d} transform={path.transform}
            style={path.strokeWidth ? `stroke-width:${path.strokeWidth}` : undefined} />
    {/each}
    {#each glyph.nodes ?? [] as node (node.cx + "," + node.cy)}
      <circle cx={node.cx} cy={node.cy} r=".9" />
    {/each}
  </svg>
  <i></i>
</svelte:element>
