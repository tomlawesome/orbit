/**
 * CHAPTER 4 — BELOW THE DIAL (#866).
 *
 * The ratified mockup's fourth `CH` entry
 * (design/v19/tour/round-5/f-one-take.html, lines 715-767), id `"manifest"`,
 * cut the same way chapter 1 sets out in 01-arrive.js: `{ id, name, play }`,
 * the vocabulary's words only, no pixel coordinate.
 *
 * WHAT THIS CHAPTER TEACHES. The manifest — the real corridor of what's
 * ahead, read top to bottom below the dial — and that it keeps the same law
 * the dial itself does (nearest first), in a different geometry. Both lines
 * and the manifest's own target are the ratified "manifest" stop
 * (web/src/lib/tour/stops.js), which is where this copy and `#manifest-top`
 * were already ratified for the eight-stop walk this film replaces.
 *
 * THE SCROLL. The mockup fakes scrolling by translating a screenshot of the
 * whole scrollable strip (`scrollImg`) because it has no real page under it.
 * The product's manifest genuinely sits below the fold, so this chapter
 * scrolls the real page to it and back with the DOM's own `scrollIntoView` —
 * MEASURED off the live element, the same way every other geometry in this
 * module is, never a written-down offset — timed by `T.scroll`, the
 * vocabulary's own constant for exactly this move ("the page scrolls to the
 * manifest and back"). Neither `goto` nor `travel` scrolls on their own, so
 * nothing else in the vocabulary would have brought the manifest into view;
 * this is the one place a chapter reaches past `ctl()`'s own element to call
 * a plain DOM method on it, the same license chapter 5 takes to place its own
 * demo body.
 *
 * WHAT drawBody AND THE FIXED ORBS BECOME: nothing. The mockup's own
 * `drawBody(381)` redraws a demo body on the dial this chapter never points
 * at or names — carried over from the previous screenshot purely so the
 * frame doesn't look bare — and its three `mkCut` orbs are redrawn on top of
 * the scrolling screenshot only because the screenshot would otherwise carry
 * them off with it. The product's account orb and inbox orb are genuinely
 * `position: fixed` chrome, so a real scroll already leaves them exactly
 * where they are; there is nothing here to reproduce.
 *
 * A CHAPTER NEVER BRANCHES ON DATA. `today` and `row` are `optional: true`:
 * a household with a fully empty sky renders neither (+page.svelte's
 * `{#if corridor && !view?.emptySky}` wraps both), where `#manifest-top`
 * itself always renders. `goto` and `callout` already spend their fixed beat
 * whether or not a control matches (vocabulary.js's `travel`, `callout`), so
 * this chapter's length — one of the film's three measured, jumped-to ticks
 * (chapters 4, 8, 11: the transport places a tick at every chapter's start,
 * and reads it off a dry run before a frame plays) — holds the same whether
 * the manifest is full, thin, or empty.
 */

/**
 * Every element this chapter names, in one place, so
 * tests/unit/v19-tour-chapter-below-the-dial.test.mjs can pin them against
 * home's real markup (desk) and pocket.svelte's (pocket).
 */
export const SELECTORS = Object.freeze({
  DESK: Object.freeze({
    /** The manifest column itself — always rendered, and the ratified
     *  "manifest" stop's own target (stops.js). */
    manifest: "#manifest-top",
    /** The manifest's own "TODAY ·" header row. */
    today: "#manifest-top .today",
    /** One manifest row, real item or suggestion, whichever sits first — the
     *  law read out applies to either. */
    row: "#manifest-top .item",
  }),
  POCKET: Object.freeze({
    /** The manifest column, pocket.svelte's own. */
    manifest: ".pocket .pk-below",
    /** Its own caption header, first if there is more than one group. */
    today: ".pocket .pk-below h2.p-caps",
    /** One manifest row, whichever sits first. */
    row: ".pocket .pk-below .p-row",
  }),
});

/** The mockup's own lead-in before the scroll begins, verbatim. */
const SCROLL_LEAD_MS = 400;

/** #1174 round 4: the clear space between the top chrome's foot and the
 *  manifest's own top once the pocket page has scrolled to it — the kit's
 *  12px, the same margin a pocket field keeps under the chrome
 *  (EntryForm.svelte's `scroll-margin-top`). */
const LAND_GAP = 12;

/** @type {import("./index.js").Chapter} */
export default {
  id: "manifest",
  name: "Below the dial",

  /** @param {import("../vocabulary.js").FilmContext} ctx */
  async play(ctx) {
    const { pocket, setScreen, veil, ctl, goto, unlight, callout, dropCallout, mark, w, tween, room, T, dry, doc } = ctx;
    const S = pocket ? SELECTORS.POCKET : SELECTORS.DESK;

    await setScreen("/home");
    veil(false);

    /* The page scrolls down to the manifest — for real, since it genuinely
       sits below the fold here. Nothing on the pocket home is fixed except
       the top chrome, which retracts on scroll on its own (#1083 §6). */
    const manifest = ctl({ sel: S.manifest });
    await w(T.cross);
    await w(SCROLL_LEAD_MS);
    await glide(manifestTop());
    await mark("manifest-scrolled");

    veil(true);

    /* "The manifest lists what's ahead, nearest first." — its own header. */
    const today = ctl({ sel: S.today, radius: 8, optional: true });
    await goto(today, { willPress: false });
    await callout("The manifest lists what's ahead, nearest first.", today, "left", {
      w: 196,
      mark: "manifest-today",
    });
    unlight(today);

    /* "Same law as the dial..." — one row, whichever sits first. */
    const row = ctl({ sel: S.row, radius: 14, optional: true });
    await goto(row, { willPress: false });
    await callout(
      "Same law as the dial, read top to bottom instead of round the ring.",
      row,
      "left",
      { mark: "manifest-row" },
    );
    unlight(row);
    dropCallout();

    /* And back up, the sky in view again for the next chapter. */
    veil(false);
    await w(T.cross);
    await glide(0);
    room(0);
    await w(T.cross);

    /* THE SCROLL RUNS ON THE FILM'S CLOCK (#1174). It used to be the page's
       own smooth scroll (`scrollIntoView` / `scrollTo` with behavior "auto",
       which home's `html{scroll-behavior:smooth}` makes a real-time glide the
       clock never saw): the return to the top was found still at the
       manifest when chapter 5 began, its walking body off the top of the
       screen, and the veil and rings measured the page mid-glide. A tween
       over the same `T.scroll` spends the same budget, pauses with the film,
       lands at once under reduced motion (the same "jump, like every other
       motion" home.css gives the page), and is where it says it is when the
       next beat measures. Each frame is an instant scroll, so the page's own
       smooth behaviour cannot stretch it. */
    /* WHERE IT LANDS (#1174 round 4). On the owner's iPhone the page did
       not go to the manifest: the pocket home is barely taller than the
       phone, so the scroll stopped at the page's own end — 149px at
       430x932 on the fixture, less on a real household — and the manifest
       stayed low on the screen, where it already was. On the pocket the
       manifest's top now lands just under the top chrome's full height
       (the chrome slides away as the page goes down and back on any
       scroll up, so the header is clear of it either way), and where the
       page is too short to get it there, the film makes the room below it
       (`room`), taken away again once the page is back at its top. The
       desk keeps its own long page and its old aim. */
    function manifestTop() {
      if (dry()) return 0;
      const el = manifest.els[0];
      const view = doc.defaultView;
      if (!el || !view) return 0;
      const chrome = pocket ? doc.querySelector(".p-chrome") : null;
      const clear = chrome instanceof HTMLElement ? chrome.offsetHeight + LAND_GAP : 0;
      const want = Math.max(0, view.scrollY + el.getBoundingClientRect().top - clear);
      const most = Math.max(0, doc.documentElement.scrollHeight - view.innerHeight);
      if (!pocket) return Math.min(most, want);
      if (want > most) room(want - most);
      return want;
    }
    /** @param {number} top */
    function glide(top) {
      const view = doc.defaultView;
      const from = dry() || !view ? 0 : view.scrollY;
      return tween(T.scroll, (t) => {
        if (dry() || !view) return;
        view.scrollTo({ top: from + (top - from) * t, behavior: "instant" });
      });
    }
  },
};
