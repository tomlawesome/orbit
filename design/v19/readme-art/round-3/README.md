# README banner and logo — round 3 (#1177)

Round 2's verdict (owner, 2026-10-01): **E, Galactic plane**, then "I'd like
to see three more versions of E though, more elegant, more polished. Each
distinct though along the same identity." The two questions E raised were
ruled the same day and are recorded in `design/owner-decisions.md` §2 and the
CON-19 row of `design/polish-register.md`:

- the mark is drawn at its **standard proportion** — ring, planet, centre dot,
  the word plain beside or under — not the sign-in's thin cut;
- the planet is **always gold `#d8b45a`** outside the app's own themed screens.
  Owner: *"The simple ring and planet is orbit's brand identity, and for
  something like this, it's always the gold colour. Changing the colour would
  only be appropriate in certain places and situations."*

So all three carry the same mark — After Dark's ring ink and ice-white centre
from the ratified brand sheet's After Dark cut, with the gold planet — on
After Dark's river, with "your year, in orbit" (CON-11), and differ on
everything else: the river's density and angle, the mark's size and
placement, the type and the air.

Open `index.html` for each on a white and a dark page, with the logo at 132px
and 52px; `screenshots/` holds the same panes. The banner SVGs drift the
planet once per 40s (CON-19's one permitted motion), so a screenshot of the
live page catches it wherever it is on the ring; the PNGs hold it at its
station.

What "more elegant" meant here, against round 2's E: the base starfield at
three-quarter strength; a river of a few hundred fine stars instead of
seventeen hundred; its haze built from four soft strokes in small opacity
steps (cool wide, cool mid, warm core, dust lane); the word 120–150px rather
than 200; Inter for the tagline; the mono line dropped; and more sky around
the lockup.

## H · Beside

`h-logo.svg` · `h-banner.svg` · `h-banner.png`

The horizontal lockup — the brand sheet's "app chrome, README" composition —
sits left of centre with the mark at 1.3× its home size, the word at 150px
and the tagline in the pack's mid ink beneath it. The river crosses the
banner at a shallow angle behind the lockup, 480 stars. The most conventional
of the three, and the one closest to how the README header will read it.

Logo: the mark on an After Dark tile, the river crossing low behind it.

## I · Stacked

`i-logo.svg` · `i-banner.svg` · `i-banner.png`

The login's composition with the word *under* the ring rather than inside it:
the mark large (2×) and centred, the word at 120px beneath, the tagline under
that. The river is steeper and denser (820 stars, wider haze) and runs
straight through the ring, so the mark sits in the brightest part of the sky.
The boldest of the three.

Logo: the mark on an After Dark tile, the river crossing steeply behind it.

## J · One line

`j-logo.svg` · `j-banner.svg` · `j-banner.png`

The quietest. A small mark (ring r 68) and the word on one centred line, the
tagline in the faint ink beneath, letter-spaced slightly. The river is level
and low on the sky, a horizon of 300 fine stars, and the lockup floats in
clear sky above it. The most air of the three.

Logo: the mark on an After Dark tile, the river a thin level band at its foot.

## Rebuilding

`build.py` imports the text outliner, starfield and mark from
`../round-1/build.py` and the drift from `../round-2/build.py` (both rounds
are history; neither is changed) and writes the six SVGs and `index.html`;
`render.cjs` exports the PNGs and the review screenshots. Same `FONT_DIR` as
round 1. Nothing is wired into the repo README or `public/` yet.

## Verdicts

Awaiting owner
