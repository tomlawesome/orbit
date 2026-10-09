/**
 * CHAPTER 9 — DONE (#866; re-anchored on home's drawer, #1319).
 *
 * The ratified mockup's ninth `CH` entry (design/v19/tour/round-5/f-one-take.html,
 * lines 983-1015), with the copy correction dated 2026-09-19 ("Second
 * correction", design/v19/tour/round-5/README.md). Its closing line,
 * "Renewals start their orbit again, fixed length items disappear.", is
 * the owner's own and stays verbatim (owner, 2026-10-08).
 *
 * WHERE IT OPENS (#1319, design/v19/tour-drawer/round-2/README.md and
 * round 1's "The handover to 09"). The belt's item screen is gone; the
 * chapter opens on `/home` with the item's drawer open, as chapter 8 leaves
 * it. On a cold jump the drawer is opened here the same way chapter 8 opens
 * it (`openItem`, without the body's press), and either way the page takes
 * the same `T.scroll` to bring it up, so the tick never depends on which.
 * The drawer is lit, and the dot goes to the drawer's own complete pill —
 * found by its own label (`Complete <title>`, FootRow.svelte), never by its
 * place among the pills. `press` only animates: nothing is completed. With
 * no item to open (a household with nothing in it) the line is said at the
 * sun, for the same length.
 *
 * Then the drawer is put away (`shut()`: the film's own Escape on the desk,
 * the row's own toggle on the pocket — whatever chapter 8 opened), the page
 * goes back to its top, undimmed, and the swing plays as it always has.
 *
 * THE SWING BACK OUT. No real record can be trusted to already be a
 * just-completed yearly MOT — a chapter must never depend on what is
 * actually on a household's dial — so, exactly as chapter 5 draws its own
 * due body rather than moving a real one, this chapter draws its own
 * `<g class="tourfilm-time-body">` into the real `.dial` svg and places it
 * every frame with the dial's own law, `dialPlacement(days)`
 * (web/src/lib/data/chart.js) — the same function chapter 5 uses, walked the
 * other way: 16 days out (just completed) to 381 (next year), rather than
 * 381 to 16. The node is drawn, moved, and removed; nothing is sent to the
 * database.
 *
 * THE TRAVELLING HOLE. This is one of the three chapters (5, 9, 12) whose
 * lit ring follows a moving target rather than sitting still (veil.js's own
 * comment names this chapter). As in chapter 5, `light(body)` is called
 * again on every tween frame purely to keep the ring synced to the body's
 * new box (`syncRings`, vocabulary.js) — the veil's own re-measure loop
 * keeps pace on its own. The veil is down for the walk: the swing back out
 * plays on the reader's own, undimmed sky.
 */
import { drawDemoBody, ease, positionDemoBody } from "./demo-body.js";
import { SELECTORS as ITEM, glide, itemBody, openItem, readyHome } from "./08-the-item.js";

/** Ratified beat: the demo body walks from 16 days out (just completed) to
 *  381 (next year), over a fixed 2200ms after a 200ms lead-in — the
 *  mockup's own numbers, not data. */
const DAYS_NEAR = 16;
const DAYS_FAR = 381;
const WALK_MS = 2200;
const LEAD_MS = 200;

/**
 * Every element this chapter names, so
 * tests/unit/v19-tour-chapter-done.test.mjs can pin the real ones against
 * home's own markup, desk and pocket. The drawer is chapter 8's (one table
 * for both chapters). `.tourfilm-time-body` is not real markup — this
 * chapter draws and removes it itself — so it is pinned by running the
 * chapter instead.
 */
export const SELECTORS = Object.freeze({
  DESK: Object.freeze({
    /** The open drawer, chapter 8's. */
    drawer: ITEM.DESK.drawer,
    /** The drawer's own complete pill, by its own label (FootRow.svelte's
     *  `aria-label="Complete {title}"`), never by its place. */
    done: `${ITEM.DESK.acts} button[aria-label^="Complete "]`,
    /** The star chart, so the demo body has somewhere real to live. */
    dial: ".dial",
    dialSvg: ".dial",
    /** The household's sun — where "MOT passed" is said with no drawer. */
    sun: ".sun-link",
    /** The demo body this chapter draws and removes; never a real item. */
    body: ".tourfilm-time-body",
  }),
  POCKET: Object.freeze({
    drawer: ITEM.POCKET.drawer,
    done: `${ITEM.POCKET.acts} button[aria-label^="Complete "]`,
    /** The round dial. */
    dial: ".pocket .mdial",
    /** Its own `<svg>` — the demo body's real append target (§3.6). */
    dialSvg: ".pocket .mdial svg",
    /** This household's own sun — the sky line's anchor (§3.3). */
    sun: ".pocket .mdial .pk-sun",
    /** The demo body this chapter draws and removes; never a real item. */
    body: ".tourfilm-time-body",
  }),
});

/**
 * @param {Document} doc
 * @param {Element} dial
 * @param {number} days
 */
function drawTimeBody(doc, dial, days) {
  return drawDemoBody(doc, dial, days, "tourfilm-time-body", "tourfilm-time-dot");
}

/** @param {Element} group @param {number} days */
function positionTimeBody(group, days) {
  positionDemoBody(group, days, "tourfilm-time-dot");
}

/** @type {import("./index.js").Chapter} */
export default {
  id: "done",
  name: "Done",

  /** @param {import("../vocabulary.js").FilmContext} ctx */
  async play(ctx) {
    const {
      pocket, setScreen, veil, ctl, goto, press, light, unlight, callout, dropCallout, tween, w, T, mark, dry, doc,
      shut, room,
    } = ctx;
    const S = pocket ? SELECTORS.POCKET : SELECTORS.DESK;

    await setScreen("/home");
    /* Played on from chapter 8 the drawer is open, veiled and lit; on a
       cold jump it is opened here, on the sky as the reader left it. */
    if (dry() || !doc.querySelector(S.done)) veil(false);
    await readyHome(ctx);
    await openItem(ctx, itemBody(ctx));
    veil(true);

    /* The drawer stays lit while its complete pill is taught: chapter 8's
       own ring, where it left one, else this chapter's. */
    const left = ctx.lit?.().find((c) => c.sel === S.drawer);
    const drawer = left ?? ctl({ sel: S.drawer, all: true, radius: 16, optional: true });
    light(drawer);
    const done = ctl({ sel: S.done, radius: pocket ? 22 : 16, pad: 2, optional: true });
    const sun = ctl({ sel: S.sun, round: true, optional: true });
    await goto(done);
    await callout(
      "MOT passed — mark it done and it swings back out to next year.",
      done.els.length > 0 ? done : sun,
      pocket ? "top" : "bottom",
      { w: 240, mark: "done-complete" },
    );
    await press(done);
    dropCallout();
    unlight(done);
    unlight(drawer);

    /* Home again, undimmed: the drawer put away, the page at its top, and
       the item — drawn, never written — settles back out to next year in
       front of the reader. */
    await shut();
    veil(false);
    await glide(ctx, 0);
    room(0);

    const dialSvg = ctl({ sel: S.dialSvg });
    let bodyEl = null;
    if (!dry() && dialSvg.els[0]) bodyEl = drawTimeBody(doc, dialSvg.els[0], DAYS_NEAR);
    await w(T.cross);
    await w(LEAD_MS);

    const body = ctl({ sel: S.body, round: true, optional: true });
    light(body);
    await tween(WALK_MS, (t) => {
      if (dry() || !bodyEl) return;
      const days = Math.round(DAYS_NEAR + (DAYS_FAR - DAYS_NEAR) * ease(t));
      positionTimeBody(bodyEl, days);
      light(body);
    });
    await mark("done-swung");

    /* "A repeat is never finished..." — a sky line on the pocket (§3.3):
       anchored to the sun, not the body. */
    await goto(body, { willPress: false });
    if (pocket) {
      await callout(
        "Renewals start their orbit again, fixed length items disappear.",
        sun,
        "bottom",
        { dy: 30, mark: "done-round" },
      );
    } else {
      await callout(
        "Renewals start their orbit again, fixed length items disappear.",
        body,
        "top",
        { mark: "done-round" },
      );
    }
    unlight(body);
    dropCallout();

    if (bodyEl) bodyEl.remove();
  },
};
