<script>
  import { beforeNavigate, goto, pushState } from "$app/navigation";
  import { page } from "$app/state";
  import { sheetRelease } from "./gesture.js";
  import { portal } from "./portal.js";
  import { holdSheet, standOnKeyboard } from "./sheet.js";
  /* First, with no comment of its own: Svelte hoists $props.id() and would
     carry a leading doc comment into the compiled declaration (#1120). */
  const uid = $props.id();

  /**
   * THE SHEET (#1120, proposal §1.4): one component, three sizes, used
   * wherever the desk has a callout, drawer, panel or dialog.
   *
   *   callout  content height, at most 45% of the screen
   *   list     60% of the screen; dragging the handle up grows it to full
   *   full     the whole screen under the top safe area
   *
   * It is a real dialog (sheet.js): focus in on open and back to the opener
   * on close, Tab held inside, the page behind inert. Every dismiss always
   * exists: drag the handle or the sheet down, tap the scrim, the `close`
   * word, Escape, and the OS back gesture, because opening pushes a history
   * entry that back pops. It stands on the on-screen keyboard.
   *
   * `open` is bindable; the sheet sets it false itself on any dismiss and
   * then calls `onclose`. One sheet at a time is the caller's rule: a sheet
   * that needs another grows rather than stacking.
   * @typedef {{
   *   open?: boolean,
   *   size?: "callout" | "list" | "full",
   *   title: string,
   *   hideTitle?: boolean,
   *   onclose?: () => void,
   *   history?: boolean,
   *   children?: import('svelte').Snippet,
   *   head?: import('svelte').Snippet,
   * }} Props
   */
  /** @type {Props} */
  let {
    open = $bindable(false),
    size = "callout",
    title,
    hideTitle = false,
    onclose = undefined,
    history = true,
    children = undefined,
    head = undefined,
  } = $props();

  /** @type {HTMLElement | undefined} */
  let layer = $state();
  /** @type {HTMLElement | undefined} */
  let panel = $state();
  let grown = $state(false);
  let drag = $state(0);
  let dragging = $state(false);

  function dismiss() {
    if (!open) return;
    open = false;
  }

  /* Open: take focus, inert the page, stand on the keyboard, lock the page's
     own scroll. Everything is undone when `open` goes false. */
  $effect(() => {
    if (!open || !layer || !panel) return;
    const release = holdSheet(layer, panel, { onescape: dismiss });
    const unstand = standOnKeyboard(layer);
    const root = document.documentElement;
    const overflow = root.style.overflow;
    root.style.overflow = "hidden";
    return () => {
      release();
      unstand();
      root.style.overflow = overflow;
      grown = false;
      drag = 0;
      onclose?.();
    };
  });

  /* THE WAY BACK CLOSES THE SHEET (§1.2). Opening pushes a shallow history
     entry carrying this sheet's id; back pops it, which closes the sheet
     before it leaves the page. Closing any other way takes the entry back
     off, so the history is what it was. */
  let pushed = false;
  $effect(() => {
    if (!history) return;
    const mine = page.state && /** @type {Record<string, unknown>} */ (page.state).pocketSheet === uid;
    if (open && !pushed) {
      pushed = true;
      if (!mine) pushState("", { ...page.state, pocketSheet: uid });
    } else if (open && pushed && !mine) {
      pushed = false;
      open = false; // back was pressed
    } else if (!open && pushed) {
      pushed = false;
      if (mine) window.history.back();
    }
  });
  /* A link inside the sheet replaces the sheet's history entry rather than
     stacking on it, so back from where it leads skips the closed sheet. */
  beforeNavigate((navigation) => {
    if (!open || !pushed || navigation.type !== "link" || !navigation.to) return;
    navigation.cancel();
    pushed = false;
    open = false;
    /* The router's own resolved destination, not a path of ours to resolve. */
    // eslint-disable-next-line svelte/no-navigation-without-resolve
    goto(navigation.to.url, { replaceState: true });
  });

  /* DRAG TO DISMISS (§1.4): the handle strip and the sheet's head drag.
     The body does not: it scrolls, and a touch the browser takes for a
     scroll cancels the pointer, so a body drag could never be finished. */
  let start = { y: 0, t: 0, lastY: 0, lastT: 0 };
  /** @type {number | null} */
  let pointer = null;
  /** @param {PointerEvent} event */
  function down(event) {
    const target = /** @type {HTMLElement} */ (event.target);
    if (!target.closest(".grab,.head") || target.closest("a,button,input,select,textarea")) return;
    pointer = event.pointerId;
    panel?.setPointerCapture?.(event.pointerId);
    start = { y: event.clientY, t: event.timeStamp, lastY: event.clientY, lastT: event.timeStamp };
    dragging = true;
  }
  /** @param {PointerEvent} event */
  function move(event) {
    if (event.pointerId !== pointer) return;
    const dy = event.clientY - start.y;
    drag = dy > 0 ? dy : Math.max(dy, -60) / 3;
    start.lastY = event.clientY;
    start.lastT = event.timeStamp;
  }
  /** @param {PointerEvent} event */
  function up(event) {
    if (event.pointerId !== pointer) return;
    pointer = null;
    dragging = false;
    const dy = event.clientY - start.y;
    const dt = Math.max(1, event.timeStamp - start.lastT);
    const velocity = (event.clientY - start.lastY) / dt;
    const outcome = sheetRelease({ dy, height: panel?.offsetHeight ?? 1, velocity, size, grown });
    drag = 0;
    if (outcome === "close") dismiss();
    else if (outcome === "grow") grown = true;
    else if (outcome === "shrink") grown = false;
  }
  /** @param {PointerEvent} event */
  function cancel(event) {
    if (event.pointerId !== pointer) return;
    pointer = null;
    dragging = false;
    drag = 0;
  }
</script>

<div class="p-sheet-layer" class:open data-size={size} class:grown bind:this={layer} use:portal>
  <!-- The scrim is a pointer's dismiss; Escape and the close word are the
       keyboard's, so it needs no key handler of its own. -->
  <div class="scrim" aria-hidden="true" onclick={dismiss}></div>
  <div class="panel" role="dialog" aria-modal="true" aria-labelledby="{uid}-title" tabindex="-1"
       bind:this={panel} class:dragging style:--p-drag="{drag}px"
       onpointerdown={down} onpointermove={move} onpointerup={up} onpointercancel={cancel}>
    <div class="grab" aria-hidden="true"><span></span></div>
    <div class="head">
      <h2 id="{uid}-title" class="title" class:sr-only={hideTitle}>{title}</h2>
      {@render head?.()}
      <button class="p-pill close" data-sheet-close onclick={dismiss}>close</button>
    </div>
    <div class="body">{@render children?.()}</div>
  </div>
</div>

<style>
  .p-sheet-layer{position:fixed;inset:0;z-index:50;visibility:hidden;
    transition:visibility 0s var(--p-rise)}
  .p-sheet-layer.open{visibility:visible;transition-delay:0s}
  .scrim{position:absolute;inset:0;background:color-mix(in srgb, var(--bg) 45%, transparent);
    opacity:0;transition:opacity var(--p-rise) var(--p-ease)}
  .open .scrim{opacity:1}

  /* The panel stands on the keyboard (--p-kb from sheet.js) and never
     taller than what is left above it (--p-vvh). */
  .panel{--h:var(--p-vvh, 100dvh);box-sizing:border-box;position:absolute;left:0;right:0;bottom:var(--p-kb, 0px);
    margin:0 auto;max-width:var(--p-column);display:flex;flex-direction:column;
    max-height:calc(var(--h) - env(safe-area-inset-top) - 8px);
    border-radius:18px 18px 0 0;border:1px solid var(--line);border-bottom:0;
    background:linear-gradient(var(--panel), var(--panel)), color-mix(in srgb, var(--bg) 92%, transparent);
    backdrop-filter:blur(16px);outline:none;
    padding:0 var(--p-gutter) calc(16px + env(safe-area-inset-bottom));
    transform:translateY(100%);transition:transform var(--p-rise) var(--p-ease),height var(--p-rise) var(--p-ease)}
  .open .panel{transform:translateY(max(var(--p-drag, 0px), -20px))}
  .panel.dragging{transition:none}
  [data-size=callout] .panel{max-height:calc(var(--h) * .45)}
  [data-size=list] .panel{height:calc(var(--h) * .6)}
  [data-size=list].grown .panel,[data-size=full] .panel{height:calc(var(--h) - env(safe-area-inset-top) - 8px)}

  /* The grab handle: 36x4, 8px from the top, inside a full-width 24px strip
     that is the drag target. */
  .grab{flex:none;height:24px;display:flex;justify-content:center;padding-top:8px;cursor:grab}
  .grab,.head{touch-action:none}
  .grab span{width:36px;height:4px;border-radius:2px;background:var(--line)}
  .head{flex:none;display:flex;align-items:center;gap:12px;min-height:var(--p-hit);margin-bottom:8px}
  .title{flex:1;min-width:0;margin:0;font:600 var(--p-type-sheet)/1.3 var(--ui);color:var(--ink)}
  .head .close{border-color:transparent;margin-right:calc(var(--p-pill-pad) * -1 + 4px)}
  .body{flex:1;min-height:0;overflow-y:auto;overscroll-behavior:contain}

  @media (prefers-reduced-motion:reduce){
    .scrim,.panel{transition:none}
    .p-sheet-layer{transition:none}
  }
</style>
