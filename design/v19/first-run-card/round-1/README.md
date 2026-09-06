# #862 — reworking the first-run card · round 1

Three directions for the panel a new administrator meets once: what is it,
time zone, currency, create this system.

## The argument this round makes

The owner's verdict opening #862 is that the card is horrible in its current
visual form, and that it washes out on clouds. The wash-out has a one-line
cause — an opacity exception listing which packs are light, which named atlas
and dawn and forgot clouds — but the exception is the symptom.

The cause is that **the card took its ink from the active pack while its
ground was the night sky on every pack**. A light pack therefore put dark ink
on darkness, and the design held it up by hand. Any fix that keeps a list will
be forgotten again the next time a pack is added, in a place where nothing
fails loudly.

So every direction here shares one move, and it is the round's real proposal:

> The card stops reading the pack for legibility. Ink, rule and veil come from
> the sky, fixed, on every pack. The **accent** still comes from the pack —
> it is the reader's own choice, it appears only on the button and the focus
> ring, and both sit on the card's own ground rather than on the sky.

Nothing is per-pack, so nothing can be forgotten. The `[data-theme=atlas],
[data-theme=dawn] .card` rule is deleted in all three, not extended.

The directions then differ on one question only: **what kind of thing is this
card?**

## The three directions

Each is `design/v19/first-run.html` copied verbatim with three surgical edits
— the `clouds` pack added (the sheet never had it), the card's ground
replaced, the pack exception deleted. The sky, the dawn, the hero ring behind
the card, the fields, the button, the error state and both hand-over beats are
carried forward byte for byte, because they are ratified and re-drawing them
would read as regression. `build.py` performs the edits and is the record of
exactly what changed.

### A · engraved — `a-engraved.html`

No card at all. The panel, blur, border and shadow go, and the questions stand
directly on the dawn: labels in small caps, each answer on a single hairline,
the button the one solid thing on screen. Legibility comes from the ink's own
halo, so every glyph brings its ground with it — which is why this cannot wash
out on any pack: there is nothing behind the words whose opacity could be
wrong. Closest of the three to the flight the screen turns into; nothing has
to dissolve, so the hand-over is the words themselves lifting.

### B · aperture — `b-aperture.html`

The card stops being something laid on the sky and becomes something you look
through. Inside its edge the same dawn is darkened and clarified — less blur
than the glass had, not more — as though a lens were held to the horizon. A
single bright hairline is the whole frame. Because the treatment is a
darkening rather than a paint, it can only ever make the ground behind the
words darker, never paler, so a light pack cannot break it. Keeps the discrete
edge that the dissolve on submit is choreographed against.

### C · plate — `c-plate.html`

The opposite argument to A. Rather than dissolving into the sky, the card
becomes undeniably an object: a solid, unlit plate with a milled edge and a
rule under its first question, like an instrument's faceplate. No translucency
at all, so no opacity can be wrong. The dawn happens around it rather than
through it. The most legible of the three by a distance and the most ordinary
— here because first run is the one time a person types something they cannot
undo casually, and an instrument that is plainly an instrument may be the
right register for that. The cost is the card no longer melting into the
flight.

## What every direction holds

- Legible on every pack with no per-pack exception list.
- The hero ring stands behind the card and is revealed by the dissolve; the
  card still has no mark of its own (owner, 2026-08-17).
- The fields are unchanged in substance: name, time zone, currency, and the
  one line admitting to the four sections made without being asked for.
- The `igniting` and `reclaimed` exits are the ratified ones, untouched.

## Checked

Rendered and inspected at 1600×1000 on all five packs on the current roster —
after dark, star-chart, dawn, clouds, retrograde — with a name typed so the
button shows its live state. Fifteen shots, no collisions, no wash-out, and
the three directions render identically to each other across packs apart from
the accent, which is the intended and only per-pack difference.

Atlas is not shown: it left the roster in #865, and the mockups keep their
atlas swatch only as history (owner, 2026-09-06).

## Verdicts

Awaiting round 1.
