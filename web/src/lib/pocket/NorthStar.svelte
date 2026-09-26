<script>
  import { untrack } from "svelte";
  import { resolve } from "$app/paths";
  import NorthStarMark from "$lib/NorthStarMark.svelte";

  /**
   * THE NORTH STAR, POCKET FORM (#1120, proposal §1.2, §2.1; round 3 §5,
   * owner's answer 11a). The desk's create handle, drawn with the desk's own
   * mark, a link to /create so it works without script. Two stations, one
   * element:
   *
   *   rest    in flow, in the bottom-right corner of `anchor` (home's dial
   *           square), where it covers nothing; it scrolls off with the dial
   *   afloat  fixed at the bottom right, in thumb reach, from the moment the
   *           anchor's bottom edge has scrolled above the top chrome; it
   *           fades up in 200ms and leaves in 150ms (reduced motion: it
   *           appears and goes)
   *
   * `docked` says it has a rest station, so it is drawn there from the
   * first paint; `anchor` is the element whose corner that is, once bound.
   * Undocked it is afloat throughout (the kit's page). `hidden`
   * puts it away (home: while a sheet is up or a row is open); the film
   * hides it by CSS (home's pocket.css). `data-northstar` on <body> says the
   * star is afloat and showing, so the wake rises above it (review round
   * §1.3); at rest it is in the sky, clear of the wake.
   * @typedef {{ label?: string, docked?: boolean, anchor?: HTMLElement | null, hidden?: boolean }} Props
   */
  /** @type {Props} */
  let { label = "Add an item", docked = false, anchor = null, hidden = false } = $props();

  /** @type {"rest" | "afloat" | "leaving"} */
  let station = $state(untrack(() => (docked ? "rest" : "afloat")));

  $effect(() => {
    if (!anchor) return;
    const el = anchor;
    const still = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
    let frame = 0;
    /** @type {ReturnType<typeof setTimeout> | undefined} */
    let leaving;
    const place = () => {
      frame = 0;
      const chrome = /** @type {HTMLElement | null} */ (document.querySelector(".p-chrome"))?.offsetHeight ?? 56;
      const dialBottom = el.getBoundingClientRect().bottom + scrollY;
      const afloat = scrollY > dialBottom - chrome;
      if (afloat && station !== "afloat") {
        clearTimeout(leaving);
        station = "afloat";
      } else if (!afloat && station === "afloat") {
        if (still()) { station = "rest"; return; }
        station = "leaving";
        leaving = setTimeout(() => { if (station === "leaving") station = "rest"; }, 150);
      }
    };
    const onScroll = () => { if (!frame) frame = requestAnimationFrame(place); };
    untrack(place);
    addEventListener("scroll", onScroll, { passive: true });
    addEventListener("resize", onScroll, { passive: true });
    return () => {
      removeEventListener("scroll", onScroll);
      removeEventListener("resize", onScroll);
      cancelAnimationFrame(frame);
      clearTimeout(leaving);
    };
  });

  $effect(() => {
    if (station !== "afloat" || hidden) return;
    document.body.dataset.northstar = "";
    return () => { delete document.body.dataset.northstar; };
  });
</script>

<a class="p-northstar {station}" class:hidden href={resolve("/create")} aria-label={label} title={label}
   data-station={station}>
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
  /* At rest: in the anchor's bottom-right corner, right edge at the gutter,
     bottom edge on the dial's (round 3 §5). */
  .p-northstar.rest{position:absolute;right:0;bottom:0;z-index:3}
  .p-northstar.afloat{animation:p-north-in 200ms var(--p-ease) both}
  .p-northstar.leaving{animation:p-north-out 150ms var(--p-ease) both;pointer-events:none}
  .p-northstar.hidden{display:none}
  @keyframes p-north-in{from{opacity:0;transform:translateY(8px)}}
  @keyframes p-north-out{to{opacity:0;transform:translateY(8px)}}
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
  @media (prefers-reduced-motion:reduce){
    .p-northstar.afloat,.p-northstar.leaving,.p-northstar :global(.glint){animation:none}
  }
</style>
