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
 * THE TYPED FIELDS. Three of them, verbatim from the mockup's own
 * `typeInto` calls: the name, the date and the cost, each typed one
 * character per wait once its field has been pressed. The word is
 * vocabulary.js's `typeInto`, which paints the film's own text over the
 * field rather than into it — no `value` is set, no input handler fires,
 * and nothing is left in the form when the film ends. "add-typing" is
 * handed to that word rather than marked here, because the mockup fires it
 * 55% of the way through the name so the held frame is a half-typed field.
 *
 * ONE THING THE MOCKUP DRAWS THAT THE PRODUCT DOES NOT: `#c-year`, its
 * yearly chip. The real control is `#f-recur`, a `<select>` that already
 * defaults to "yearly" (`web/src/routes/create/+page.svelte`). This chapter
 * lights it to say "here's how often", rather than pretending to choose an
 * option that is chosen already.
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
    const { setScreen, veil, ctl, goto, press, typeInto, quiet, unlight, callout, dropCallout, mark, w, T } = ctx;

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

    /* What to call it, typed in — and marked half-way through the name. */
    const name = ctl({ sel: SELECTORS.name, radius: 10 });
    await goto(name);
    await press(name);
    await typeInto(name, "Car MOT — Volvo V60", { mark: "add-typing" });
    unlight(name);
    await w(T.field);

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
    await typeInto(due, "29 Aug 2027");
    unlight(due);
    await w(T.field);

    /* What it costs. */
    const cost = ctl({ sel: SELECTORS.cost, radius: 12 });
    await goto(cost);
    await press(cost);
    await typeInto(cost, "54.85");
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
