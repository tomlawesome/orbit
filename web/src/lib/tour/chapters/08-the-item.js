/**
 * CHAPTER 8 — THE ITEM (#1319).
 *
 * The belt and `/item/<id>` are retired (owner-decisions §34): home's item
 * drawer holds everything. This chapter replaces "The belt" and is cut from
 * the owner-ratified round 2 of the drawer chapter
 * (design/v19/tour-drawer/round-2/README.md; round 1's README carries the
 * beats' gestures and the build list), copied verbatim — every spoken line,
 * desk "Click…" and pocket "Tap…" alike — and translated to selectors on
 * home's own markup (CorridorRow.svelte, ItemView.svelte, ItemDrawer.svelte,
 * FootRow.svelte, EditRows.svelte, PreviewCard.svelte, ChooserCard.svelte).
 *
 * Five beats, set on `/home`:
 *   1. the dot presses a body on the dial; its row opens and the page
 *      brings it up; the drawer is lit — "Open an item and everything about
 *      it is right here."
 *   2. the documents, lit under the notes;
 *   3. one pressed: the preview card stands beside the drawer (the bottom
 *      sheet on a phone), then goes;
 *   4. the four pills; the pencil pressed, the rows go live;
 *   5. the due value pressed, the calendar beside; it goes, cancel is
 *      pressed, the read view is back. End state: the drawer open and lit,
 *      chapter 9's opening frame.
 *
 * HOW THE ROW OPENS. On the desk a body's own `.body-link` is a hover and a
 * same-page anchor; it does not open its row (#424 made the manifest row
 * the item's destination). So, as the old chapter did, the dot presses the
 * body for the gesture (`press` only animates), and the row is opened by
 * the product's own means: the row's own click (`open()`), which is how
 * home opens `/home?item=<id>` (§34) from the page — a shallow history
 * entry that Escape takes away again. On the pocket the body's own tap
 * opens its row (pocket.svelte's `tapBody`/`openRow`), as it always has. A
 * body whose row the manifest does not draw is never picked: on the pocket
 * its tap would leave home.
 *
 * WHAT IS CLICKED FOR REAL. The row, the paper (`read()`), the pencil and
 * the due value (`open()`): each sets view state only — the drawer's
 * draft, a chooser card, a preview — and nothing is sent. Every one is put
 * back by the film's own Escape, in home's own order (the chooser, then the
 * editing, then the row): the chooser and the editing by this chapter, the
 * row by chapter 9 (`shut()`), and all of them by `clear()` on a jump or a
 * stop. The film never presses save, and never writes.
 *
 * WHATEVER THE HOUSEHOLD HOLDS. Every control is `optional` (chapter 7's
 * idiom), so the chapter plays the same beats, for the same length, with
 * or without papers, and with no body at all: a paper beat with no paper
 * lights nothing and says its line at the drawer; a household with nothing
 * in it opens nothing and says every line at the sun. The bodies are
 * chosen papers first, so the beats have something to show where they can.
 *
 * THE TICK. One of the three chapters the transport measures a jump to (4,
 * 8, 11), so it opens exactly like a chapter played from a cold jump: its
 * own `setScreen`/`veil(false)` first.
 */

/** Where an opened row's top lands on the desk: the page's own gutter, the
 *  line the preview card sticks at (round 1's mockup, `scrollToRow`). */
const ROW_TOP = 84;

/** Home's own read has landed (+page.svelte's `sync()`). Until then the
 *  sky is the one the server drew, which can name bodies the browser's read
 *  does not: walked in from another screen, the film once picked one in the
 *  moment before the read replaced it, and waited for a drawer that never
 *  opened. */
const HOME_READY = "body[data-home-ready]";

const DESK_DRAWER = ".desk .itemview";
const POCKET_DRAWER = ".pocket .pk-below .p-row[data-open]";

/**
 * Every element this chapter names, so
 * tests/unit/v19-tour-chapter-the-item.test.mjs can pin them against home's
 * real markup. Both dialects share the drawer's own parts (FootRow,
 * EditRows, the preview and chooser cards); only where the drawer stands
 * differs: `.itemview` under the desk's row, the kit Row's own detail on
 * the pocket.
 */
export const SELECTORS = Object.freeze({
  DESK: Object.freeze({
    /** An item's body on the dial, never a suggestion's. */
    body: '.body-link:not([aria-label^="suggested:"])',
    /** An item's body that carries documents: home's own count. */
    bodyWithPapers: ".body-link[data-docs]",
    /** The household's sun — where the lines are said when no item opens. */
    sun: ".sun-link",
    /** A manifest row; the body's own id is added as `[id="…"]`. */
    row: ".desk a.item",
    /** The open row's head, what the page brings up to `ROW_TOP`. */
    open: ".desk .item.open",
    /** The open drawer: the row's head and everything under it. */
    drawer: ".desk .item.open, .desk .itemview",
    /** The drawer's head — the desk says the first line at the whole drawer. */
    head: ".desk .item.open, .desk .itemview",
    /** The foot row: the record has landed (the drawer reads it first). */
    foot: `${DESK_DRAWER} .ivfootrow`,
    /** Every document row, under the notes. */
    docs: `${DESK_DRAWER} [data-doc-row]`,
    /** The four pills. */
    acts: `${DESK_DRAWER} .ivacts[aria-label^="Actions for "]`,
    /** The pencil. */
    pencil: `${DESK_DRAWER} .ivedit`,
    /** The rows, live. */
    fields: `${DESK_DRAWER} [data-edit-rows]`,
    /** The due value, live. */
    due: `${DESK_DRAWER} [data-edit-rows] .pick[aria-label^="due:"]`,
    /** Cancel, in the pills' place while editing (save is the accent one). */
    cancel: `${DESK_DRAWER} .ivacts[aria-label^="Editing "] button:not(.act-accent)`,
    /** The preview card, beside the drawer (the bottom sheet under 1200px). */
    preview: "[data-preview-card]",
    /** The chooser card, in the preview's seat. */
    chooser: "[data-chooser-card]",
  }),
  POCKET: Object.freeze({
    /** An item's body, never the relay's catch (`data-body-sugg`), whose
     *  tap raises the review sheet. */
    body: ".pocket .mdial .pk-body:not([data-body-sugg])",
    /** An item's body that carries documents: `data-papers` is its count. */
    bodyWithPapers: '.pocket .mdial .pk-body:not([data-body-sugg])[data-papers]:not([data-papers="0"])',
    sun: ".pocket .mdial .pk-sun",
    /** A manifest row (the kit Row); the body's own id is added as
     *  `[data-row-key="…"]`. The pocket manifest lists only what is near. */
    row: ".pocket .pk-below .p-row",
    open: POCKET_DRAWER,
    drawer: POCKET_DRAWER,
    /** The open row's own face — the first line stands above it. */
    head: `${POCKET_DRAWER} [data-row-face]`,
    foot: `${POCKET_DRAWER} .ivfootrow`,
    docs: `${POCKET_DRAWER} [data-doc-row]`,
    acts: `${POCKET_DRAWER} .ivacts[aria-label^="Actions for "]`,
    pencil: `${POCKET_DRAWER} .ivedit`,
    fields: `${POCKET_DRAWER} [data-edit-rows]`,
    due: `${POCKET_DRAWER} [data-edit-rows] .pick[aria-label^="due:"]`,
    cancel: `${POCKET_DRAWER} .ivacts[aria-label^="Editing "] button:not(.act-accent)`,
    preview: "[data-preview-card]",
    chooser: "[data-chooser-card]",
  }),
});

/** @param {string} value an id, quoted for an attribute selector */
const quoted = (value) => `"${value.replace(/["\\]/gu, (ch) => `\\${ch}`)}"`;

/**
 * One manifest row by its item's id, per dialect.
 * @param {boolean} pocket @param {string} id
 */
export function rowOf(pocket, id) {
  return pocket
    ? `${SELECTORS.POCKET.row}[data-row-key=${quoted(id)}]`
    : `${SELECTORS.DESK.row}[id=${quoted(id)}]`;
}

/**
 * Waits for home's own read (`HOME_READY`) before a body is chosen. A stall,
 * like every `waitForReal`, and nothing in dry mode, so the chapter's length
 * never depends on it.
 * @param {import("../vocabulary.js").FilmContext} ctx
 */
export async function readyHome(ctx) {
  await ctx.waitForReal(HOME_READY);
}

/**
 * The body this chapter presses: the first that carries papers and has a
 * row in the manifest, else the first with a row at all. `row` says
 * whether there is one to open; with none (a household with nothing in
 * it, or nothing the pocket manifest lists) the body is still pressed, if
 * there is one, and nothing opens.
 *
 * @param {import("../vocabulary.js").FilmContext} ctx
 * @returns {{ body: import("../vocabulary.js").Control, id: string, row: boolean, papers: boolean }}
 */
export function itemBody(ctx) {
  const { pocket, ctl, doc } = ctx;
  const S = pocket ? SELECTORS.POCKET : SELECTORS.DESK;
  const all = ctl({ sel: S.body, all: true, round: true, optional: true });
  const carrying = ctl({ sel: S.bodyWithPapers, all: true, round: true, optional: true, visible: true });
  const hasRow = (/** @type {Element} */ el) => {
    const id = el.getAttribute("data-body") ?? "";
    return Boolean(id) && Boolean(doc.querySelector(rowOf(pocket, id)));
  };
  const withPapers = carrying.els.find(hasRow);
  const pick = withPapers ?? all.els.find(hasRow) ?? all.els[0];
  const els = pick ? [pick] : [];
  return {
    body: { ...all, els, ringEls: els },
    id: pick?.getAttribute("data-body") ?? "",
    row: Boolean(pick && hasRow(pick)),
    papers: Boolean(withPapers),
  };
}

/**
 * Opens the picked body's drawer, unless one is already open (chapter 9
 * played on from this one), waits for its record, and brings it up: on the
 * desk the page glides the row to `ROW_TOP`, on the pocket the row's own
 * opening scrolls it to the middle. The same `T.scroll` either way, opened
 * or not, so the length never depends on what was on the screen.
 *
 * @param {import("../vocabulary.js").FilmContext} ctx
 * @param {{ body: import("../vocabulary.js").Control, id: string, row: boolean }} pick
 */
export async function openItem(ctx, { body, id, row }) {
  const { pocket, ctl, open, waitForReal, w, T, dry, doc } = ctx;
  const S = pocket ? SELECTORS.POCKET : SELECTORS.DESK;
  const live = !dry();
  if (live && row && !doc.querySelector(S.foot)) {
    open(pocket ? body : ctl({ sel: rowOf(false, id), optional: true }));
  }
  if (live && row) await waitForReal(S.foot);
  if (pocket) await w(T.scroll);
  else await glide(ctx, rowTop(ctx));
}

/**
 * Where the page goes to bring the open row's head to `ROW_TOP`. A row too
 * near the page's end to get there is given the room below it (`room`,
 * chapter 4's own), taken away again by chapter 9, a screen change or
 * `clear()`.
 * @param {import("../vocabulary.js").FilmContext} ctx
 */
function rowTop(ctx) {
  const { dry, doc, room } = ctx;
  const view = doc.defaultView;
  if (dry() || !view) return 0;
  const el = doc.querySelector(SELECTORS.DESK.open);
  if (!el) return view.scrollY;
  const want = Math.max(0, view.scrollY + el.getBoundingClientRect().top - ROW_TOP);
  const most = Math.max(0, doc.documentElement.scrollHeight - view.innerHeight);
  if (want > most) room(want - most);
  return want;
}

/**
 * The page's scroll on the film's own clock (chapter 4's `glide`): paused
 * with the film, at once under reduced motion, and where it says it is
 * when the next beat measures.
 * @param {import("../vocabulary.js").FilmContext} ctx
 * @param {number} top
 */
export function glide(ctx, top) {
  const { tween, dry, doc, T } = ctx;
  const view = doc.defaultView;
  const from = dry() || !view ? 0 : view.scrollY;
  return tween(T.scroll, (t) => {
    if (dry() || !view) return;
    const e = 1 - Math.pow(1 - t, 3);
    view.scrollTo({ top: from + (top - from) * e, behavior: "instant" });
  });
}

/** The first control that found something, else the last (which may be
 *  empty too, and then the line is said where the film stands).
 *  @param {...import("../vocabulary.js").Control} controls */
const at = (...controls) => controls.find((c) => c.els.length > 0) ?? controls[controls.length - 1];

/** @type {import("./index.js").Chapter} */
export default {
  id: "item",
  name: "The item",

  /** @param {import("../vocabulary.js").FilmContext} ctx */
  async play(ctx) {
    const {
      pocket, setScreen, veil, ctl, goto, press, light, unlight, callout, dropCallout, mark, read, unread,
      open, w, T, waitForReal, dry,
    } = ctx;
    const S = pocket ? SELECTORS.POCKET : SELECTORS.DESK;

    /* ---- beat 1: arrival — the body pressed, its row open ---- */
    await setScreen("/home");
    veil(false);
    await readyHome(ctx);
    const pick = itemBody(ctx);
    const { body } = pick;
    const sun = ctl({ sel: S.sun, round: true, optional: true });
    veil(true);
    await goto(body);
    await press(body);
    unlight(body);
    await openItem(ctx, pick);
    /* The papers are read with the record on the desk, and a moment after
       it on the pocket; the body said it carries some, so they are coming. */
    if (!dry() && pick.row && pick.papers) await waitForReal(S.docs);

    let drawer = ctl({ sel: S.drawer, all: true, radius: 16, optional: true });
    light(drawer);
    const head = ctl({ sel: S.head, all: !pocket, radius: 16, optional: true });
    await callout("Open an item and everything about it is right here.", at(head, sun), pocket ? "top" : "left", {
      mark: "item-row",
    });

    /* ---- beat 2: the papers, under the notes ---- */
    const docs = ctl({ sel: S.docs, all: true, radius: 10, pad: 2, optional: true });
    await goto(docs, { willPress: false });
    await callout("Your notes, then any paperwork you’ve added.", at(docs, drawer, sun), pocket ? "bottom" : "right", {
      mark: "item-docs",
    });
    unlight(docs);

    /* ---- beat 3: one pressed, the preview beside ---- */
    const paper = ctl({ sel: S.docs, radius: 10, pad: 2, optional: true });
    await goto(paper);
    /* a label, not in the script (round 7's rule for `label: true`) */
    await callout(pocket ? "Tap one to bring it in." : "Click one to bring it in.", at(paper, drawer, sun), "top", {
      label: true,
      hold: 2000,
      mark: "item-bring",
    });
    await press(paper);
    read(paper);
    unlight(paper);
    await w(T.sheet); /* the card arrives (the sheet rises on a phone) */
    /* Only a paper that was opened is waited for: with none, no card is
       coming, and waiting would stand the film still for nothing. */
    if (paper.els.length > 0) await waitForReal(S.preview);
    const card = ctl({ sel: S.preview, radius: 16, optional: true });
    light(card);
    await callout(
      pocket ? "That’s a preview. Tap it to read the whole thing." : "That’s a preview. Click it to read the whole thing.",
      at(card, drawer, sun),
      "top",
      { mark: "item-read" },
    );
    dropCallout();
    unlight(card);
    unread(); /* gone at once on the desk; the sheet folds on a phone */
    await w(T.sheet);

    /* ---- beat 4: the four pills, then the pencil ---- */
    const acts = ctl({ sel: S.acts, radius: 18, pad: 4, optional: true });
    await goto(acts, { willPress: false });
    await callout(
      "Snooze it, mark it done, add a document or retire it — all from here.",
      at(acts, drawer, sun),
      pocket ? "top" : "bottom",
      { mark: "item-acts" },
    );
    unlight(acts);
    const pencil = ctl({ sel: S.pencil, round: true, pad: 2, optional: true });
    await goto(pencil);
    await press(pencil);
    unlight(pencil);
    const stopEditing = open(pencil);
    await w(T.cross);
    /* The head is redrawn for editing (its title goes live), so the drawer
       is measured again rather than ringing an element that has gone. */
    unlight(drawer);
    drawer = ctl({ sel: S.drawer, all: true, radius: 16, optional: true });
    light(drawer);
    const fields = ctl({ sel: S.fields, radius: 12, pad: 2, optional: true });
    light(fields);
    await mark("item-editing");
    await callout("Need to change something? Edit it right here.", at(fields, drawer, sun), pocket ? "bottom" : "left", {
      mark: "item-edit",
    });
    unlight(fields);

    /* ---- beat 5: the due value pressed, the calendar beside ---- */
    const due = ctl({ sel: S.due, radius: 8, pad: 3, optional: true });
    await goto(due);
    await press(due);
    const closeCalendar = open(due);
    unlight(due);
    await w(T.sheet);
    const calendar = ctl({ sel: S.chooser, radius: 16, optional: true });
    light(calendar);
    await callout(
      pocket ? "Tap the date and pick a new one from the calendar." : "Click the date and pick a new one from the calendar.",
      at(calendar, drawer, sun),
      "top",
      { mark: "item-calendar" },
    );
    dropCallout();
    unlight(calendar);
    await closeCalendar();
    await w(T.sheet);

    /* Cancel: the read view again, nothing written. */
    const cancel = ctl({ sel: S.cancel, radius: 16, pad: 2, optional: true });
    await goto(cancel);
    await press(cancel);
    unlight(cancel);
    await stopEditing();
    await w(T.cross);

    /* End state: the drawer open and lit — chapter 9's opening frame. */
    unlight(drawer);
    light(ctl({ sel: S.drawer, all: true, radius: 16, optional: true }));
  },
};
