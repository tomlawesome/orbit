<script module>
  /**
   * Where "All release notes" goes (#1618 note 52485): the About page's
   * release-notes section (#1713). One constant, so the destination is
   * changed in one place.
   */
  export const RELEASE_NOTES_HREF = "/about#release-notes";
</script>

<script>
  import { onDestroy, tick } from "svelte";
  import { whatsNewOpen } from "./open.js";
  import { page } from "$app/state";
  import { dismissWhatsNew, readWhatsNew } from "$lib/data/workspace.js";

  /**
   * THE WHAT'S-NEW CARD (#1618), ported from home-sun round 5, direction J
   * (design/v19/home-sun/round-5/j-whats-new.html, owner decision 42). The
   * markup and CSS are the sheet's own; the desk card and the phone sheet are
   * one element, switched by the pocket query (media.js POCKET_QUERY, written
   * out in the stylesheet because CSS cannot read a constant).
   *
   * Mounted once in the root layout beside <Tour />, it acts only on /home:
   * one GET per page load, and nothing at all when `releases` is empty, the
   * read fails, or the reader is elsewhere. The running version and the
   * reader's role both come from the answer (`forAdministrators` is present
   * for an instance administrator only).
   *
   * Every dismiss path (Got it, Escape, All release notes) closes the card
   * and POSTs the version the GET named, once. A failed write is not
   * retried: the card is gone for this load and comes back on the next one,
   * which is the honest answer to a write that did not land.
   *
   * It waits while the first-run film is showing: the film's transport pill
   * (#orbit-tour-transport, transport.js) is in the document from its start to
   * its teardown. No timers anywhere (no auto-play, no auto-dismiss).
   */
  const HOME = "/home";
  const TOUR_TRANSPORT = "orbit-tour-transport";

  /** @typedef {{ lead: string, text: string }} Bullet */
  /** @typedef {{ version: string, everyone: Bullet[], admins: Bullet[] }} Notice */
  /* Cast inside $state(): a @type on the declaration alone lets TypeScript
     narrow the null start to `never` (svelte-check). */
  let notice = $state(/** @type {Notice | null} */ (null));
  let dismissed = $state(false);
  let tourShowing = $state(false);
  let asked = false;

  const open = $derived(notice !== null && !dismissed && !tourShowing && page.url.pathname === HOME);
  /* The importance pill stays off while the sheet is open (#1757). */
  $effect(() => whatsNewOpen.set(open));
  onDestroy(() => whatsNewOpen.set(false));
  /* The sheet's eyebrow sets the version without its "v". */
  const shownVersion = $derived(notice ? notice.version.replace(/^v/, "") : "");

  /** @type {HTMLElement | null} */
  let card = $state(null);
  /** @type {HTMLElement | null} */
  let title = $state(null);
  /** @type {HTMLElement | null} */
  let scroller = $state(null);
  let more = $state(false);

  async function ask() {
    try {
      const answer = await readWhatsNew();
      if (!answer.version || answer.releases.length === 0) return;
      const everyone = answer.releases.flatMap((release) => release.forEveryone ?? []);
      const admins = answer.releases.flatMap((release) => release.forAdministrators ?? []);
      if (everyone.length + admins.length === 0) return;
      /* Looked at before the notice is set, so the card never flashes over the film. */
      tourShowing = document.getElementById(TOUR_TRANSPORT) !== null;
      notice = { version: answer.version, everyone, admins };
    } catch { /* nothing to show: the notice is never worth an error */ }
  }

  $effect(() => {
    if (asked || page.url.pathname !== HOME) return;
    asked = true;
    void ask();
  });

  /* The film's transport, watched only while there is something to show. */
  $effect(() => {
    if (!notice || dismissed) return;
    const look = () => { tourShowing = document.getElementById(TOUR_TRANSPORT) !== null; };
    look();
    const watch = new MutationObserver(look);
    watch.observe(document.body, { childList: true, subtree: true });
    return () => watch.disconnect();
  });

  /* The element that had focus before the card opened (APG Dialog (Modal):
     focus goes back to the invoking element when the dialog closes). */
  /** @type {Element | null} */
  let invoker = null;
  let wasOpen = false;
  /** @type {HTMLElement | null} */
  let host = null;

  /* The heading takes focus on open, as drawn. */
  $effect(() => {
    if (open && title) {
      if (!wasOpen) { wasOpen = true; invoker = document.activeElement; host = card?.parentElement?.parentElement ?? null; }
      title.focus({ preventScroll: true });
    }
  });

  /* After the card has left the document: back to the invoker if it is still
     there, else the page's main landmark (the tour's moveFocusOut idiom,
     transport.js), else the element the card was mounted in, else the body. */
  async function restoreFocus() {
    const back = invoker;
    invoker = null;
    wasOpen = false;
    await tick();
    if (back instanceof HTMLElement && back !== document.body && back.isConnected) {
      back.focus({ preventScroll: true });
      if (document.activeElement === back) return;
    }
    const target = document.querySelector("main")
      ?? (host?.isConnected ? host : null)
      ?? document.body;
    target.tabIndex = -1;
    target.focus({ preventScroll: true });
  }

  /* Escape belongs to the card while it is open: caught in the capture phase
     ahead of every other window listener and stopped there. */
  $effect(() => {
    if (!open) return;
    /** @param {KeyboardEvent} event */
    const grab = (event) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopImmediatePropagation();
      dismiss();
    };
    window.addEventListener("keydown", grab, true);
    return () => window.removeEventListener("keydown", grab, true);
  });

  /* A scrolling body (the phone sheet, a short desk window) fades at the
     foot while there is more below. */
  function hint() {
    if (scroller) more = scroller.scrollTop + scroller.clientHeight < scroller.scrollHeight - 2;
  }
  $effect(() => {
    if (open && scroller) hint();
  });

  function dismiss() {
    if (!notice || dismissed) return;
    dismissed = true;
    void restoreFocus();
    void dismissWhatsNew(notice.version).catch(() => {});
  }

  /** @param {KeyboardEvent} event */
  function onKeydown(event) {
    if (!open || !card || !title) return;
    if (event.key === "Tab") { /* keep focus inside the dialog */
      const stops = [title, ...card.querySelectorAll("a[href],button")];
      const at = stops.indexOf(/** @type {HTMLElement} */ (document.activeElement));
      const next = event.shiftKey ? (at <= 0 ? stops.length - 1 : at - 1) : (at === stops.length - 1 ? 0 : at + 1);
      event.preventDefault();
      /** @type {HTMLElement} */ (stops[next]).focus();
    }
  }
</script>

<svelte:window onkeydown={onKeydown} onresize={hint} />

{#if open && notice}
  <div class="wn-scrim" aria-hidden="true"></div>
  <div class="wn-layer">
    <div class="card" bind:this={card} role="dialog" aria-modal="true" aria-labelledby="wn-title">
      <div class="grab" aria-hidden="true"><span></span></div>
      <div class="scroll" bind:this={scroller} data-more={more} onscroll={hint}>
        <p class="eyebrow">What’s new · Orbit {shownVersion}</p>
        <h2 class="title" id="wn-title" tabindex="-1" bind:this={title}>New in this release</h2>
        {#if notice.everyone.length > 0}
          <ul class="notes">
            {#each notice.everyone as bullet, i (i)}
              <li><span><b>{bullet.lead}</b> {bullet.text}</span></li>
            {/each}
          </ul>
        {/if}
        {#if notice.admins.length > 0}
          <div class="admin" class:alone={notice.everyone.length === 0}>
            {#if notice.everyone.length > 0}<hr class="divider">{/if}
            <h3 class="eyebrow">For administrators</h3>
            <ul class="notes">
              {#each notice.admins as bullet, i (i)}
                <li><span><b>{bullet.lead}</b> {bullet.text}</span></li>
              {/each}
            </ul>
          </div>
        {/if}
      </div>
      <div class="foot">
        <!-- One constant names the destination (#1618 note 52485); a fragment on
             a known route, not a route string for resolve() to type. -->
        <!-- eslint-disable-next-line svelte/no-navigation-without-resolve -->
        <a class="quiet" href={RELEASE_NOTES_HREF} onclick={dismiss}>All release notes</a>
        <button class="act" type="button" onclick={dismiss}>Got it</button>
      </div>
    </div>
  </div>
{/if}

<style>
  /* Lifted from j-whats-new.html's round-5 block. The sheet's body[data-scene]
     switch is the pocket query here (media.js POCKET_QUERY): desk by default,
     the phone sheet under it. Class names the sheet shares with the screens'
     own stylesheets are safe: these rules are scoped to this component. */

  /* The sheet's .16s fade on dismiss is not carried over: the card leaves the
     document when dismissed (a dialog that is gone is not in the tree), and
     Svelte's out-transition runs on Web Animations, which happy-dom cancels. */

  /* the scrim: a standard dialog scrim. On the phone the sheet's .45; on the
     desk lightened to .2 (owner's build tweak, #1618 note 48817) so the planets
     stay faintly readable around and through the glass. */
  .wn-scrim{position:fixed;inset:0;z-index:50;background:rgba(4,7,16,.2)}
  .wn-layer{position:fixed;inset:0;z-index:51;display:flex}

  /* the card: the first-household ring card's glass (web/src/lib/ringcard.css
     .ringglass and .card), as a rectangle. Ink is the card's own, fixed. */
  .card{--ink:#f0f4fb;--ink-mid:#c0cade;--ink-faint:#9aa6bf;
    --line:rgba(240,244,251,.26);--line-soft:rgba(240,244,251,.14);
    position:relative;display:flex;flex-direction:column;overflow:hidden;color:var(--ink);
    box-sizing:border-box;font:14px/1.5 var(--ui);
    background:rgba(6,10,22,.56);
    -webkit-backdrop-filter:blur(20px) saturate(1.1) brightness(.74);
    backdrop-filter:blur(20px) saturate(1.1) brightness(.74);
    border:1px solid var(--line-soft);
    box-shadow:0 40px 120px -50px rgba(0,0,0,.8),0 0 90px -40px rgba(216,180,90,.18) inset}
  .card *{box-sizing:border-box}
  .grab{display:none}
  .scroll{flex:1 1 auto;min-height:0;overflow-y:auto;overscroll-behavior:contain}
  .eyebrow{margin:0;font:600 11px/1.4 var(--mono);letter-spacing:.14em;text-transform:uppercase;color:var(--ink-faint)}
  h2.title{margin:6px 0 0;font:600 20px/1.3 var(--ui);color:var(--ink);outline:none}
  h3.eyebrow{margin:0 0 14px}
  ul.notes{list-style:none;margin:20px 0 0;padding:0;display:grid;gap:14px}
  .notes li{display:grid;grid-template-columns:7px 1fr;column-gap:12px;font-size:14px;line-height:1.5;color:var(--ink-mid)}
  .notes li::before{content:"";width:7px;height:7px;border-radius:50%;background:var(--accent);margin-top:calc(.75em - 3.5px)}
  .notes b{font-weight:600;color:var(--ink)}
  .divider{border:0;border-top:1px solid var(--line-soft);margin:22px 0 18px}
  .admin ul.notes{margin-top:0}
  /* no part for everyone (an admin-only release): the admin part sits under
     the heading where the everyone list would be, with no divider */
  .admin.alone{margin-top:20px}

  /* the foot: one primary button, one quiet link, nothing else. The button is the
     sign-in door's `.card .act`; the link is the door's `.quietline`. */
  .foot{flex:none;display:flex;align-items:center;justify-content:space-between;gap:16px}
  .act{appearance:none;margin:0;font:600 .75rem var(--ui);color:#04060e;background:#d8b45a;
    border:0;border-radius:99px;padding:11px 30px;cursor:pointer;letter-spacing:.04em;line-height:normal;
    box-shadow:0 0 28px rgba(216,180,90,.22);transition:filter .35s ease}
  .act:hover{filter:brightness(1.08)}
  .act:focus-visible{outline:2px solid #f0f4fb;outline-offset:3px}
  .quiet{font:.75rem var(--mono);color:#8f9bb5;letter-spacing:.05em;padding:6px 4px;
    text-decoration:underline;text-underline-offset:3px;text-decoration-thickness:1px;
    text-decoration-color:rgba(216,180,90,.5);transition:color .3s ease}
  .quiet:hover{color:#f0f4fb}
  .quiet:focus-visible{outline:2px solid #d8b45a;outline-offset:3px;border-radius:4px}

  /* desk: a centred card */
  .wn-layer{align-items:center;justify-content:center;padding:24px}
  .card{width:100%;max-width:460px;max-height:calc(100vh - 48px);border-radius:16px}
  .scroll{padding:28px 28px 0}
  .foot{padding:22px 28px 28px}
  .quiet{margin-left:-4px}

  /* phone: a bottom sheet, the app's own (Sheet.svelte: 18px top corners, a
     36 x 4 handle in a 24px strip, scrim over the sky, foot stays in view, and
     its width rule: full width up to the pocket column, pocket/tokens.css
     --p-column; the sheet's 390 was its phone frame, not a cap) */
  @media (max-width: 839.98px), (max-height: 479.98px){
    .wn-scrim{background:rgba(4,7,16,.45)}
    .wn-layer{align-items:flex-end;justify-content:center;padding:0}
    .card{width:100%;max-width:var(--p-column);max-height:80vh;max-height:80dvh;
      border-radius:18px 18px 0 0;border-bottom:0;
      box-shadow:0 -18px 44px rgba(0,0,0,.45),inset 0 1px 0 rgba(255,255,255,.06),0 0 90px -40px rgba(216,180,90,.18) inset}
    .grab{display:flex;flex:none;height:24px;justify-content:center;padding-top:8px}
    .grab span{width:36px;height:4px;border-radius:2px;background:var(--line)}
    .scroll{padding:6px 22px 4px}
    .notes li{font-size:15px}
    .foot{flex-direction:column;align-items:stretch;gap:2px;
      padding:12px 22px calc(14px + env(safe-area-inset-bottom));border-top:1px solid var(--line-soft);
      background:rgba(6,10,22,.4)}
    .act{min-height:48px;width:100%}
    .quiet{display:flex;align-items:center;justify-content:center;min-height:44px;margin-left:0}
  }
  /* the phone sheet scrolls: a short fade at the foot says there is more */
  .scroll[data-more=true]{-webkit-mask-image:linear-gradient(to bottom,#000 calc(100% - 28px),transparent);mask-image:linear-gradient(to bottom,#000 calc(100% - 28px),transparent)}
</style>
