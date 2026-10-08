# What the belt is for — round 6 (#1304): the choices, made visual

Round 5's verdict, verbatim in `../round-5/README.md`: the chooser card
is fine; "it's the words in a list that doesn't look good, as it's
visually more taxing"; no little symbols anywhere (§35). Two directions
from `../round-5/i-chooser-beside-revised.html`, changing only the
section, type and period choices; the card, its outline, the calendar
and everything else verbatim.

- `j-tiles.html` — **the tiles**: each choice is its own glass tile in a
  grid (sections 2x2, types 3 across, periods 2x3), the word centred; the
  chosen tile filled as the calendar's chosen day is. A period tile
  carries its "then 29 Aug 2027" under the words.
- `k-band.html` — **the band**: one segmented strip across the card,
  every choice an equal cell side by side, the chosen cell filled. The
  period band reads as a scale, the figure large over its unit (once, 1
  month … 2 years), with the next date read out beneath.

Scenes `?scene=`: `editing-section`, `editing-type`, `editing-period`,
`editing-date`, `narrow-editing-date`, `narrow-editing-section` (view the
narrow ones at 390x844), plus round 3's. Packs by `?theme=`.

## Notes from the build

- No type marks, glyphs or counts in either.
- Keyboard: arrows walk the tiles or the band, Enter or Space picks and
  closes, Escape closes, focus returns to the pressed row. The chosen
  choice shows its focus halo on open, because focus lands there.
- Click off closes (owner, 2026-10-08): a press outside the key, the
  stack status drawer or the account menu now closes whichever is open,
  as the app's `home.behaviour.js` already does. Added to both files;
  earlier rounds are left as reviewed.

## Verdicts (owner, 2026-10-08)

On the band's period chooser (K, `editing-period`):

> Love this, but would like to see it vertically. For the others, I
> prefer the tile style.

> When I say this, I mean the repeat band

Periods: K's band, turned vertical. Section and type: J's tiles. Round 7
puts the two together.
