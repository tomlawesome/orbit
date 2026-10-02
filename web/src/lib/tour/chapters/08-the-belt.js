/**
 * CHAPTER 8 — THE BELT (#866, round 6's re-cut, #1093).
 *
 * Round 5's chapter 8 is retired outright (design/v19/tour/round-5/README.md
 * says why: the belt changed underneath it twice, #1062 and #1088). This
 * file is cut from round 6 (design/v19/tour/round-6/README.md), copied
 * verbatim where round 6's own choreography could be built against real
 * markup, and translated — never invented — everywhere it could not. Three
 * translations go beyond a plain coordinate-to-selector swap, and are
 * recorded here because a reviewer holding round 6 beside this file needs to
 * know they are deliberate, not missed:
 *
 * 1. BEAT 1'S PRESS DOES NOT NAVIGATE. Round 6 keeps round 5's beat 1
 *    unchanged: "the dot travels to the Volvo's body, lifts it, presses; the
 *    item screen crossfades in." On the shipped home screen a body's own
 *    `.body-link` press does not do that — #424 (owner ruling, 2026-08-16)
 *    made the manifest row itself the item's destination in place, and
 *    `/item/<id>` (#455's full-command surface, what this chapter needs) is
 *    only reached from inside that opened row, via its own "manage this item
 *    →" link. `.body-link`'s click is unbound beyond a hover tooltip; its
 *    href is a bare same-page anchor. So this chapter presses the real body
 *    for the gesture — exactly the license chapter 2 already takes with
 *    `#nstar`, which opens a drawer this film never renders either — and
 *    then names the screen the full journey leads to: `setScreen("/item")`,
 *    the belt's own front door with no id (#1014, `+page.js`), which
 *    redirects to whichever item is soonest due and therefore never
 *    branches this chapter on what a household actually holds.
 *
 * 2. THE READING CARD IS DRAWN, FOR REAL, BY THE ONE CLICK IN THIS FILM.
 *    #1088 landed on this branch (the document preview), so `aside#readcard`
 *    now exists to open. `press()` (vocabulary.js) still only ever animates
 *    a scale, exactly as 11-your-sky.js's own swatch press and 03-lands.js,
 *    07-inbox.js and 10-other-households.js all restate for their own
 *    controls — but that rule is about MUTATION, not about clicking as
 *    such, and a paper's click is not in the class it guards against. A
 *    swatch's click runs `setSwatch` (`localStorage` and a server
 *    preference — why `wear()` reimplements the visual instead of clicking
 *    at all) and the reading card's own restore button runs
 *    `restoreDocument`, a real server write. A paper's click runs neither:
 *    `openDoc` (belt.behaviour.js) sets a class on its own seat and the
 *    screen's own view state (`previewIdx`, `previewDoc`) — no
 *    `localStorage`, no address-bar change (that is `centre`'s, and a
 *    document's press never reaches `centre`), no server request. So this
 *    beat presses the papers for the gesture as every other beat does, then
 *    hands vocabulary.js's new `read()` the real hit and lets it dispatch
 *    the one genuine click this film ever makes — safe because nothing it
 *    triggers persists. `unread()` closes it again, on the belt's own step
 *    (round 6's beat 4) and, as a safety net, wherever `unwear()` is —
 *    `clear()`, so a skip or a finish never leaves a card open. Neither word
 *    reaches into the belt or the item screen beyond the click and the
 *    Escape a reader's own hand would make: the tour/product boundary stays
 *    one-way, exactly as it is everywhere else in this file.
 *
 * 3. THE TWO PAPERS ARE NEVER TWO SPECIFIC DOCUMENTS, AND WHAT RINGS IS THE
 *    PAPER, NOT ITS NAME. Round 6 names a certificate and a service history
 *    because its worked example has both. A chapter must not branch on what
 *    is actually attached to whatever item `/item` seats — zero, one or
 *    several — so "the two ringed papers" is every real paper currently out
 *    on the belt, lit together, `all: true, optional: true`, the same
 *    `optional` idiom 01-arrive.js uses for the other households' suns. This
 *    file's own first cut rang `.doclabel`, the document's file-name caption
 *    — the one class the shipped markup gives a document that an item never
 *    wears (it is #1062's, not #1088's). The owner's review of the cut film
 *    (#1174 round 9, 2026-10-02): the file name is the least interesting
 *    thing about a document, and odd to be the one thing lit. `docBody`
 *    rings the paper's own rock instead — the same `g.hit` `read()` already
 *    presses (point 2, above), picked out by belt.behaviour.js's own
 *    aria-label and, unlike `docHit`'s "whichever is first", filtered to
 *    `[aria-hidden="false"]` so a paper still folded inside its item, or
 *    rolled off the pocket's sky (`offSky`, belt.behaviour.js), never rings
 *    either — the same signal `docHitOut` already reads for which paper to
 *    open. The caption stays on screen, under the body it names, unlit.
 *
 * WHAT SURVIVES UNCHANGED FROM ROUND 6. The end-caps are real controls
 * (#1062) and this chapter drives them exactly as named: `sel` is the
 * `text.endcap` ink (what visually lifts and presses), `ring` is the
 * `rect.endtarget` hit box (what the glow actually wraps) — the split
 * vocabulary.js's own `ControlSpec.ring` doc calls out by naming this very
 * chapter. `data-step="1"` is `later →`; `data-step="-1"` is `← sooner`
 * (belt.behaviour.js's own table, unchanged by #1094). Both end-caps are
 * `optional: true` — a household whose seated item sits at either end of its
 * own manifest shows one already spent, and the chapter must play the same
 * either way.
 *
 * #1094, ALREADY SETTLED. The owner ruling that end-caps and arrow keys step
 * item to item and never onto a document (2026-09-23) is not a conflict with
 * anything this chapter assumes: round 6's own beat 4 already only ever
 * steps between neighbouring ITEMS, never onto a paper, so nothing here
 * needed to change for it. Confirmed against band.js's `stepFrom`, which
 * filters `kind !== "doc"` before either end-cap's disabled state or this
 * chapter's press is ever asked to reason about where a step lands.
 *
 * THE TICK. This chapter is one of the three the transport measures a jump
 * to (4, 8, 11), so — same rule 01-arrive.js states for the whole registry —
 * it opens exactly like a chapter played from a cold jump: its own
 * `setScreen`/`veil(false)` first, never assuming the previous chapter left
 * the screen the way this one wants it. Every control that might not exist
 * is `optional`, so the beats cost the same fixed time whether the seated
 * item carries no papers, one, or several, and whichever end is spent.
 */

/**
 * Every element this chapter names, so
 * tests/unit/v19-tour-chapter-the-belt.test.mjs can pin them against the
 * belt's real markup (web/src/routes/item/[[id]]/+page.svelte,
 * belt.behaviour.js), home's own (`.body-link`/`.pk-body`) and pocket.svelte's
 * `itemActs`/Row.svelte's `data-row-acts`.
 *
 * #1083 (round 8's re-cut, owner's 2c): most of these are the SAME selectors
 * on both dialects — the belt's own markup (papers, end-caps) does not
 * change shape for the pocket — so only the desk-only and pocket-only
 * entries are named twice.
 */
export const SELECTORS = Object.freeze({
  DESK: Object.freeze({
    /** The seated household's own body on the dial — round 6's "the Volvo",
     *  whichever real item happens to be first in DOM order. */
    body: ".body-link",
    /** A body that carries documents (#1174 round 6): home's own count. */
    bodyWithPapers: ".body-link[data-docs]",
    /** The household's sun — where the lines are read when no body carries
     *  a paper (#1174 round 6). */
    sun: ".sun-link",
    /** Every paper's own body — the rock `drawRock()` paints inside its
     *  `.hit` (belt.behaviour.js) — currently riding the belt beside the
     *  apex item: round 6's "two ringed papers", generalised to however many
     *  there are, ringing the paper itself rather than its file-name
     *  caption (#1174 round 9, the owner's call: point 3, above).
     *  `[aria-hidden="false"]` is belt.behaviour.js's own say for "this one
     *  is actually out". */
    docBody: 'g.hit[aria-label*="a document attached to"][aria-hidden="false"]',
    /** A paper's own real hit, in `#seats` — where `read()` (vocabulary.js)
     *  dispatches its one genuine click. Picked out from `.hit` by the one
     *  thing belt.behaviour.js's own `aria-label` always says for a document
     *  and never for an item; never a specific document (point 3), only
     *  whichever paper is first in DOM order. */
    docHit: 'g.hit[aria-label*="a document attached to"]',
    /** The item card at the apex — round 6's anchor for "read without leaving
     *  the sky". */
    cardwrap: "#cardwrap",
    /** `later →`: the ink that lifts and presses. */
    laterInk: '#ends g.endcap-hit[data-step="1"] text.endcap',
    /** `later →`'s real hit box, which the ring wraps instead of the ink. */
    laterTarget: '#ends g.endcap-hit[data-step="1"] rect.endtarget',
    /** `later →`'s own hit GROUP (#1174, fault D) — markEnds (belt.behaviour.js)
     *  puts `aria-disabled`/`.off` here, not on the ink or the target, when
     *  the apex item sits at this end of its own manifest. */
    laterHit: '#ends g.endcap-hit[data-step="1"]',
    /** `← sooner`: the ink that lifts and presses. */
    soonerInk: '#ends g.endcap-hit[data-step="-1"] text.endcap',
    /** `← sooner`'s real hit box. */
    soonerTarget: '#ends g.endcap-hit[data-step="-1"] rect.endtarget',
    /** `← sooner`'s own hit group, same reason as `laterHit`. */
    soonerHit: '#ends g.endcap-hit[data-step="-1"]',
  }),
  POCKET: Object.freeze({
    /** The seated household's own body — the pocket dial's own round mark
     *  (pocket.svelte, `tapBody`/`openRow`). */
    /** An item's body, never the relay's catch (#1174): a suggestion rides
     *  the dial as a `.pk-body` too (`data-body-sugg`), first in the DOM,
     *  and opening it opens the signals row — whose acts are "Add to orbit"
     *  and "Dismiss", not a way to the item. */
    body: ".pocket .mdial .pk-body:not([data-body-sugg])",
    /** An item's body that carries documents (#1174): `data-papers` is the
     *  body's own count (pocket.svelte). The chapter opens one of these
     *  first, so the belt it lands in has papers to show; a sky where none
     *  carries any falls back to the first body. */
    bodyWithPapers: '.pocket .mdial .pk-body:not([data-body-sugg])[data-papers]:not([data-papers="0"])',
    /** The household's sun (#1174 round 6), as chapter 12 names it. */
    sun: ".pocket .mdial .pk-sun",
    /** The opened manifest row's own "open →" act (pocket.svelte's
     *  `itemActs`, Row.svelte's `data-row-acts`) — the real route from a
     *  body to `/item` (owner's 6a, #1119). */
    openAct: '.pocket .pk-below .p-row[data-open] [data-row-acts] a[aria-label^="Open"]',
    /** Every paper's own body, same selector as desk's `docBody` (the
     *  belt's own markup does not change shape for the pocket) — ringing
     *  the rock, not the two-line file-name caption beneath it (#1174 round
     *  9, the owner's call: point 3, above). `[aria-hidden="false"]` already
     *  excludes the papers the pocket keeps in the DOM at opacity 0 once
     *  they roll off the sky (belt.behaviour.js's `offSky`) or are still
     *  folded inside their item — no separate `visible` filter needed. */
    docBody: 'g.hit[aria-label*="a document attached to"][aria-hidden="false"]',
    /** Same hit as desk. The pocket belt marks a paper that is folded
     *  inside its item, or rolled off the sky's edge, `aria-hidden="true"`
     *  (belt.behaviour.js's `gone`); the first paper OUT is preferred for
     *  the read (`docHitOut`), and the first paper at all is what the desk
     *  has always pressed when none is. */
    docHit: 'g.hit[aria-label*="a document attached to"]',
    docHitOut: 'g.hit[aria-label*="a document attached to"][aria-hidden="false"]',
    /** The belt is built — what the chapter waits for on the pocket before
     *  naming a paper, since the pocket's belt draws after its route has
     *  settled (see `play`). */
    belt: "#caps .capseat",
    /** The empty household's card on the phone's item screen (#1174 round
     *  6): what /item shows in place of a belt when the household has
     *  nothing in it, so it is the screen having arrived too. */
    emptyCard: ".ip-emptycard",
    /** The preview sheet's own panel — #1088's reading card is a kit Sheet
     *  on the pocket. */
    cardwrap: ".p-sheet-layer.open .p-sheet-panel",
    laterInk: '#ends g.endcap-hit[data-step="1"] text.endcap',
    laterTarget: '#ends g.endcap-hit[data-step="1"] rect.endtarget',
    laterHit: '#ends g.endcap-hit[data-step="1"]',
    soonerInk: '#ends g.endcap-hit[data-step="-1"] text.endcap',
    soonerTarget: '#ends g.endcap-hit[data-step="-1"] rect.endtarget',
    soonerHit: '#ends g.endcap-hit[data-step="-1"]',
  }),
});

/**
 * Whether any body on the sky carries a paper (#1174 round 6, Fable's
 * call). film.js asks this once, before the film is measured, and hands the
 * answer to every chapter as `carriesPapers()`: with none, chapters 8 and 9
 * stay on the sky, and the measure must know that before a frame plays.
 * @param {Document} doc
 * @param {boolean} pocket
 */
export function householdCarriesPapers(doc, pocket) {
  return Boolean(doc.querySelector(pocket ? SELECTORS.POCKET.bodyWithPapers : SELECTORS.DESK.bodyWithPapers));
}

/** @type {import("./index.js").Chapter} */
export default {
  id: "belt",
  name: "The belt",

  /** @param {import("../vocabulary.js").FilmContext} ctx */
  async play(ctx) {
    const {
      pocket, setScreen, veil, ctl, goto, press, light, unlight, callout, dropCallout, mark, read, unread,
      open, w, hold, holdFor, T, waitForReal,
    } = ctx;
    const S = pocket ? SELECTORS.POCKET : SELECTORS.DESK;
    /** #1174 round 7 (fault D): a spent end-cap (markEnds, belt.behaviour.js)
     *  is PRESENT but disabled — `aria-disabled="true"`, `.off` — not absent
     *  from the DOM the way `optional` alone can tell. The chapter's own
     *  comment above (point under "WHAT SURVIVES UNCHANGED FROM ROUND 6")
     *  assumed a spent end-cap simply would not exist; it does, so this
     *  reads the SAME markup `markEnds` writes to, treating it as absent.
     *  @param {string} sel */
    function spentCap(sel) {
      const el = ctl({ sel, optional: true }).els[0];
      return Boolean(el && (el.getAttribute("aria-disabled") === "true" || el.classList.contains("off")));
    }

    /* ---- #1174 round 6 (Fable's call): no body carries a paper ----
       A household with nothing in it, or whose items carry no papers, has
       no belt to show: walking to /item opened an empty card or a bare
       belt, and every line pointed at nothing. So the chapter stays on the
       sky and reads its first two lines over the dial, the sun ringed.
       The third ("the page itself") is dropped: there is no page to read.
       Desk and pocket alike; `carriesPapers` is fixed before the measure,
       so the dry run takes this path too. */
    if (ctx.carriesPapers && !ctx.carriesPapers()) {
      await setScreen("/home");
      veil(true);
      const sun = ctl({ sel: S.sun, round: true });
      await goto(sun, { willPress: false });
      if (pocket) {
        await callout("Every body carries its documents in a belt around it.", sun, "bottom", { dy: 30, mark: "belt-cert" });
        await callout("The belt is what you have attached to it.", sun, "bottom", { dy: 30, mark: "belt-svc" });
      } else {
        await callout("Every body carries its documents in a belt around it.", sun, "top", { mark: "belt-cert" });
        await callout("The belt is what you have attached to it.", sun, "bottom", { mark: "belt-svc" });
      }
      dropCallout();
      unlight(sun);
      return;
    }

    /* ---- beat 1: arrival — translated per (1); re-cut on the pocket per
       owner's 6a: tap the body, its manifest row opens, the row's "open →"
       act is the real route to `/item` (#1119). ---- */
    await setScreen("/home");
    veil(false);

    /* #1174, pocket: a body that carries documents, so the belt the film
       lands in has papers to teach with — the apex item may have none, and
       the pocket folds every other item's papers away. The dry run and a
       sky where no body carries any take the plain first body.
       #1174 round 7 (fault D): among bodies that carry papers, one that is
       not the dial's own last body is preferred, so beat 4's "later →"
       rings a live step rather than one the belt has already spent — the
       dial lists bodies in the same date order the belt steps them in. Kept
       to a single dial read, so a household where every carrier is last (or
       there is only one) plays exactly as before: the plain first carrier. */
    let body = ctl({ sel: S.body, round: true, optional: true });
    if (pocket) {
      const carrying = ctl({
        sel: SELECTORS.POCKET.bodyWithPapers, all: true, round: true, optional: true, visible: true,
      });
      if (carrying.els.length > 0) {
        const everyBody = ctl({ sel: SELECTORS.POCKET.body, all: true, round: true, optional: true, visible: true });
        const last = everyBody.els[everyBody.els.length - 1];
        const chosen = carrying.els.find((el) => el !== last) ?? carrying.els[0];
        body = { ...carrying, els: [chosen], ringEls: [chosen] };
      }
    }
    veil(true);
    await goto(body);
    await press(body);
    /** Where the item screen is: the row's own `open →` act on the pocket
     *  (its href names the item the body opened), the apex on the desk. */
    let itemRoute = "/item";
    if (pocket) {
      open(body);
      await w(T.scroll);
      await mark("belt-arrive");
      const openAct = ctl({ sel: SELECTORS.POCKET.openAct, radius: 22, optional: true });
      const href = openAct.els[0]?.getAttribute("href") ?? "";
      if (/^\/item\/[^/?#]+$/u.test(href)) itemRoute = href;
      await goto(openAct);
      await press(openAct);
      unlight(openAct);
      unlight(body);
    } else {
      await mark("belt-arrive");
      unlight(body);
    }

    await setScreen(itemRoute);
    await w(T.cross);
    /* #1174: the pocket's belt is drawn after its route has settled — real
       time the clock never budgeted, waited out under a stall the same way
       chapter 2 waits for the pocket's /create. Round 6: a household with
       nothing in it never draws a belt — /item shows its empty card — and
       waiting for one froze the film's clock at 1:56 for the whole 12s
       bound on the owner's iPhone. Either is the screen having arrived. */
    if (pocket) await waitForReal(`${SELECTORS.POCKET.belt}, ${SELECTORS.POCKET.emptyCard}`);

    /* ---- beat 2: the papers ---- */
    const papers = ctl({ sel: S.docBody, all: true, pad: 6, round: true, optional: true });
    await goto(papers, { willPress: false });
    await callout("Every body carries its documents in a belt around it.", papers, "left", {
      mark: "belt-cert",
    });
    await callout("The belt is what you have attached to it.", papers, "right", { w: 220, mark: "belt-svc" });

    /* ---- beat 3: the paper pressed, the page beside the card ---- */
    /* ✎ #1083: the pocket's label reads "Tap", the desk's "Click" — a label,
       not in the script (round 7's own rule for `label: true`). */
    await callout(pocket ? "Tap one to bring it in." : "Click one to bring it in.", papers, "top", {
      label: true,
      hold: 2000,
      mark: "belt-doc",
    });
    await press(papers);
    /* The one genuine click this film makes (see point 2, above) — safe
       because openDoc mutates nothing that outlives the film. */
    /* #1174, pocket: read a paper that is out on the sky if there is one;
       otherwise the first paper the belt holds, as the desk always has —
       the preview is the product's own and opens for either, and the beat
       needs a page to read. */
    const out = pocket ? ctl({ sel: SELECTORS.POCKET.docHitOut, all: true, optional: true, visible: true }) : null;
    const paper = out && out.els.length > 0 ? out : ctl({ sel: S.docHit, all: true, optional: true });
    read(paper);
    if (pocket) await w(T.sheet); /* the preview sheet rises; the pill docks (automatic) */

    /* #1174 round 6, pocket: the preview sheet is only there if a paper was
       opened. A household with no papers (or nothing at all) has none to
       open, and naming the sheet anyway stopped the film here at 2:09. A
       paper that was opened is waited for, bounded, as a phone may raise
       the sheet later than its 300ms. The desk's card is always there. */
    const opened = paper.els.length > 0;
    if (pocket && opened) await waitForReal(S.cardwrap);
    const cardwrap = ctl({ sel: S.cardwrap, radius: 16, optional: pocket && !opened });
    /* #1174 round 7 (fault B): "top of cardwrap" sits only the callout's own
       height above the sheet's rise — room enough above the sheet's OWN
       header, but not above the belt's own document captions as well, once
       fault A's fix stopped moving them out of the way. Pinned to the
       papers instead, which this beat is already holding: same side, clear
       of both. Desk is untouched — its card never rises over anything. */
    const readAnchor = pocket && papers.els.length > 0 ? papers : cardwrap;
    await callout(
      "Read the full document, right here.",
      readAnchor,
      pocket ? "top" : "right",
      { mark: "belt-read" },
    );
    dropCallout();
    unlight(papers);

    /* ---- beat 4: the belt steps, by pointer ---- */
    if (pocket) {
      /* Round 8's order: the sheet is modal, so it folds BEFORE the belt is
         even approached (the desk's `unread()` stays where it is, after
         `press(later)`, below). */
      await unread();
      await w(T.sheet); /* the sheet folds; the pill comes home (automatic) */
    }
    /* Owner answer 8b (2026-10-02): the named step goes `later →` when it
       can. When `later →` is spent but `← sooner` is not, it goes the other
       way, with its own line, and the silent second step comes back with
       `later →` -- either order ends on the item it started from, which is
       chapter 9's opening frame. Both spent (a belt of one): no ring, no
       press, no line. Every case costs the same beats, so the chapter's
       length never depends on the household. */
    const laterSpent = spentCap(S.laterHit);
    const swap = laterSpent && !spentCap(S.soonerHit);
    /** @param {"later" | "sooner"} which */
    const cap = (which) => {
      const sel = which === "later" ? S.laterInk : S.soonerInk;
      const ring = which === "later" ? S.laterTarget : S.soonerTarget;
      const c = ctl({ sel, ring, optional: true });
      return spentCap(which === "later" ? S.laterHit : S.soonerHit) ? { ...c, els: [], ringEls: [] } : c;
    };
    const first = cap(swap ? "sooner" : "later");
    await goto(first);
    /* ✎ #1083 (owner's 3b): the pocket line drops the arrow-keys clause. */
    const word = swap ? "← sooner" : "later →";
    const line = pocket ? `${word} steps the belt.` : `${word} steps the belt — so do the arrow keys.`;
    if (laterSpent && !swap) {
      /* #1174 round 7: nothing to step to is treated as absent -- no box
         drawn over nothing. The callout's own cost (its fade-in plus the
         line's read time) is paid directly instead of through `callout()`,
         so dry and real measure identically. */
      await w(T.calloutIn);
      await hold(holdFor(line));
      await mark("belt-later");
    } else {
      await callout(line, first, "top", { mark: "belt-later" });
    }
    await press(first);
    if (!pocket) {
      /* Round 6: "two things happen together" — the card folds away and the
         belt rolls. The roll itself is still only ever named, never driven
         for real (#1094's own rule, unchanged); the fold is real, by Esc. */
      unread();
    }
    unlight(first);
    await w(T.cross);

    /* Read after the first step has landed: the end it stepped away from is
       live again. */
    const second = cap(swap ? "later" : "sooner");
    await goto(second);
    await press(second);
    await mark("belt-sooner");
    unlight(second);
    await w(T.cross);

    /* End state: the apex item, both papers ringed and breathing again —
       chapter 9's opening frame. */
    light(papers);
  },
};
