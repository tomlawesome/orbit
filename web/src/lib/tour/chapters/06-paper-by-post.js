/**
 * CHAPTER 6 — PAPER BY POST (#866).
 *
 * The mockup's sixth `CH` entry, `id: "relay"`
 * (design/v19/tour/round-5/f-one-take.html, lines 789-821), cut the same way
 * chapter 1 sets out: `{ id, name, play }`, the vocabulary's words only, no
 * pixel coordinate.
 *
 * THE COPY IS ALREADY RATIFIED. The real, non-cinematic tour
 * (web/src/lib/tour/stops.js) already has a stop with `id: "relay"` carrying
 * these exact two lines, pointed at `route: "/settings/mail"` and
 * `target: ".relay-card"` — so this chapter reuses that ratified route and
 * selector rather than inventing its own; the design decision was already
 * made once for this exact content and is not re-litigated here.
 *
 * WHERE THE MOCKUP'S SCREEN LANDS. `setBg("relay.png")` is
 * `/settings/mail` (`web/src/routes/settings/mail/+page.svelte`), the
 * member's own relay: a private forwarding address that becomes a reviewable
 * receipt with a parsed proposal when mail arrives at it
 * (`web/src/lib/data/documents.js`'s `viaRelay` receipts) — nothing is filed
 * without a member's approval, which is exactly what "Orbit reads a copy"
 * promises and no more.
 *
 * TWO THINGS THE MOCKUP DRAWS THAT HAVE NO REAL COUNTERPART, both pure
 * decoration rather than anything taught:
 *
 *  - THE BODY FADING OUT OF THE SKY as the scene cuts to the relay. The
 *    product has no demo body riding along between chapters (chapter 5 draws
 *    and removes its own, gone before this chapter starts), so there is
 *    nothing here to fade.
 *  - THE FLYING ENVELOPE. A one-shot decorative sprite the mockup's own
 *    screenshot slideshow could afford; the vocabulary has no word for
 *    conjuring a sprite that isn't a real element, and inventing one here
 *    would be writing a pixel coordinate by another name. Dropped; the two
 *    spoken lines carry the beat on their own, verbatim.
 *
 * NO ARRIVAL NOTIFICATION EITHER. Checked against the same 2026-09-23 ruling
 * chapter 5 ran into: the product raises no toast or pop-up when mail lands
 * at the relay — arrival shows up as the inbox's own relay bar and a
 * waiting-for-review count on `/settings`, neither of which this chapter's
 * two ratified lines depend on, so nothing here teaches a surface that does
 * not exist.
 *
 * ONE CONTROL CARRIES BOTH LINES, same as the mockup's own single `addr` —
 * lit once, both lines said against it, then dropped.
 */

/**
 * Every element this chapter names, in one place, so
 * tests/unit/v19-tour-chapter-paper-by-post.test.mjs can pin it against
 * `/settings/mail`'s real markup.
 */
export const SELECTORS = Object.freeze({
  /** The relay card — the same target the ratified walk already points at
   *  for this exact copy (stops.js's own "relay" stop). */
  card: ".relay-card",
});

/** @type {import("./index.js").Chapter} */
export default {
  id: "relay",
  name: "Paper by post",

  /** @param {import("../vocabulary.js").FilmContext} ctx */
  async play(ctx) {
    const { setScreen, veil, ctl, goto, unlight, callout, dropCallout } = ctx;

    await setScreen("/home");
    veil(false);

    /* "One movement into the relay" — the mockup's own scene cut, dimmed
       before the screen changes under it, same as any other setScreen. */
    veil(true);
    await setScreen("/settings/mail");

    /* "Forward a bill to your relay address and Orbit reads a copy." /
       "Your mail is never redirected — it keeps arriving exactly where it
       always has." — the whole card, named once, carrying both lines. */
    const card = ctl({ sel: SELECTORS.card, radius: 16 });
    await goto(card, { willPress: false });
    await callout(
      "Forward a bill to your relay address and Orbit reads a copy.",
      card,
      "top",
      { mark: "relay-addr" },
    );
    await callout(
      "Your mail is never redirected — it keeps arriving exactly where it always has.",
      card,
      "bottom",
      { mark: "relay-never" },
    );
    unlight(card);
    dropCallout();
  },
};
