/**
 * CHAPTER 2 — ADD (#866).
 *
 * The mockup's second `CH` entry (design/v19/tour/round-5/f-one-take.html,
 * lines 623-684), cut the same way chapter 1 was: `{ id, name, play }`, the
 * vocabulary's words only, no pixel coordinate.
 *
 * WHERE THE MOCKUP'S SCREENS LAND. `setBg("home-empty.png")` is still
 * `/home`. `setBg("create.png")` is `/create` — the considered form
 * (`web/src/routes/create/+page.svelte`), reached in the product from the
 * north star's drawer by its own "open the full form" link (CON-12). The
 * mockup draws the fuller screen directly because it has no drawer to open
 * first; the product's `#nstar` is that drawer's own handle
 * (`web/src/routes/home/+page.svelte:971`), so this chapter presses it and
 * then names the screen it leads to, same as any other `setScreen`.
 *
 * TWO THINGS THE MOCKUP DRAWS THAT THE PRODUCT DOES NOT:
 *   1. `typeInto` — the mockup fakes typing by writing one character per
 *      wait into a span it made up (`t-name`, `t-due`, `t-cost`). There is no
 *      such word in vocabulary.js (only `T.typeLead`/`T.typeChar`, unused by
 *      any exported function), and a chapter may not invent one outside this
 *      file's remit. Each typed field is instead lit, pressed, and held for
 *      `T.field` — the same pause the mockup already spends between fields —
 *      without an animated string. Flagged in the chapter 2 report rather
 *      than papered over.
 *   2. `#c-year` — the mockup's yearly chip does not exist; the real
 *      control is `#f-recur`, a `<select>` that already defaults to
 *      "yearly" (`web/src/routes/create/+page.svelte`). This chapter lights
 *      it to say "here's how often", rather than pretending to choose an
 *      option that is chosen already.
 *
 * THE VEIL. Chapter 1's own header says it: nothing is dimmed until this
 * chapter opens the create drawer. `veil(true)` is called once, before the
 * north star lights, and never turned back off — the next chapter inherits
 * a dimmed screen, exactly as the mockup's own chapter 3 opens already
 * veiled. For the same reason the "add" button is left lit at the end:
 * chapters run one continuous film and only `clear()` between them on a
 * jump, never mid-play.
 */

/**
 * Every element this chapter names, in one place, so
 * tests/unit/v19-tour-chapter-add.test.mjs can pin them against real markup.
 */
export const SELECTORS = Object.freeze({
  /** Home's own handle for adding something new. */
  star: "#nstar",
  /** The considered form itself, once `/create` opens. */
  card: "#card",
  /** What to call it. */
  name: "#f-name",
  /** The type chip nearest the mockup's own "insp" control. */
  inspection: '#types button[data-type="inspection"]',
  /** When it's due. */
  due: "#f-date",
  /** What it costs. */
  cost: "#f-cost",
  /** How often — already defaulted to yearly. */
  recurrence: "#f-recur",
  /** Saves the entry. */
  add: "#card .btn-primary",
});

/** @type {import("./index.js").Chapter} */
export default {
  id: "add",
  name: "Add",

  /** @param {import("../vocabulary.js").FilmContext} ctx */
  async play(ctx) {
    const { setScreen, veil, ctl, goto, press, quiet, unlight, callout, dropCallout, mark, w, T } = ctx;

    await setScreen("/home");
    veil(false);

    /* "There's your add." — the north star, dimmed down to it before it's touched. */
    const star = ctl({ sel: SELECTORS.star, round: true });
    veil(true);
    await goto(star);
    await press(star);
    await mark("add-star");
    unlight(star);

    /* The drawer's own "open the full form" leads here. */
    await setScreen("/create");

    /* "Add anything here, by hand or by forwarding a document." — the whole form, named once. */
    const card = ctl({ sel: SELECTORS.card, radius: 16 });
    await goto(card, { willPress: false });
    await callout(
      "Add anything here, by hand or by forwarding a document.",
      card,
      "top",
      { mark: "add-drawer" },
    );
    dropCallout();
    unlight(card);

    /* What to call it. */
    const name = ctl({ sel: SELECTORS.name, radius: 10 });
    await goto(name);
    await press(name);
    await w(T.field);
    await mark("add-typing");
    unlight(name);

    /* What kind of thing it is — held at a quiet ring once chosen, same as
       the mockup leaves its own insp control. */
    const inspection = ctl({ sel: SELECTORS.inspection, radius: 16 });
    await goto(inspection);
    await press(inspection);
    quiet(inspection);
    await w(T.field);

    /* When it's due. */
    const due = ctl({ sel: SELECTORS.due, radius: 12 });
    await goto(due);
    await press(due);
    unlight(due);
    await w(T.field);

    /* What it costs. */
    const cost = ctl({ sel: SELECTORS.cost, radius: 12 });
    await goto(cost);
    await press(cost);
    unlight(cost);
    await w(T.field);

    /* How often — already yearly by default. */
    const recurrence = ctl({ sel: SELECTORS.recurrence, radius: 12 });
    await goto(recurrence);
    await press(recurrence);
    unlight(recurrence);
    await mark("add-yearly");
    await w(T.field);

    /* Saved — left lit; the next chapter picks up from here. */
    const add = ctl({ sel: SELECTORS.add, radius: 14 });
    await goto(add);
    await press(add);
    await mark("add-add");
  },
};
