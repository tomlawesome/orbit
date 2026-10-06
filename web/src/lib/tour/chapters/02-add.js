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
 *
 * #1083: two frozen sets. The pocket route is `#morb`'s hatch → its own
 * "Add an item" row → `/create`'s pocket form (§5 of the build notes); there
 * is no drawer, so the pocket set names the hatch and its row instead of a
 * drawer's own card.
 */
export const SELECTORS = Object.freeze({
  DESK: Object.freeze({
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
  }),
  POCKET: Object.freeze({
    /** Home's own account orb — opens the hatch. */
    orb: "#morb",
    /** Any open sheet's own panel — lit `ringless` while the hatch's own
     *  "Add an item" row is ringed inside it (round 8's cut-out, §3.5). */
    panel: ".p-sheet-layer.open .p-sheet-panel",
    /** The hatch's own "Add an item" row. */
    addLink: '.p-sheet-layer.open [data-row-face][href$="/create"]',
    /** The pocket form's first card — the kind chips. */
    card: "#pocket-entry .pc-form > .pc-card:first-child",
    /** What to call it. */
    name: '#pocket-entry input[id$="-name"]',
    /** The inspection chip: `KINDS[2].id === "inspection"` (entry.js). */
    inspection: "#pocket-entry .pc-kinds .pc-chip:nth-child(3)",
    /** When it's due — present with no kind chosen (`kindHasDate(null)`). */
    due: '#pocket-entry input[id$="-due"]',
    /** What it costs. */
    cost: '#pocket-entry input[id$="-cost"]',
    /** The save bar's own save pill. */
    add: ".pk-bar .pk-save",
  }),
});

/** @type {import("./index.js").Chapter} */
export default {
  id: "add",
  name: "Add",

  /** @param {import("../vocabulary.js").FilmContext} ctx */
  async play(ctx) {
    const {
      pocket, setScreen, veil, ctl, goto, press, typeInto, quiet, unlight, light, callout, dropCallout, mark,
      open, close, waitForReal, w, T,
    } = ctx;
    const S = pocket ? SELECTORS.POCKET : SELECTORS.DESK;

    await setScreen("/home");
    veil(false);

    if (pocket) {
      /* The account orb opens the hatch; its own "Add an item" row leads to
         `/create` — there is no drawer on the pocket (#1083 §2). */
      const orb = ctl({ sel: SELECTORS.POCKET.orb, round: true });
      veil(true);
      await goto(orb);
      await press(orb);
      open(orb);
      /* #1174: the orb is behind the hatch's scrim from here on. Left lit,
         its ring outlived the screen — it was still drawn at the top right
         of /create, round the reader's avatar, for the whole chapter. */
      unlight(orb);
      await w(T.sheet);
      const panel = ctl({ sel: SELECTORS.POCKET.panel, ringless: true });
      light(panel);
      const addLink = ctl({ sel: SELECTORS.POCKET.addLink, radius: 10 });
      await goto(addLink);
      await press(addLink);
      await mark("add-star");
      unlight(addLink);
      unlight(panel);
      await close();
      await setScreen("/create");
      /* The pocket's own /create reads the household list before it draws
         its form at all (routes/create/pocket.svelte's `phase`) — real
         network time a single settle() tick does not wait out. */
      await waitForReal(SELECTORS.POCKET.card);
    } else {
      /* "There's your add." — the north star, dimmed down to it before it's touched. */
      const star = ctl({ sel: SELECTORS.DESK.star, round: true });
      veil(true);
      await goto(star);
      await press(star);
      await mark("add-star");
      unlight(star);

      /* The drawer's own "open the full form" leads here. */
      await setScreen("/create");
    }

    /* "Fill in the details here." — the whole
       form, named once. The pocket stands the pill on its own save bar once
       `/create` is up (transport.js's own dock/stand, automatic). */
    const card = ctl({ sel: S.card, radius: 16 });
    await goto(card, { willPress: false });
    await callout(
      "Fill in the details here.",
      card,
      "top",
      { mark: "add-drawer" },
    );
    dropCallout();
    unlight(card);

    /* What to call it, typed in — and marked half-way through the name. */
    const name = ctl({ sel: S.name, radius: 10 });
    await goto(name);
    await press(name);
    await typeInto(name, "Car MOT — Volvo V60", { mark: "add-typing" });
    unlight(name);
    await w(T.field);

    /* What kind of thing it is — held at a quiet ring once chosen, same as
       the mockup leaves its own insp control. */
    const inspection = ctl({ sel: S.inspection, radius: pocket ? 22 : 16 });
    await goto(inspection);
    await press(inspection);
    quiet(inspection);
    await w(T.field);

    /* When it's due. */
    const due = ctl({ sel: S.due, radius: 12 });
    await goto(due);
    await press(due);
    await typeInto(due, "29 Aug 2027");
    unlight(due);
    await w(T.field);

    /* What it costs. */
    const cost = ctl({ sel: S.cost, radius: 12 });
    await goto(cost);
    await press(cost);
    await typeInto(cost, "54.85");
    unlight(cost);
    await w(T.field);

    /* How often — already yearly by default. #1083 §6's Call: dropped on
       the pocket. The pocket form only renders "comes round" once a kind is
       really chosen, and really choosing one dirties the form so
       `/create`'s "Leave without adding?" sheet would block chapter 3's
       `setScreen("/home")`. This is the one place the pocket plays fewer
       beats than the desk (#1083 §11: a product change, not the film's,
       would let this come back). */
    if (!pocket) {
      const recurrence = ctl({ sel: SELECTORS.DESK.recurrence, radius: 12 });
      await goto(recurrence);
      await press(recurrence);
      unlight(recurrence);
      await mark("add-yearly");
      await w(T.field);
    }

    /* Saved — left lit; the next chapter picks up from here. */
    const add = ctl({ sel: S.add, radius: pocket ? 22 : 14 });
    await goto(add);
    await press(add);
    await mark("add-add");
  },
};
