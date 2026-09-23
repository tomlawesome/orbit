/**
 * CHAPTER 9 — DONE (#866).
 *
 * The ratified mockup's ninth `CH` entry (design/v19/tour/round-5/f-one-take.html,
 * lines 983-1015), with the copy correction dated 2026-09-19 ("Second
 * correction", design/v19/tour/round-5/README.md): the closing line no
 * longer claims nothing on a sky is ever finished — the product itself
 * contradicts that (the item screen prints "one-off — does not come round"
 * for an expiry, web/src/routes/item/[[id]]/+page.svelte:546) — so it now
 * reads "A repeat is never finished; it comes round. A one-off simply
 * ends." verbatim.
 *
 * WHERE THE MOCKUP'S SCREENS LAND. `setBg("belt.png", true)` is the item
 * screen (web/src/routes/item/[[id]]/+page.svelte — by the owner's own
 * ruling "this surface IS the item screen", the file's own header comment)
 * reached here as `/item` with no id: the belt seats whichever record rides
 * at the apex, the same way the product always arrives at one. `setBg("home.png")`
 * is `/home`, same as every other chapter.
 *
 * THE CARD AND THE BUTTON. The mockup lights two things at once — the whole
 * card at a dim "on" tier, and the complete button at full "goto" strength —
 * because it is compositing a screenshot and can paste both without one
 * fighting the other. Translated the way chapter 2 already establishes
 * (`02-add.js`, its own card/field split): `light(card)` keeps the whole
 * record's hole cut for the width of the beat, and `goto(done)` is what
 * actually rises, glows and presses. Both are explicitly `unlight`ed before
 * `/home` is asked for — the mockup's own `cuts.innerHTML = ""` does the
 * same cleanup by throwing its whole overlay away; a real lit `Control`
 * cannot be thrown away like that, because its `els` point at a page about
 * to be torn down, so unlighting it here is what stands in for that reset.
 *
 * THE BUTTON HAS NO NAME OF ITS OWN. The product's five item actions
 * (complete, reschedule, snooze, edit, retire) are plain `<button>`s with no
 * class or id — nothing distinguishes "complete" from its siblings by
 * selector alone. What IS fixed is its position: first child of the item
 * actions group, in that order, whenever the record is active
 * (`+page.svelte`'s own markup order). `SELECTORS.done` names that position
 * rather than inventing a class the product does not render. On a record
 * that is not active the group's first child is "restore" instead — a real
 * control, just not the one the mockup means — which is the one honest gap
 * this translation leaves; noted rather than hidden.
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
 * keeps pace on its own. Unlike chapter 5, the mockup never raises the veil
 * for this walk (no `veil(true)` between `setBg("home.png")` and the
 * chapter's end), so it is never called here either: the swing back out
 * plays on the reader's own, undimmed sky.
 */
import { dialPlacement } from "../../data/chart.js";

const SVG_NS = "http://www.w3.org/2000/svg";

/** Ratified beat: the demo body walks from 16 days out (just completed) to
 *  381 (next year), over a fixed 2200ms after a 200ms lead-in — the
 *  mockup's own numbers, not data. */
const DAYS_NEAR = 16;
const DAYS_FAR = 381;
const WALK_MS = 2200;
const LEAD_MS = 200;

/**
 * Every element this chapter names, so
 * tests/unit/v19-tour-chapter-done.test.mjs can pin the real ones (`.item-card`,
 * the done button's position, `.dial`) against the item and home screens'
 * own markup. `.tourfilm-time-body` is not real markup — this chapter draws
 * and removes it itself — so it is pinned by running the chapter instead.
 */
export const SELECTORS = Object.freeze({
  /** The item screen's own card, whichever record rides at the apex. */
  card: ".item-card",
  /** The record's own complete action: first of the item's actions,
   *  whenever it is active (see the header note on why this cannot be a
   *  class or id instead). */
  done: '.acts[aria-label="Item actions"] button:first-child',
  /** The star chart, so the demo body has somewhere real to live. */
  dial: ".dial",
  /** The demo body this chapter draws and removes; never a real item. */
  body: ".tourfilm-time-body",
});

/** Eased 0..1, matching chapter 5's own (and the mockup's `walk`). @param {number} t */
function ease(t) {
  return 1 - Math.pow(1 - t, 3);
}

/**
 * @param {Document} doc
 * @param {Element} dial
 * @param {number} days
 */
function drawTimeBody(doc, dial, days) {
  const group = doc.createElementNS(SVG_NS, "g");
  group.setAttribute("class", "tourfilm-time-body");
  group.setAttribute("aria-hidden", "true");
  const dot = doc.createElementNS(SVG_NS, "circle");
  dot.setAttribute("class", "tourfilm-time-dot");
  dot.setAttribute("r", "5.5");
  dot.setAttribute("style", "fill:var(--accent)");
  group.appendChild(dot);
  dial.appendChild(group);
  positionTimeBody(group, days);
  return group;
}

/** @param {Element} group @param {number} days */
function positionTimeBody(group, days) {
  const { x, y } = dialPlacement(days);
  const dot = group.querySelector(".tourfilm-time-dot");
  if (!dot) return;
  dot.setAttribute("cx", String(x));
  dot.setAttribute("cy", String(y));
}

/** @type {import("./index.js").Chapter} */
export default {
  id: "done",
  name: "Done",

  /** @param {import("../vocabulary.js").FilmContext} ctx */
  async play(ctx) {
    const { setScreen, veil, ctl, goto, press, light, unlight, callout, dropCallout, tween, w, T, mark, dry, doc } = ctx;

    await setScreen("/item");
    veil(true);

    /* The whole card stays lit while the complete button is taught within it. */
    const card = ctl({ sel: SELECTORS.card, radius: 16, optional: true });
    light(card);

    const done = ctl({ sel: SELECTORS.done, radius: 10, optional: true });
    await goto(done);
    await callout(
      "MOT passed — mark it done and it swings back out to next year.",
      done,
      "left",
      { w: 240, mark: "done-complete" },
    );
    await press(done);
    dropCallout();
    unlight(done);
    unlight(card);

    /* Home again, undimmed: the item — drawn, never written — settles back
       out to next year in front of the reader. */
    await setScreen("/home");
    veil(false);

    const dial = ctl({ sel: SELECTORS.dial });
    let bodyEl = null;
    if (!dry() && dial.els[0]) bodyEl = drawTimeBody(doc, dial.els[0], DAYS_NEAR);
    await w(T.cross);
    await w(LEAD_MS);

    const body = ctl({ sel: SELECTORS.body, round: true, optional: true });
    light(body);
    await tween(WALK_MS, (t) => {
      if (dry() || !bodyEl) return;
      const days = Math.round(DAYS_NEAR + (DAYS_FAR - DAYS_NEAR) * ease(t));
      positionTimeBody(bodyEl, days);
      light(body);
    });
    await mark("done-swung");

    await goto(body, { willPress: false });
    await callout(
      "A repeat is never finished; it comes round. A one-off simply ends.",
      body,
      "top",
      { mark: "done-round" },
    );
    unlight(body);
    dropCallout();

    if (bodyEl) bodyEl.remove();
  },
};
