<script>
  import { resolve } from "$app/paths";
  import NorthStarMark from "$lib/NorthStarMark.svelte";

  /**
   * THE NORTH STAR, POCKET FORM (#1120, proposal §1.2, §2.1; owner approved
   * 2026-09-25 as a trial). The desk's create handle as a fixed body at the
   * bottom right, in thumb reach, drawn with the desk's own mark. The one
   * floating control in the app, and it appears only on home: step 2 places
   * it there. It is a link to /create, so it works without script.
   * @typedef {{ label?: string }} Props
   */
  /** @type {Props} */
  let { label = "Add an item" } = $props();
</script>

<a class="p-northstar" href={resolve("/create")} aria-label={label} title={label}>
  <NorthStarMark size={30} />
</a>

<style>
  .p-northstar{position:fixed;z-index:15;
    right:calc(var(--p-gutter) + env(safe-area-inset-right));
    bottom:calc(20px + env(safe-area-inset-bottom));
    box-sizing:border-box;width:56px;height:56px;border-radius:50%;display:grid;place-items:center;
    background:var(--panel-raised);border:1px solid var(--line);
    box-shadow:0 6px 20px rgb(0 0 0 / .3), 0 0 0 1px var(--line),
      0 0 24px -6px color-mix(in srgb, var(--accent) 40%, transparent);
    -webkit-tap-highlight-color:transparent}
  /* The halo (§5.2): the accent's soft light on the dark packs only; no
     blur, since this sits fixed over scrolling content (§5.3). */
  :global(:is([data-theme=dawn],[data-theme=clouds])) .p-northstar{
    box-shadow:0 6px 20px rgb(0 0 0 / .3), 0 0 0 1px var(--line)}
  :global([data-theme=retrograde]) .p-northstar :global(.glint){filter:drop-shadow(0 0 2.5px var(--bloom))}
  .p-northstar:active{background:var(--panel)}
  .p-northstar:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
  /* The desk's pulse, slowed to the pocket's drift. */
  .p-northstar :global(.glint){animation:p-north 5.5s ease-in-out infinite;transform-origin:0 0}
  @keyframes p-north{0%,100%{opacity:.8;transform:scale(1)}50%{opacity:1;transform:scale(1.12)}}
  @media (prefers-reduced-motion:reduce){ .p-northstar :global(.glint){animation:none} }
</style>
