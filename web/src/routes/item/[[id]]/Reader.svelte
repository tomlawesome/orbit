<script>
  import { tick } from "svelte";
  import { pushState } from "$app/navigation";
  import { page } from "$app/state";
  import { resolve } from "$app/paths";
  import { inertPage, tabbables, trapTab } from "$lib/pocket/focus.js";
  import { portal } from "$lib/pocket/portal.js";
  import ArmButton from "$lib/pocket/ArmButton.svelte";
  import { loadStagedPage, previewPageHref } from "$lib/data/staged-page.js";

  /**
   * THE READER, on the desk and the phone alike (#1059, owner-decisions.md
   * §18; proposal §2.3; design/v19/item-phone/round-1 scene `reader`).
   * Round 1's reading room as a window over the belt, never a separate page:
   * the belt dims and blurs beneath. The head names the file and its item and holds `close`; under
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
   * Pages turn (#1300; design/v19/document-card/round-2 and round-6): a
   * round glass arrow either side of the page, only where there is a page
   * that way -- none on the left on page 1, none on the right on the last --
   * and the keys ← → PageUp PageDown Home End. The foot says "page N of M"
   * on a polite live region; a one-page file says "one page" and has no
   * arrows. Page N is the preview endpoint's own address with `?page=N`,
   * fetched rather than set as a bare `<img src>` because M is that
   * response's `X-Orbit-Page-Count` header (Orbit stores no page count) and
   * an `<img>` never sees a header. pdf.js still draws every page on the
   * server (ADR-0033); nothing renders a PDF here. Until a response has said
   * how many pages there are, the foot says "page N" and offers no arrows.
   *
   * `staged` (#1155): a waiting attachment's page opens here too, from
   * StagedPage.svelte. There is nothing to download or remove -- the foot
   * holds the same one-line note the reading card's does instead -- and its
   * pages come from `pageHref`, the staged preview endpoint, through the
   * same loader; given only `previewSrc` (loadStagedPage's object URL of
   * page one) it shows that one page and cannot turn. `onremove` is never
   * called for a staged doc: the arm button that would fire it is not
   * rendered.
   *
   * `pageHref` (optional, #1300): where pages are fetched from. Defaults to
   * `doc.previewHref` for an accepted document.
   * @typedef {{
   *   open?: boolean,
   *   doc: { name: string, href?: string, previewHref?: string },
   *   itemTitle: string,
   *   onremove: () => Promise<unknown>,
   *   staged?: boolean,
   *   previewSrc?: string,
   *   pageHref?: string,
   * }} Props
   */
  /** @type {Props} */
  let {
    open = $bindable(false), doc, itemTitle, onremove, staged = false, previewSrc = "", pageHref = "",
  } = $props();

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
  /** @type {HTMLButtonElement | undefined} */
  let prevArrow = $state();
  /** @type {HTMLButtonElement | undefined} */
  let nextArrow = $state();

  /* #1300: the page asked for, the page drawn, and how many there are. */
  const source = $derived(pageHref || (staged ? "" : (doc.previewHref ?? "")));
  let pageNo = $state(1);
  let shownPage = $state(1);
  /** @type {number | null} */
  let pageCount = $state(null);
  let pageUrl = $state("");
  const shownSrc = $derived(source ? pageUrl : previewSrc);
  const canTurn = $derived(pageCount !== null && pageCount > 1);
  const pageLine = $derived(
    pageCount === 1 ? "one page" : pageCount ? `page ${pageNo} of ${pageCount}` : `page ${pageNo}`,
  );
  const UNDRAWN = "this page could not be drawn — try closing and reopening it";

  /** @param {number} next */
  function turnTo(next) {
    if (!canTurn || pageCount === null) return;
    const target = Math.min(pageCount, Math.max(1, next));
    if (target === pageNo) return;
    /* An arrow that goes (the last page reached by the right one) hands
       focus to the other once it is drawn, so focus never lands on nothing. */
    const active = document.activeElement;
    const leaving = (active === nextArrow && target === pageCount) ? "next"
      : (active === prevArrow && target === 1) ? "prev" : null;
    pageNo = target;
    problem = null;
    stage?.scrollTo({ top: 0, left: 0 });
    if (leaving) {
      tick().then(() => {
        const other = leaving === "next" ? prevArrow : nextArrow;
        (other ?? panel)?.focus({ preventScroll: true });
      });
    }
  }

  /** @param {string} url */
  function showPage(url) {
    if (pageUrl) URL.revokeObjectURL(pageUrl);
    pageUrl = url;
  }

  /* Fetches page N while the reader is open: the object URL replaces the
     last one only once it has arrived, so the old page stays up meanwhile,
     and a turn made before it arrives abandons it. */
  $effect(() => {
    if (!open || !source) return;
    const wanted = pageNo;
    const controller = new AbortController();
    loadStagedPage(previewPageHref(source, wanted), controller.signal).then((result) => {
      if (controller.signal.aborted) {
        if (result.kind === "page") URL.revokeObjectURL(result.url);
        return;
      }
      if (result.kind !== "page") { problem = UNDRAWN; return; }
      showPage(result.url);
      shownPage = wanted;
      if (result.pageCount !== null) pageCount = result.pageCount;
    }).catch((error) => {
      if (error instanceof DOMException && error.name === "AbortError") return;
      problem = UNDRAWN;
    });
    return () => controller.abort();
  });

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
      if (event.key === "ArrowLeft" || event.key === "PageUp") { event.preventDefault(); turnTo(pageNo - 1); }
      else if (event.key === "ArrowRight" || event.key === "PageDown") { event.preventDefault(); turnTo(pageNo + 1); }
      else if (event.key === "Home") { event.preventDefault(); turnTo(1); }
      else if (event.key === "End") { event.preventDefault(); if (pageCount !== null) turnTo(pageCount); }
      else if (event.key === "+" || event.key === "=") { event.preventDefault(); zoomIn(); }
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
      pageNo = 1;
      shownPage = 1;
      pageCount = null;
      showPage("");
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
    <div class="rd-room">
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <div class="rd-stage" class:zoomed={scale !== null} bind:this={stage} onwheel={onWheel}
           onpointerdown={down} onpointermove={move} onpointerup={up} onpointercancel={up}>
        <img bind:this={img} src={shownSrc || undefined} alt="Page {shownPage} of {doc.name}"
             style:width={natural.w ? `${Math.round(natural.w * shownScale)}px` : undefined}
             onload={() => { if (img) natural = { w: img.naturalWidth, h: img.naturalHeight }; }}
             onerror={() => {
               /* #1151 W1-R11: this re-requests the page rather than reusing
                  the sheet's own already-loaded bytes, so it can fail on its
                  own even though the thumbnail that opened this already drew
                  fine — with no onerror at all, that left the browser's bare
                  broken-image glyph and no way to tell what happened. */
               problem = UNDRAWN;
             }} />
      </div>
      <!-- #1300: either side of the page, only where there is a page that way. -->
      {#if canTurn && pageNo > 1}
        <button class="rd-arrow prev" aria-label="Previous page" title="← or PageUp" bind:this={prevArrow}
                onclick={() => turnTo(pageNo - 1)}>←</button>
      {/if}
      {#if canTurn && pageCount !== null && pageNo < pageCount}
        <button class="rd-arrow next" aria-label="Next page" title="→ or PageDown" bind:this={nextArrow}
                onclick={() => turnTo(pageNo + 1)}>→</button>
      {/if}
    </div>
    <footer class="rd-foot">
      <p class="rd-page" aria-live="polite">{pageLine}</p>
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
  /* #1300: the room the page and its arrows share; the arrows stand over the
     stage's edges, so they never scroll with a zoomed page. */
  .rd-room{position:relative;flex:1;min-height:0;display:flex;flex-direction:column}
  .rd-stage{flex:1;min-height:0;overflow:hidden;display:grid;place-items:center;padding:12px;
    touch-action:pan-x pan-y}
  .rd-stage.zoomed{overflow:auto;place-items:start center}
  .rd-stage img{display:block;max-width:100%;max-height:100%;border-radius:2px;background:#fff;
    box-shadow:0 18px 44px rgba(0,0,0,.45)}
  .rd-stage.zoomed img{max-width:none;max-height:none}
  /* round-6's round glass arrows: 44px at the page's edges on a phone, 48px
     and further in on the desk. */
  .rd-arrow{position:absolute;top:50%;transform:translateY(-50%);z-index:1;width:44px;height:44px;
    border-radius:999px;display:grid;place-items:center;padding:0;font:20px/1 var(--mono);color:var(--ink-mid);
    cursor:pointer;background:var(--panel);border:1px solid var(--line);backdrop-filter:blur(8px);
    transition:color .15s,border-color .15s}
  .rd-arrow:hover{color:var(--ink);border-color:var(--ink-mid)}
  .rd-arrow:focus-visible{outline:2px solid var(--accent);outline-offset:3px}
  .rd-arrow.prev{left:8px}
  .rd-arrow.next{right:8px}
  @media (min-width:681px){
    .rd-arrow{width:48px;height:48px}
    .rd-arrow.prev{left:26px}
    .rd-arrow.next{right:26px}
  }
  .rd-foot{display:flex;flex-direction:column;align-items:center;gap:8px;padding-top:8px}
  .rd-page{margin:0;font:var(--p-type-meta) var(--mono);color:var(--ink-mid);font-variant-numeric:tabular-nums}
  /* #1155: the reading card's own one-line note, for a staged paper's foot. */
  .rcnote{font:10.5px var(--mono);color:var(--ink-quiet);letter-spacing:.02em;margin:0}
  .rd-acts{justify-content:center}
  .rd-download{--act:var(--accent);--act-text:var(--accent-text);
    border-color:color-mix(in srgb, var(--accent) 40%, transparent);color:var(--accent-text)}
  @media (prefers-reduced-motion:reduce){ .rd-layer{transition:none} }
</style>
