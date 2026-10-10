<script>
  import { tick, untrack } from "svelte";
  import { resolve } from "$app/paths";
  import { documentPreviewStateOf } from "$lib/data/belt.js";
  import { daysWords } from "$lib/data/engine-limits.js";
  import { loadStagedPage, previewPageHref } from "$lib/data/staged-page.js";
  import { pageKeyTarget } from "$lib/data/page-turn.js";
  import Pager from "./Pager.svelte";
  import Reader from "./Reader.svelte";
  import { inertPage } from "$lib/pocket/focus.js";

  /**
   * A DOCUMENT'S PREVIEW, FROM HOME'S ITEM DRAWER (#1319; owner-decisions
   * §34; design/v19/belt-purpose/round-3/f-preview-beside-tracked.html).
   *
   * The retired belt's reading card (#1088, #1300; the belt went with #1319),
   * carried over in markup, states and loading: the reticle while the page
   * is on its way, the page nearly edge to edge once it has landed (a button
   * that opens the reader over home), the pager under it, and the four
   * honest states — still scanning, removed (restore), refused, could not
   * draw (download) — with their plate held still.
   *
   * A SUGGESTION'S PAPER (#1319: a suggestion is reviewed in its home
   * drawer, owner-decisions §34) is staged with the mail, not stored
   * (`doc.staged`, belt.js stagedDocsOf): its page draws the same way where
   * the mail named a PDF, and the belt's own extra states come with it —
   * `Not yet in orbit.` for a paper Orbit has no page for, `This mail has
   * gone.` when it was decided or burned up meanwhile — with no download,
   * restore or remove, the foot saying why in one line instead (#1155).
   *
   * WHERE IT STANDS is the host's: on a wide screen home seats it in a
   * column beside the open drawer (home/+page.svelte's `.pvtrack`), sticky
   * at the page's 84px gutter; under 1200px it is the phone's bottom sheet,
   * fixed to the foot, on the desk and in the pocket alike (the CSS below).
   *
   * GOING. Escape, or a press anywhere off the card (and off the drawer's
   * document rows, which switch it, and the reader over it), asks the host
   * to close it through `onclose`. On a wide screen it goes at once, no fade
   * and no slide; the bottom sheet keeps its slide. Escape while the reader
   * is up is the reader's own, and closes only the reader.
   *
   */
  /** @typedef {import("$lib/data/belt.js").BeltDocumentRow} PreviewDoc */
  /**
   * @typedef {{
   *   doc: PreviewDoc | null,
   *   itemTitle: string,
   *   documentDays?: number | null,
   *   onclose: (how: { refocus: boolean, press: boolean }) => void,
   *   onremove: (doc: PreviewDoc) => Promise<unknown>,
   *   onrestore: (doc: PreviewDoc) => Promise<unknown>,
   * }} Props
   */
  /** @type {Props} */
  let { doc, itemTitle, documentDays = null, onclose, onremove, onrestore } = $props();

  const WIDE = "(min-width: 1200px)";
  const SHEET_MS = 300;
  /** #1151 W1-R10, as the belt: a hung page request reads as "could not
      draw" after this long, never as a reticle spinning for ever. */
  const LOAD_TIMEOUT_MS = 15_000;
  const UNDRAWN_PAGE = "this page could not be drawn — try again";

  /* The paper on show — kept through the bottom sheet's slide down after
     the host has let it go. */
  /** @type {PreviewDoc | null} */
  let shown = $state(null);
  let open = $state(false);
  let instant = $state(false);
  let imgLoaded = $state(false);
  let imgFailed = $state(false);
  /* #1155: a staged paper whose mail went between the list and the page */
  let gone = $state(false);
  let beatDone = $state(false);
  let src = $state("");
  let pageNo = $state(1);
  let shownPage = $state(1);
  /** @type {number | null} */
  let pageCount = $state(null);
  let restoring = $state(false);
  /** @type {string | null} */
  let problem = $state(null);
  let readerOpen = $state(false);
  /** @type {HTMLElement | undefined} */
  let card = $state();

  /** @type {AbortController | null} */
  let abort = null;
  let token = 0;
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let beatTimer;
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let loadTimer;
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let hideTimer;

  const reduced = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
  const wide = () => matchMedia(WIDE).matches;

  /* .by, not a bare expression: read at the top level, `shown` would be
     narrowed to its initial null. */
  const docState = $derived.by(() => (shown ? documentPreviewStateOf(shown) : null));
  /* A page Orbit believed it could draw but whose request failed reads as
     "could not draw", the belt's own rule — never a stuck loading state. */
  const paperState = $derived(gone ? "gone" : imgFailed ? "undrawable" : docState);
  const showing = $derived(docState === "available" && imgLoaded && beatDone && !imgFailed);
  const paged = $derived(showing && pageCount !== null);
  const alt = $derived.by(() => (shown ? `Page ${shownPage === 1 ? "one" : shownPage} of ${shown.name}` : ""));

  function revoke() {
    if (src.startsWith("blob:")) URL.revokeObjectURL(src);
  }

  function stopLoading() {
    clearTimeout(beatTimer);
    clearTimeout(loadTimer);
    abort?.abort();
    abort = null;
  }

  /** @param {PreviewDoc} next */
  function show(next) {
    stopLoading();
    clearTimeout(hideTimer);
    revoke();
    const mine = ++token;
    const same = shown?.id === next.id;
    shown = next;
    instant = false;
    imgLoaded = false;
    imgFailed = false;
    gone = false;
    restoring = false;
    problem = null;
    src = "";
    pageNo = 1;
    shownPage = 1;
    pageCount = null;
    readerOpen = false;
    const available = documentPreviewStateOf(next) === "available";
    /* create-v3's own walk: the page waits a beat so a fast load never
       flickers; a paper pressed again lands at once. */
    beatDone = !available || same;
    if (!beatDone) beatTimer = setTimeout(() => { beatDone = true; }, reduced() ? 0 : 900);
    if (!open) tick().then(() => requestAnimationFrame(() => { if (shown === next) open = true; }));
    tick().then(() => {
      if (card && !card.contains(document.activeElement)) card.focus({ preventScroll: true });
    });
    if (!available || !next.previewHref) return;
    loadTimer = setTimeout(() => { if (mine === token) failed(); }, LOAD_TIMEOUT_MS);
    loadPage(next, 1, mine);
  }

  /** Page `n`, through loadStagedPage: the response says how many pages
      there are (#1300). The page on show stays up until the next arrives.
      @param {PreviewDoc} paper @param {number} n @param {number} mine */
  function loadPage(paper, n, mine) {
    abort?.abort();
    const controller = new AbortController();
    abort = controller;
    loadStagedPage(previewPageHref(paper.previewHref, n), controller.signal).then((result) => {
      if (mine !== token || controller.signal.aborted) {
        if (result.kind === "page") URL.revokeObjectURL(result.url);
        return;
      }
      if (result.kind === "page") {
        revoke();
        src = result.url;
        shownPage = n;
        if (result.pageCount !== null) pageCount = result.pageCount;
      } else if (result.kind === "gone" && paper.staged) {
        clearTimeout(loadTimer);
        gone = true;
      } else if (n > 1) problem = UNDRAWN_PAGE;
      else failed();
    }).catch((error) => {
      if (mine !== token || (error instanceof DOMException && error.name === "AbortError")) return;
      if (n > 1) problem = UNDRAWN_PAGE;
      else failed();
    });
  }

  /** The pager's arrows, the keys, and the reader's turns all land here. @param {number} n */
  function turn(n) {
    if (!shown || n === pageNo) return;
    pageNo = n;
    problem = null;
    loadPage(shown, n, token);
  }

  function loaded() {
    clearTimeout(loadTimer);
    imgLoaded = true;
    imgFailed = false;
  }
  function failed() {
    clearTimeout(loadTimer);
    imgLoaded = true;
    imgFailed = true;
  }

  function hide() {
    if (!shown) return;
    stopLoading();
    readerOpen = false;
    token++;
    /* GONE AT ONCE on a wide screen; the bottom sheet slides down. */
    if (wide() || reduced()) {
      instant = true;
      open = false;
      shown = null;
      revoke();
      src = "";
      return;
    }
    open = false;
    hideTimer = setTimeout(() => {
      shown = null;
      revoke();
      src = "";
    }, SHEET_MS);
  }

  /* The host's paper, acted on once per change: not reactive, so showing
     it (which writes `shown` and `open`) never asks again. */
  /** @type {PreviewDoc | null} */
  let current = null;
  $effect(() => {
    const next = doc;
    untrack(() => {
      if (next && next !== current) { current = next; show(next); }
      else if (!next && current) { current = null; hide(); }
    });
  });
  $effect(() => () => { stopLoading(); clearTimeout(hideTimer); revoke(); });

  /* #1319: AS THE BOTTOM SHEET IT IS MODAL. Under 1200px the card covers
     the drawer's foot, so while it is up everything behind it is inert
     (the kit's pattern, focus.js) and it says so (aria-modal); beside the
     drawer on a wide screen it stays a non-modal dialog. A close the card
     asks for gives the page back first, so the host's refocus can land. */
  /** @type {(() => void) | null} */
  let release = null;
  /** The card and its scrim's box-less holder, what stays live. @type {HTMLElement | undefined} */
  let seat = $state();
  /** The sheet is up as a modal, so its scrim stands behind it. */
  let modal = $state(false);
  $effect(() => {
    if (!doc || !card || wide()) return;
    const sheet = card;
    const restore = inertPage(/** @type {HTMLElement} */ (seat));
    sheet.setAttribute("aria-modal", "true");
    modal = true;
    release = () => {
      release = null;
      modal = false;
      restore();
      sheet.removeAttribute("aria-modal");
    };
    return () => release?.();
  });

  /* Escape, the page keys, and a press off the card, while it is up. Held
     on the window ahead of home's own (its Escape puts the drawer away, its
     click off the drawer closes the row), so a press or an Escape that only
     closes the card closes nothing else. */
  $effect(() => {
    if (!doc) return;
    /** @param {boolean} press */
    const close = (press) => {
      const refocus = !press || Boolean(card?.contains(document.activeElement));
      release?.();
      onclose({ refocus, press });
    };
    /** @param {KeyboardEvent} event */
    const onKey = (event) => {
      if (readerOpen) return;
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        close(false);
        return;
      }
      if (!paged || event.altKey || event.ctrlKey || event.metaKey) return;
      if (event.target instanceof Element && event.target.closest("input, textarea, [contenteditable]")) return;
      const target = pageKeyTarget(event.key, pageNo, pageCount);
      if (target === undefined) return;
      event.preventDefault();
      event.stopPropagation();
      if (target !== null) turn(target);
    };
    /** @param {PointerEvent} event */
    const onPress = (event) => {
      const target = event.target instanceof Element ? event.target : null;
      if (readerOpen) {
        /* #1301, carried from the belt onto home (#1319): on a wide screen a
           press on the reader's dead space -- its backdrop, the stage beside
           the page -- closes the reader and the card with it, back to the
           drawer. Its own controls and its page keep it open. On a phone
           the reader is closed by its own close. */
        if (!wide() || target?.closest(".rd-panel :is(button, a, output, img), .rd-zoom")) return;
        readerOpen = false;
        close(true);
        return;
      }
      /* the scrim's own click closes it, so the tap ends there (#1319) */
      if (target?.closest("[data-preview-card], [data-doc-row], .rd-layer, [data-preview-scrim]")) return;
      close(true);
    };
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("pointerdown", onPress, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("pointerdown", onPress, true);
    };
  });

  async function restore() {
    if (!shown || restoring) return;
    const target = shown;
    const mine = token;
    restoring = true;
    problem = null;
    try {
      await onrestore(target);
    } catch (error) {
      if (mine === token) problem = /** @type {{ message?: string }} */ (error)?.message ?? "could not restore it — try again";
    } finally {
      restoring = false;
    }
  }

  async function remove() {
    if (!shown) return;
    await onremove(shown);
  }
</script>

<div class="pvseat" bind:this={seat}>
{#if modal}
  <!-- #1319: the bottom sheet's scrim, a pointer's dismiss, clear so the
       drawer reads through it; it takes the press, so the tap that puts the
       sheet away never lands on the page behind as well. Escape is the
       keyboard's, so it needs no key handler of its own. -->
  <div class="pvscrim" data-preview-scrim aria-hidden="true"
       onclick={() => { release?.(); onclose({ refocus: Boolean(card?.contains(document.activeElement)), press: true }); }}></div>
{/if}
{#if shown}
  {@const st = paperState}
  <!-- role=dialog: beside the drawer not modal, the drawer stays live and
       a press on it (or Escape) puts the card away; as the bottom sheet
       modal, the page behind inert (the effect above). -->
  <div class="glass readcard" data-preview-card bind:this={card}
         class:open class:instant class:snap={showing} class:still={st !== "available"}
         class:rc-refused={st === "refused"}
         role="dialog" aria-label={paged ? `${shown.name}, page ${pageNo} of ${pageCount}` : shown.name} tabindex="-1">
    <div class="pagebox">
      {#if st === "available" && !showing}
        <!-- create-v3's focus block, verbatim: the reticle, the owner's
             words breathing while the page is on its way. -->
        <div class="focus">
          <svg class="reticle" viewBox="0 0 96 96" aria-hidden="true">
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
          <div class="focusline">Focusing on the anomaly</div>
          <div class="why">orbit is drawing the page it holds<br>nothing is changed, and nothing is assumed</div>
        </div>
      {:else if st === "scanning"}
        <div class="focus">
          <div class="plate scanning" aria-hidden="true">still scanning</div>
          <div class="focusline">Still scanning this file</div>
          <div class="why">the page comes once it scans clean<br>nothing is assumed</div>
        </div>
      {:else if st === "removed"}
        <div class="focus">
          <div class="plate removed" aria-hidden="true">being removed</div>
          <div class="focusline">Removed</div>
          <div class="why">orbit keeps it {shown.deleteAfter ? `until ${shown.deleteAfter}` : `for ${daysWords(documentDays)}`}, then it is gone for good<br>restore puts it back exactly as it was</div>
        </div>
      {:else if st === "refused"}
        <div class="focus">
          <div class="plate" aria-hidden="true">refused</div>
          <div class="focusline">Orbit refused this file.</div>
          <div class="why">it did not pass what orbit checks before keeping a file<br>nothing here can be undone</div>
        </div>
      {:else if st === "undrawable"}
        <div class="focus">
          <div class="plate" aria-hidden="true">{shown.plate}</div>
          <div class="focusline">Orbit could not draw a picture of this document.</div>
          {#if shown.staged}
            <div class="why">it scanned clean, and is still attached on acceptance<br>orbit just could not turn it into a page to read here</div>
          {:else}
            <div class="why">the file is fine — scanned clean, and yours to download<br>orbit just could not turn it into a page to read here</div>
          {/if}
        </div>
      {:else if st === "staged"}
        <!-- #1155: the one staged paper Orbit cannot draw a page for. The
             foot holds nothing: nothing can be done with it here. -->
        <div class="focus">
          <div class="plate" aria-hidden="true">{shown.plate}</div>
          <div class="focusline">Not yet in orbit.</div>
          <div class="why">this paper came with the mail and is attached on acceptance<br>orbit has no page to show for it</div>
        </div>
      {:else if st === "gone"}
        <div class="focus">
          <div class="plate" aria-hidden="true">{shown.plate}</div>
          <div class="focusline">This mail has gone.</div>
          <div class="why">it burned up, or was decided from another screen<br>orbit keeps nothing of it</div>
        </div>
      {/if}

      {#if st === "available"}
        <div class="topsheet">
          <!-- §18: the page is a button; pressing it opens the reader over home. -->
          <button type="button" class="sheet" aria-label="Read {shown.name}"
                  disabled={!showing} onclick={() => { readerOpen = true; }}>
            <!-- `|| undefined`, the belt's own fix (#1155): an empty src is a
                 request for this page, which fails at once. -->
            <img src={src || undefined} {alt} onload={loaded} onerror={failed} />
          </button>
        </div>
      {/if}
    </div>

    {#if paged}
      <Pager page={pageNo} count={pageCount} onturn={turn} />
      {#if problem}<div class="problem" role="alert">{problem}</div>{/if}
      {#if shown.staged}<div class="rcfoot"><span class="rcnote">not yet in orbit · attached on acceptance</span></div>{/if}
    {:else if st === "available" && shown.staged}
      <!-- #1155: nothing can be done with a staged paper here; the foot says why -->
      <div class="rcfoot"><span class="rcnote">not yet in orbit · attached on acceptance</span></div>
    {:else if st === "removed"}
      <div class="rcfoot">
        <button type="button" class="quiet" disabled={restoring} onclick={restore}
                aria-label="Restore {shown.name}">restore</button>
      </div>
      {#if problem}<div class="problem" role="alert">{problem}</div>{/if}
    {:else if st === "undrawable" && !shown.staged}
      <div class="rcfoot">
        <!-- the download endpoint, outside resolve()'s typed routes: the
             same cast the belt's reading card uses. -->
        <a class="quiet" href={resolve(/** @type {"/home"} */ (shown.href))} download
           aria-label="Download {shown.name}">download</a>
      </div>
    {/if}
  </div>
{/if}

</div>

{#if shown && showing}
  <Reader bind:open={readerOpen} doc={shown} {itemTitle} onremove={remove}
          staged={Boolean(shown.staged)} pageHref={shown.staged ? shown.previewHref : ""}
          bind:pageNo={() => pageNo, turn} />
{/if}

<style>
  /* no box of its own: the card stands in the host's column as before */
  .pvseat{display:contents}
  /* round 6's glass and reading card, as round 3 carries them */
  .readcard{--paper:var(--upcoming);
    width:var(--readw,480px);min-width:0;box-sizing:border-box;overflow:hidden;padding:10px 10px 4px;
    background:var(--panel-raised);backdrop-filter:blur(16px);border:1px solid var(--line);border-radius:18px;
    opacity:0;transform:translateX(-16px);pointer-events:none;
    transition:opacity .55s ease .18s,transform .65s cubic-bezier(.4,.5,.15,1) .18s;
    display:grid;grid-template-rows:minmax(0,1fr) auto;grid-template-columns:minmax(0,1fr);gap:4px;
    font-family:var(--ui);color:var(--ink);line-height:1.55}
  .readcard.open{opacity:1;transform:none;pointer-events:auto}
  .readcard:focus{outline:none}
  /* GONE AT ONCE: no fade, no slide */
  .readcard.instant,.readcard.instant *{transition:none!important;animation:none!important}

  /* TRACKED (round 3, F): in home's column beside the drawer, sticky at the
     page's 84px gutter, never taller than the window leaves. */
  :global(.pvtrack) .readcard{position:sticky;top:84px;margin:0;max-height:calc(100vh - 84px - 16px)}
  /* ROUND 5's fit: once the page has landed the card shrink-wraps it,
     whole, in its own proportions, as tall as the window leaves (the host
     measures the width it settles on to centre the pair). */
  @media (min-width:1200px){
    .readcard.snap{width:max-content;min-width:220px;max-width:480px}
  }

  .pagebox{position:relative;min-height:0;min-width:0;overflow:visible;display:grid;place-items:center}
  .readcard.snap .pagebox{display:block;overflow:auto;overscroll-behavior:contain;scrollbar-width:thin}

  /* create-v3, verbatim: the focus — the reticle, the owner's line breathing */
  .focus{display:flex;flex-direction:column;align-items:center;text-align:center;
    padding:18px 0 4px;max-width:360px;margin:0 auto}
  .reticle{width:96px;height:96px;margin-bottom:20px}
  .reticle .sweep{transform-origin:48px 48px;animation:pv-sweep 9s linear infinite}
  .reticle .pull{transform-origin:48px 48px;animation:pv-pull 3.6s ease-in-out infinite}
  @keyframes pv-sweep{to{transform:rotate(360deg)}}
  @keyframes pv-pull{0%,100%{transform:scale(1);opacity:.85}50%{transform:scale(.88);opacity:.5}}
  .focusline{font:600 15.5px var(--display);letter-spacing:.01em;color:var(--ink);
    animation:pv-breathe 4.2s ease-in-out infinite}
  @keyframes pv-breathe{0%,100%{opacity:.96}50%{opacity:.42}}
  /* 13px, the floor (#1319): it was 10.5px */
  .why{font:13px var(--mono);color:var(--ink-quiet);line-height:1.7;margin-top:12px}
  /* the honest states hold still: the line said once, only the plate drawn */
  .readcard.still .focusline{animation:none}
  .readcard.still .why{color:var(--ink-mid)}
  .readcard.rc-refused .focusline{color:var(--degraded)}

  /* round 6's honest-state plate; home has no --paper, so it wears the
     upcoming tone (the mockup's own choice) */
  .plate{flex:none;width:104px;height:134px;border-radius:8px;position:relative;box-sizing:border-box;
    border:1px solid var(--paper);background:var(--panel);margin:0 auto 18px;
    display:grid;place-items:end center;padding-bottom:8px;
    font:9.5px var(--mono);letter-spacing:.1em;color:var(--paper)}
  .plate::before{content:"";position:absolute;left:14px;right:14px;top:20px;height:1px;background:var(--line);
    box-shadow:0 10px 0 var(--line),0 20px 0 var(--line-soft),0 30px 0 var(--line-soft),
               0 40px 0 var(--line-soft),0 50px 0 var(--line-soft)}
  .plate.scanning{overflow:hidden;letter-spacing:.06em;animation:pv-platebreath 2.6s ease-in-out infinite alternate}
  .plate.scanning::before{opacity:.45}
  .plate.scanning::after{content:"";position:absolute;left:5px;right:5px;top:6px;height:2px;border-radius:1px;
    background:var(--paper);opacity:.95;
    box-shadow:0 0 5px 1px var(--paper),0 0 16px 2px color-mix(in srgb,var(--paper) 45%,transparent);
    animation:pv-scanline 2.2s ease-in-out infinite alternate}
  @keyframes pv-scanline{from{top:6px}to{top:calc(100% - 8px)}}
  @keyframes pv-platebreath{from{border-color:color-mix(in srgb,var(--paper) 30%,transparent)}to{border-color:var(--paper)}}
  .plate.removed{border-style:dashed;opacity:.55;letter-spacing:.06em}
  .plate.removed::before{opacity:.5}

  /* create-v3's topsheet: the page, whole, on the cream sheet with the
     tilted second sheet under it */
  .topsheet{display:none}
  .readcard.snap .topsheet{display:flex;justify-content:center;width:100%;
    animation:pv-landed .6s cubic-bezier(.3,.7,.2,1) backwards}
  @keyframes pv-landed{from{opacity:0;transform:translateY(8px) scale(.985)}to{opacity:1;transform:none}}
  /* min-width:0, or the flex item keeps the page's own width and the card
     scrolls sideways on a phone */
  .sheet{position:relative;display:block;width:max-content;min-width:0;max-width:100%;margin:0;padding:9px;
    background:#f6f4ee;border:0;border-radius:5px;font:inherit;color:inherit;cursor:zoom-in;
    appearance:none;-webkit-appearance:none;
    box-shadow:0 18px 44px rgba(0,0,0,.45),0 1px 0 rgba(255,255,255,.4) inset}
  .sheet::before{content:"";position:absolute;inset:0;background:#e7e3d8;border-radius:5px;
    transform:rotate(-1.1deg) translate(-4px,3px);z-index:-1}
  .sheet:disabled{cursor:default}
  .sheet:focus-visible{outline:2px solid var(--accent);outline-offset:4px}
  .sheet:hover img{filter:brightness(1.03)}
  .sheet img{display:block;border-radius:2px;background:#fff;width:auto;max-width:100%;height:auto;
    max-height:calc(100vh - 84px - 16px - 62px - 18px)}

  /* the foot: the pager (Pager.svelte), or an honest state's one word */
  .rcnote{font:10.5px var(--mono);color:var(--ink-quiet);letter-spacing:.02em;margin:0}
  .rcfoot{display:flex;justify-content:center;align-items:center;min-height:44px;
    font:11px var(--mono);color:var(--ink-mid)}
  .quiet{display:inline-flex;align-items:center;font:10.5px var(--mono);color:var(--ink-quiet);
    background:none;border:0;cursor:pointer;padding:0 8px;height:44px;text-decoration:none;letter-spacing:.02em}
  .quiet:hover{color:var(--ink)}
  .quiet:focus-visible{outline:2px solid var(--accent);outline-offset:-2px;border-radius:999px}
  .quiet:disabled{opacity:.4;cursor:default}
  .problem{font:13px var(--mono);color:var(--overdue-text);text-align:center;padding:0 8px 8px;line-height:1.6}

  /* UNDER 1200px there is no room beside the drawer: the card is the phone's
     bottom sheet (round 6, CON-10), on the desk and in the pocket alike —
     fixed to the foot, 18px shoulders, the grab, up from below in .3s. */
  @media (max-width:1199.98px){
    .pvscrim{position:fixed;inset:0;z-index:44}
    .readcard,:global(.pvtrack) .readcard{position:fixed;left:0;right:0;bottom:0;top:auto;z-index:45;
      width:auto;max-height:88vh;margin:0;border-radius:18px 18px 0 0;
      border-left:0;border-right:0;border-bottom:0;backdrop-filter:blur(18px);
      padding:12px 12px calc(6px + env(safe-area-inset-bottom));
      grid-template-rows:auto minmax(0,1fr) auto;
      opacity:1;transform:translateY(105%);visibility:hidden;
      transition:transform .3s cubic-bezier(.3,.7,.3,1),visibility 0s .3s}
    .readcard.open,:global(.pvtrack) .readcard.open{transform:none;visibility:visible;transition-delay:0s}
    .readcard::before{content:"";display:block;width:36px;height:4px;border-radius:2px;
      background:var(--line);margin:0 auto 4px}
    .sheet img{max-height:calc(88vh - 62px - 18px - 24px)}
  }
  @media (prefers-reduced-motion: reduce){
    .readcard,.readcard.open{transition:none}
    .readcard.snap .topsheet,.reticle .sweep,.reticle .pull,.focusline,.plate.scanning,.plate.scanning::after{animation:none}
  }
</style>
