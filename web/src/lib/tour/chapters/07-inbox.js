/**
 * CHAPTER 7 — INBOX (#866).
 *
 * The mockup's seventh `CH` entry (design/v19/tour/round-5/f-one-take.html,
 * lines 823-876), translated by chapter 1's own rules: `{ id, name, play }`,
 * the vocabulary's words only, coordinates become selectors, no branch on
 * data.
 *
 * WHERE THE MOCKUP'S SCREENS LAND. The mockup returns from "relay.png" to
 * "home.png" before it does anything, purely to smooth its own screenshot
 * seam. Every chapter here already opens on `/home` with the veil down
 * (chapter 1's own rule), so that return needs no translation of its own —
 * this chapter's first two lines are the same two lines every other chapter
 * opens with.
 *
 * THE DOOR. The mockup presses a cropped rectangle of "home.png" at a
 * hard-coded box. The product's real door is home's own inbox orb — `a.orb
 * .inbox-orb` (web/src/routes/home/+page.svelte), unconditionally rendered,
 * distinct from the account orb chapter 11 opens (`button.orb`, no
 * `inbox-orb` class) and from chapter 2's `#nstar`. Pressing it in the
 * mockup leads straight to "inbox.png"; here `press()` only animates (it
 * never dispatches a click, same rule chapter 11 states), so this chapter
 * calls `setScreen("/inbox")` itself once the press has played, the same
 * shape chapter 2 uses for `#nstar` leading to `/create`. The veil, raised
 * just before the orb is approached, is never lowered again before the
 * lanes are read out — the same "veil stays down once it's up" rule chapter
 * 2's own header states, so the lanes arrive already dimmed for goto to cut
 * holes in.
 *
 * THE THREE LANES. inbox/+page.svelte (built #472/§14) renders exactly three
 * sibling `<div class="lane">`s inside `.lanes`, always in this order: Filed
 * (the only one with its own class, `.lane.filed`), the review lane, and the
 * reading/failed lane — the latter two share the plain `.lane` class with
 * nothing else to tell them apart, because nothing in the product ever needs
 * to address them individually outside this chapter. `:nth-of-type` picks
 * them out by that fixed DOM order instead of inventing a class the product
 * has no other use for.
 *
 * WHAT #1046 IS AND WHY IT IS NOT USED HERE. An older, superseded build of
 * this tour (the ten-beat film, design rounds 1-2) drove `stage.js`'s
 * `drawInboxReviewCard`, which needed a `.lane` to exist even on a household
 * with a truly empty inbox — gitlab.tomlawson.io/ai/orbit#1046 added exactly
 * that (`.lanes.lanes-tourhook`, three empty lanes) to serve it. That commit
 * (e78c7039) is not an ancestor of this branch: this one-take film's inbox
 * route renders NO `.lanes` at all when the queue is genuinely empty (filed
 * is empty and review/reading/failed are all empty) — it falls straight to
 * the `.quietnote` empty state instead. Checked directly against
 * web/src/routes/inbox/+page.svelte on this branch. So every lane control
 * below, and the "add" button inside the review lane, is marked `optional`
 * rather than reached for #1046's hook: a household with nothing waiting
 * plays the same beats, for the same length, with nothing lit for any of
 * them — chapter 1's own rule for a household alone in its sky, applied
 * here to a household alone in its inbox.
 *
 * THE "ADD" BUTTON. The mockup presses a demo review card's own "Add to
 * orbit" button. The real one is `.receipt .actions button.yes`
 * (web/src/routes/inbox/+page.svelte) — real markup, but only rendered
 * inside a real, unreviewed receipt, so it is `optional` for the same reason
 * the lanes are: this chapter must never write "if there's something to
 * review" and must never fabricate one. The mockup's own subtlety of holding
 * the whole review-lane card visible (`card.classList.add("on")`) before
 * the button is pressed has no separate primitive in this vocabulary — cuts
 * are lighting (vocabulary.js's own note) — so it is played as `light(review)`
 * around the same beat, the way chapter 1 lights the outer suns as a group
 * before chapter 1's centre line.
 */

/**
 * Every element this chapter names, in one place, so
 * tests/unit/v19-tour-chapter-inbox.test.mjs can pin them against home's and
 * the inbox route's real markup (desk) and pocket.svelte's/
 * `routes/inbox/pocket.svelte`'s (pocket).
 */
export const SELECTORS = Object.freeze({
  DESK: Object.freeze({
    /** Home's own door to the inbox — always rendered, mail waiting or not. */
    orb: ".inbox-orb",
    /** What the relay has already turned into orbit items. */
    filed: ".lanes .lane.filed",
    /** Arrivals waiting on a member's own say-so — the middle of the three,
     *  addressed by DOM position since nothing else names it. */
    review: ".lanes .lane:nth-of-type(2)",
    /** Still being read, or failed outright — the third of the three. */
    reading: ".lanes .lane:nth-of-type(3)",
    /** The one real "add to orbit" control, inside whichever receipt is
     *  waiting for review; absent on a household with nothing pending. */
    add: ".receipt .actions button.yes",
  }),
  POCKET: Object.freeze({
    /** Home's own account orb — opens the hatch. */
    orb: "#morb",
    /** Any open sheet's own panel, lit `ringless` (§3.5). */
    panel: ".p-sheet-layer.open .p-sheet-panel",
    /** The hatch's own "Inbox" row. */
    inboxLink: '.p-sheet-layer.open [data-row-face][href$="/inbox"]',
    /** The three lanes, in the pocket page's own order (review, reading,
     *  filed) — round 8's re-cut, §6. */
    review: '.pki-lane[aria-labelledby="pki-review-h"]',
    reading: '.pki-lane[aria-labelledby="pki-reading-h"]',
    filed: '.pki-lane[aria-labelledby="pki-filed-h"]',
    /** The one real "add to orbit" control (ReviewCard.svelte's ArmButton). */
    add: ".pki-lane .rv-yes",
  }),
});

/** @type {import("./index.js").Chapter} */
export default {
  id: "inbox",
  name: "Inbox",

  /** @param {import("../vocabulary.js").FilmContext} ctx */
  async play(ctx) {
    const { pocket, setScreen, veil, ctl, goto, press, light, unlight, callout, dropCallout, mark, open, close, w, T } = ctx;
    const S = pocket ? SELECTORS.POCKET : SELECTORS.DESK;

    await setScreen("/home");
    veil(false);

    /* Home's own door to the inbox, dimmed down to it before it's touched.
       On the pocket the door is the account hatch's own "Inbox" row. */
    const orb = ctl({ sel: S.orb, round: true });
    veil(true);
    await goto(orb);
    await callout(
      "Mail lands here first — filed, waiting for review, or still being read.",
      orb,
      "left",
      { mark: "inbox-orb" },
    );
    await press(orb);
    if (pocket) {
      unlight(orb);
      open(orb);
      await w(T.sheet);
      const panel = ctl({ sel: SELECTORS.POCKET.panel, ringless: true });
      light(panel);
      const inboxLink = ctl({ sel: SELECTORS.POCKET.inboxLink, radius: 10 });
      await goto(inboxLink);
      await press(inboxLink);
      unlight(inboxLink);
      unlight(panel);
      await close();
    } else {
      unlight(orb);
    }
    await setScreen("/inbox");

    /* The three lanes, read out by name. Desk order: filed, review, reading
       (the mockup's own). Pocket order: review, reading, filed — the page's
       own order (#1083 §6), one scroll down; the labels are pictures, not
       script, so the transcript is unchanged either way. A household with
       nothing waiting has no lanes at all, so every one of these is
       optional: the same beats play, nothing lights. */
    /** @type {{ id: string, label: string, sel: string, side: "left" | "right" | "top" | "bottom" }[]} */
    const lanes = pocket
      ? [
          { id: "review", label: "For your review", sel: S.review, side: "bottom" },
          { id: "reading", label: "Still reading", sel: S.reading, side: "top" },
          { id: "filed", label: "Filed", sel: S.filed, side: "bottom" },
        ]
      : [
          { id: "filed", label: "Filed", sel: S.filed, side: "bottom" },
          { id: "review", label: "For your review", sel: S.review, side: "bottom" },
          { id: "reading", label: "Still reading", sel: S.reading, side: "top" },
        ];
    for (const lane of lanes) {
      const c = ctl({ sel: lane.sel, radius: pocket ? 16 : 14, optional: true });
      await goto(c, { willPress: false });
      await callout(lane.label, c, lane.side, { label: true, hold: 1500, mark: `inbox-lane-${lane.id}` });
      dropCallout();
      unlight(c);
    }
    await mark("inbox-lanes");

    /* The one real "add to orbit" control — the review lane held lit around
       it, the way chapter 1 lights the outer suns as a group. Both are
       optional: a household with nothing to review plays this beat with
       nothing lit, never a different beat. */
    const review = ctl({ sel: S.review, radius: pocket ? 16 : 14, optional: true });
    light(review);
    const add = ctl({ sel: S.add, radius: pocket ? 22 : 10, optional: true });
    await goto(add);
    await press(add);
    await mark("inbox-add");
    await callout("Nothing joins your orbit without your say-so.", add, "right", { mark: "inbox-sayso" });
    unlight(add);
    unlight(review);
    dropCallout();
  },
};
