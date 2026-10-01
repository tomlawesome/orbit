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

/**
 * #1174 round 5: THE FILM'S OWN EXAMPLE MANIFEST. On the owner's iPhone
 * chapter 4 brought the manifest up the screen and it was empty: a new
 * household has nothing in it, and no first-run data is seeded, so both
 * lines pointed at blank sky. The ratified pocket one-take
 * (design/v19/tour/round-8/g-pocket.html, shot 04-below.png) holds three rows
 * under NEEDS ATTENTION at this mark. So where the pocket manifest has no
 * row of its own, the film stages these, the way chapters 3, 5, 9 and 12
 * draw their own bodies on the dial:
 *
 *  - only on a phone whose manifest has no row, and only for this chapter;
 *  - each says what it is — the word "example", in the accent, opens its
 *    meta line — and wears the real row's solid hairline, never the dashed
 *    pen, which on the pocket means a suggestion;
 *  - nearest first, as the line it illustrates says: overdue, then two
 *    coming up, the mockup's own three;
 *  - drawn into the page and never sent anywhere: it is gone when the
 *    chapter ends, and on a jump or a stop (`data-tourfilm-staged`, which
 *    the film's `clear()` sweeps).
 *
 * `days` is from today; negative is overdue. `tone` is the band's token, as
 * home's own rows colour their dot and countdown (pocket.svelte's BAND_VAR).
 */
export const EXAMPLE_ROWS = Object.freeze([
  Object.freeze({ title: "Gutter clearing", cost: "£150.00", days: -16, tone: "--overdue" }),
  Object.freeze({ title: "Car MOT — Volvo V60", cost: "£54.85", days: 16, tone: "--warm" }),
  Object.freeze({ title: "Boiler service", cost: "£120.00", days: 22, tone: "--warm" }),
]);

/** What the staged manifest is named by, so the chapter can point at it. */
export const EXAMPLE = Object.freeze({
  today: ".pocket .pk-below .tourfilm-example h2",
  row: ".pocket .pk-below .tourfilm-example-row",
});

/** @param {number} days */
function countdown(days) {
  return days < 0 ? `T+${-days}d` : `T−${days}d`;
}

/** The date `days` from today, as home's rows print one (pocket.svelte's
 *  `short`). @param {number} days */
function shortDate(days) {
  return new Date(Date.now() + days * 86_400_000)
    .toLocaleDateString("en-GB", { day: "2-digit", month: "short", timeZone: "UTC" });
}

/**
 * Draws the example manifest at the top of the pocket's own manifest column,
 * in the row grammar of Row.svelte (whose styles are scoped to it, so they
 * are written here, in the kit's own tokens — no colour or size is new).
 *
 * @param {Document} doc
 * @param {Element} column  `.pocket .pk-below`
 */
function stageExample(doc, column) {
  /** @param {string} tag @param {string} css @param {string} [text] */
  const el = (tag, css, text) => {
    const node = doc.createElement(tag);
    if (css) node.style.cssText = css;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const block = el("div", "");
  block.className = "tourfilm-example";
  block.setAttribute("data-tourfilm-staged", "");
  /* The film's lines say what this is; the rows are a picture of it. */
  block.setAttribute("aria-hidden", "true");
  const head = el("h2", "", "Needs attention");
  head.className = "p-caps";
  const list = el("div", "display:flex;flex-direction:column;gap:6px");
  for (const one of EXAMPLE_ROWS) {
    const row = el("div", "position:relative;border:1px solid var(--line-soft);border-radius:12px;overflow:clip;pointer-events:none");
    row.className = "tourfilm-example-row";
    const face = el("div", [
      "display:flex", "align-items:center", "gap:var(--p-row-gap)", "box-sizing:border-box",
      "min-height:var(--p-row-min)", "padding:6px var(--p-gutter)", "color:var(--ink)",
    ].join(";"));
    const mark = el("span", "flex:none;width:var(--p-row-mark);display:grid;place-items:center");
    mark.append(el("span", `display:block;width:10px;height:10px;border-radius:50%;background:var(${one.tone})`));
    const text = el("span", "flex:1;min-width:0;display:flex;flex-direction:column;gap:2px");
    text.append(el("span", "font:500 var(--p-type-body)/1.3 var(--ui);color:var(--ink);white-space:nowrap;overflow:hidden;text-overflow:ellipsis", one.title));
    const meta = el("span", "font:var(--p-type-meta)/1.4 var(--mono);color:var(--ink-quiet);white-space:nowrap;overflow:hidden;text-overflow:ellipsis");
    meta.append(el("span", "color:var(--accent-text)", "example"), ` · ${one.cost}`);
    text.append(meta);
    const trail = el("span", `flex:none;text-align:right;font:500 var(--p-type-meta)/1.3 var(--mono);color:var(${one.tone})`, countdown(one.days));
    trail.append(el("small", "display:block;font-size:var(--p-type-meta);color:var(--ink-quiet);font-weight:400", shortDate(one.days)));
    face.append(mark, text, trail);
    row.append(face);
    list.append(row);
  }
  block.append(head, list);
  column.prepend(block);
  return block;
}

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
    const { pocket, setScreen, veil, ctl, goto, unlight, callout, dropCallout, mark, w, tween, room, animate, T, dry, doc } = ctx;
    const S = pocket ? SELECTORS.POCKET : SELECTORS.DESK;

    await setScreen("/home");
    veil(false);

    /* #1174 round 5: a pocket manifest with no row of its own gets the
       film's example rows (EXAMPLE_ROWS, above), faded in with the page
       still at its top, before the scroll measures where to go. */
    const column = pocket && !dry() ? doc.querySelector(S.manifest) : null;
    const staged = column && !column.querySelector(".pk-list .p-row") ? stageExample(doc, column) : null;
    if (staged) void animate(staged, [{ opacity: 0 }, { opacity: 1 }], { duration: T.cross, easing: "ease-out" });
    const P = staged ? { ...S, ...EXAMPLE } : S;
    /* The page scrolls down to the manifest — for real, since it genuinely
       sits below the fold here. Nothing on the pocket home is fixed except
       the top chrome, which retracts on scroll on its own (#1083 §6). */
    const manifest = ctl({ sel: S.manifest });
    try {
      await w(T.cross);
      await w(SCROLL_LEAD_MS);
      await glide(manifestTop());
      await mark("manifest-scrolled");

      veil(true);

      /* "The manifest lists what's ahead, nearest first." — its own header. */
      const today = ctl({ sel: P.today, radius: 8, optional: true });
      await goto(today, { willPress: false });
      await callout("The manifest lists what's ahead, nearest first.", today, "left", {
        w: 196,
        mark: "manifest-today",
      });
      unlight(today);
      /* Owner's cut (2026-10-01, #1174): the second line, "Same law as the
         dial, read top to bottom instead of round the ring.", is gone. */
      dropCallout();

      /* And back up, the sky in view again for the next chapter. */
      veil(false);
      await w(T.cross);
      await glide(0);
      room(0);
      if (staged) void animate(staged, [{ opacity: 1 }, { opacity: 0 }], { duration: T.cross, easing: "ease-in", fill: "forwards" });
      await w(T.cross);
    } finally {
      /* At the chapter's end, and on a jump or a stop (the CANCEL that
         unwinds this coroutine); `clear()` sweeps it as well. */
      staged?.remove();
    }

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
