<script>
  import { pushState } from "$app/navigation";
  import { page } from "$app/state";
  import { resolve } from "$app/paths";
  import { inertPage, tabbables, trapTab } from "$lib/pocket/focus.js";
  import { portal } from "$lib/pocket/portal.js";
  import ArmButton from "$lib/pocket/ArmButton.svelte";

  /**
   * THE READER on a phone (#1059, owner-decisions.md §18; proposal §2.3;
   * design/v19/item-phone/round-1 scene `reader`). Round 1's reading room as
   * a window over the belt, never a separate page: the belt dims and blurs
   * beneath. The head names the file and its item and holds `close`; under
   * it `fit − % +`. The page as large as the window allows; past fit it
   * scrolls inside the window. The foot holds the page number and the two
   * acts, `download` in the accent and `remove` in the overdue tone, which
   * arms before it fires. Zoom by the buttons, by + − 0, by ctrl+wheel and
   * by pinch.
   *
   * The one full-screen window in the app, so it is a dialog of its own
   * rather than a kit Sheet: it stands OVER the preview sheet that opened it
   * (one sheet at a time still holds — this is not a sheet), which is why
   * its Escape, Tab and focus are caught at the window, ahead of the sheet's
   * own document-level hold beneath it. Back closes it before anything else.
   *
   * Pages after the first are not drawn yet: the preview endpoint renders
   * page one only and Orbit records no page count (#1088), which §18 leaves
   * open. So there are no arrows, and the foot says "page 1" rather than
   * inventing an "of N".
   *
   * `staged` (#1155): a waiting attachment's page opens here too, from
   * StagedPage.svelte. There is nothing to download or remove -- the foot
   * holds the same one-line note the reading card's does instead -- and its
   * page comes from `previewSrc` (loadStagedPage's object URL), never a bare
   * `doc.previewHref`, because only that loader can tell "gone" apart from
   * "could not draw". `onremove` is never called for a staged doc: the arm
   * button that would fire it is not rendered.
   * @typedef {{
   *   open?: boolean,
   *   doc: { name: string, href?: string, previewHref?: string },
   *   itemTitle: string,
   *   onremove: () => Promise<unknown>,
   *   staged?: boolean,
   *   previewSrc?: string,
   * }} Props
   */
  /** @type {Props} */
  let { open = $bindable(false), doc, itemTitle, onremove, staged = false, previewSrc = "" } = $props();

  /** @type {HTMLElement | undefined} */
  let layer = $state();
  /** @type {HTMLElement | undefined} */
  let panel = $state();
  /** @type {HTMLElement | undefined} */
  let stage = $state();
  /** @type {HTMLImageElement | undefined} */
  let img = $state();
  /* null is fit; otherwise the page's scale against its own pixels */
  /** @type {number | null} */
  let scale = $state(null);
  let natural = $state({ w: 0, h: 0 });
  let box = $state({ w: 0, h: 0 });
  let removing = $state(false);
  /** @type {string | null} */
  let problem = $state(null);

  const fitScale = $derived(
    natural.w && box.w ? Math.min(box.w / natural.w, box.h / natural.h) : 1,
  );
  const shownScale = $derived(scale ?? fitScale);
  const percent = $derived(Math.round(shownScale * 100));
  const MIN = 0.1, MAX = 4, STEP = 0.25;

  /** @param {number} next */
  function zoomTo(next) {
    const clamped = Math.min(MAX, Math.max(MIN, next));
    scale = Math.abs(clamped - fitScale) < 0.005 ? null : clamped;
  }
  const zoomIn = () => zoomTo(shownScale + STEP);
  const zoomOut = () => zoomTo(shownScale - STEP);
  const fit = () => { scale = null; };

  function close() { open = false; }

  /* Open: the page behind goes inert (the sheet beneath included), focus
     moves in, and the window catches Escape, Tab and stray focus before the
     sheet's own hold can. */
  $effect(() => {
    if (!open || !layer || !panel) return;
    const held = panel;
    const opener = /** @type {HTMLElement | null} */ (document.activeElement);
    const restoreInert = inertPage(layer);
    const first = tabbables(held)[0] ?? held;
    first.focus({ preventScroll: true });
    /** @param {KeyboardEvent} event */
    const onKey = (event) => {
      event.stopPropagation();
      if (event.key === "Escape") { event.preventDefault(); close(); return; }
      if (event.target instanceof Element && event.target.closest("input, textarea")) return;
      if (event.key === "+" || event.key === "=") { event.preventDefault(); zoomIn(); }
      else if (event.key === "-" || event.key === "_") { event.preventDefault(); zoomOut(); }
      else if (event.key === "0") { event.preventDefault(); fit(); }
      else trapTab(event, held);
    };
    /** @param {FocusEvent} event */
    const onFocus = (event) => {
      event.stopPropagation();
      if (event.target instanceof Node && !layer?.contains(event.target)) panel?.focus({ preventScroll: true });
    };
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("focusin", onFocus, true);
    const root = document.documentElement;
    const overflow = root.style.overflow;
    root.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("focusin", onFocus, true);
      restoreInert();
      root.style.overflow = overflow;
      scale = null;
      problem = null;
      if (opener?.isConnected) opener.focus({ preventScroll: true });
    };
  });

  /* Back closes the reader first (§1.2), the Sheet's own rule. */
  let pushed = false;
  $effect(() => {
    const mine = Boolean(page.state && /** @type {Record<string, unknown>} */ (page.state).pocketReader);
    if (open && !pushed) {
      pushed = true;
      if (!mine) pushState("", { ...page.state, pocketReader: true });
    } else if (open && pushed && !mine) {
      pushed = false;
      open = false;
    } else if (!open && pushed) {
      pushed = false;
      if (mine) history.back();
    }
  });

  /* The stage's size is what "fit" means. */
  $effect(() => {
    if (!open || !stage) return;
    const read = () => { if (stage) box = { w: stage.clientWidth - 24, h: stage.clientHeight - 24 }; };
    read();
    const watch = new ResizeObserver(read);
    watch.observe(stage);
    return () => watch.disconnect();
  });

  /* ctrl+wheel and pinch (§18). */
  /** @param {WheelEvent} event */
  function onWheel(event) {
    if (!event.ctrlKey) return;
    event.preventDefault();
    zoomTo(shownScale * (event.deltaY < 0 ? 1.1 : 1 / 1.1));
  }
  /* Plain, not reactive: only the handlers below read it. */
  /** @type {Record<number, { x: number, y: number }>} */
  const touches = {};
  let pinch = { d: 0, s: 1 };
  /** @param {PointerEvent} event */
  function down(event) {
    if (event.pointerType !== "touch") return;
    touches[event.pointerId] = { x: event.clientX, y: event.clientY };
    if (Object.keys(touches).length === 2) {
      const [a, b] = Object.values(touches);
      pinch = { d: Math.hypot(a.x - b.x, a.y - b.y) || 1, s: shownScale };
    }
  }
  /** @param {PointerEvent} event */
  function move(event) {
    if (!(event.pointerId in touches)) return;
    touches[event.pointerId] = { x: event.clientX, y: event.clientY };
    if (Object.keys(touches).length !== 2) return;
    const [a, b] = Object.values(touches);
    zoomTo(pinch.s * (Math.hypot(a.x - b.x, a.y - b.y) / pinch.d));
  }
  /** @param {PointerEvent} event */
  function up(event) { delete touches[event.pointerId]; }

  async function remove() {
    if (removing || staged) return;
    removing = true;
    problem = null;
    try {
      await onremove();
      open = false;
    } catch (error) {
      problem = /** @type {{ message?: string }} */ (error)?.message ?? "could not remove it — try again";
    } finally {
      removing = false;
    }
  }
</script>

<div class="rd-layer" class:open bind:this={layer} use:portal>
  <div class="rd-panel" role="dialog" aria-modal="true" aria-label="{doc.name}, {itemTitle}" tabindex="-1"
       bind:this={panel}>
    <header class="rd-head">
      <p class="rd-name"><b>{doc.name}</b> <span>· {itemTitle}</span></p>
      <button class="p-pill rd-close" onclick={close}>close</button>
    </header>
    <div class="rd-zoom" role="group" aria-label="Zoom">
      <button class="p-pill rd-fit" aria-pressed={scale === null} onclick={fit}>fit</button>
      <button class="p-pill" aria-label="Zoom out" onclick={zoomOut}>−</button>
      <output class="rd-pct" aria-live="polite">{percent}%</output>
      <button class="p-pill" aria-label="Zoom in" onclick={zoomIn}>+</button>
    </div>
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div class="rd-stage" class:zoomed={scale !== null} bind:this={stage} onwheel={onWheel}
         onpointerdown={down} onpointermove={move} onpointerup={up} onpointercancel={up}>
      <img bind:this={img} src={staged ? previewSrc : (doc.previewHref ?? "")} alt="Page one of {doc.name}"
           style:width={natural.w ? `${Math.round(natural.w * shownScale)}px` : undefined}
           onload={() => { if (img) natural = { w: img.naturalWidth, h: img.naturalHeight }; }} />
    </div>
    <footer class="rd-foot">
      <p class="rd-page">page 1</p>
      {#if staged}
        <p class="rcnote">not yet in orbit · attached on acceptance</p>
      {:else}
        <div class="p-pills rd-acts">
          <!-- doc.href is the download endpoint, outside resolve()'s typed
               routes; the same cast the desk's reading card uses. -->
          <a class="p-pill rd-download" href={resolve(/** @type {"/home"} */ (doc.href))} download>download</a>
          <ArmButton label="remove" armedLabel="tap again to remove" name="Remove {doc.name}" onfire={remove} />
        </div>
      {/if}
      {#if problem}<p class="p-error" role="alert">{problem}</p>{/if}
    </footer>
  </div>
</div>

<style>
  .rd-layer{position:fixed;inset:0;z-index:55;visibility:hidden;opacity:0;
    background:color-mix(in srgb, var(--bg) 90%, transparent);backdrop-filter:blur(14px);
    transition:opacity var(--p-rise) var(--p-ease),visibility 0s var(--p-rise)}
  .rd-layer.open{visibility:visible;opacity:1;transition-delay:0s}
  .rd-panel{position:absolute;inset:0;display:flex;flex-direction:column;outline:none;
    padding:env(safe-area-inset-top) var(--p-gutter) calc(12px + env(safe-area-inset-bottom))}
  .rd-head{display:flex;align-items:center;gap:8px;min-height:var(--p-chrome)}
  .rd-name{flex:1;min-width:0;margin:0;font:var(--p-type-meta)/1.35 var(--mono);color:var(--ink-quiet);
    overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .rd-name b{font:600 var(--p-type-body) var(--display);color:var(--ink)}
  .rd-close{border-color:transparent;margin-right:-8px}
  .rd-zoom{display:flex;align-items:center;justify-content:center;gap:4px}
  .rd-zoom .p-pill{border-color:transparent;min-width:var(--p-hit);padding:0 12px}
  .rd-zoom .rd-fit{text-transform:uppercase;letter-spacing:.14em}
  .rd-zoom .rd-fit[aria-pressed=true]{color:var(--accent-text)}
  .rd-pct{min-width:4.5em;text-align:center;font:var(--p-type-button) var(--mono);color:var(--ink)}
  .rd-stage{flex:1;min-height:0;overflow:hidden;display:grid;place-items:center;padding:12px;
    touch-action:pan-x pan-y}
  .rd-stage.zoomed{overflow:auto;place-items:start center}
  .rd-stage img{display:block;max-width:100%;max-height:100%;border-radius:2px;background:#fff;
    box-shadow:0 18px 44px rgba(0,0,0,.45)}
  .rd-stage.zoomed img{max-width:none;max-height:none}
  .rd-foot{display:flex;flex-direction:column;align-items:center;gap:8px;padding-top:8px}
  .rd-page{margin:0;font:var(--p-type-meta) var(--mono);color:var(--ink-mid)}
  /* #1155: the reading card's own one-line note, for a staged paper's foot. */
  .rcnote{font:10.5px var(--mono);color:var(--ink-quiet);letter-spacing:.02em;margin:0}
  .rd-acts{justify-content:center}
  .rd-download{--act:var(--accent);--act-text:var(--accent-text);
    border-color:color-mix(in srgb, var(--accent) 40%, transparent);color:var(--accent-text)}
  @media (prefers-reduced-motion:reduce){ .rd-layer{transition:none} }
</style>
