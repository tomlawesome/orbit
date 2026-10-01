# README banner and logo — round 2 (#1177)

Round 1's three options were all rejected (owner, 2026-10-01: "super boring";
the light looks don't fit the dark brand; the tagline is CON-11's *"your
year, in orbit"*). This round is dark only and goes to the moments that make
the live app striking — the sky, the dial with bodies, the packs' strongest
moments, depth, glow and scale — instead of putting the mark on a flat field.

Open `index.html` for every option as the README would show it, on a white
page and a dark page, with the logo at 132px and 52px. `screenshots/` holds
the same panes (`d-light.png` … `g-dark.png`, `index-full.png`).

What every option shares:

- The mark itself is still CON-19: ring, planet at its station, plain centre,
  three flat shapes, no gradient or glow *on the mark*, the word plain beside
  or under it, nothing inside the ring. Everything behind it — sky, sun, dial,
  plane — blooms, because the app's does.
- The banner SVGs carry the one motion CON-19 permits: the planet drifts the
  ring once per 40s (`prefers-reduced-motion` honoured). GitHub and GitLab
  both animate an SVG in `<img>`. The PNGs are stills.
- Every logo sits on its own rounded dark tile (the app-icon family), each
  tile carrying a slice of its option's sky, so one file reads on both page
  themes.
- The tagline is "your year, in orbit". Text is outlined; no web font needed.
- Colours are pack tokens (`web/src/lib/packs.css`) or the dial's own ratified
  materials from `design/v19/home.html`.

## D · Perihelion

`d-logo.svg` · `d-banner.svg` · `d-banner.png`

The storm's lean-in (POL-10: "the camera leans in — the dial zooms"), held as
a still. The dial sits at four times its home-screen size and the banner
crops it: the outer ring and three month labels run off the edges, the
perihelion threshold is a wide red ring, the bodies are large enough to show
their materials, and the sun is the heliosphere's — a wide halo and faint
rays. The bridge's HUD calls out the next approach ("CAR MOT — VOLVO V60 ·
NEXT APPROACH T−16D · BRG 016° · 29 AUG", `home-bridge.html`'s voice). The
lockup is small and to the left; the picture is the hero.

Logo: the mark on a star-chart tile with the sun's gold bloom in one corner.

## E · Galactic plane

`e-logo.svg` · `e-banner.svg` · `e-banner.png`

After dark's river (`afterdark-plane.html`, §15 "after dark adopts the happy
accident"): cool haze, a warm core, a dust lane and seventeen hundred of its
own stars crossing the banner at the plane's angle. Over it, the sign-in's
cut of the mark — a very large, thin ring with a small ice-blue planet, the
composition the owner made bigger on the sign-in — and the word beside it at
200px. The mono line is the pack's own strapline, "lights out, ink up".

Logo: the mark on an after-dark tile with the plane crossing behind it.

## F · Retrograde

`f-logo.svg` · `f-banner.svg` · `f-banner.png`

The neon pack (`pack-retrograde-refresh.html`): the whole dial in view, its
cyan ring doubled with a blurred glow, the sun burning pink with a bloom that
fills the dial, the perihelion threshold pink. The lockup takes retrograde's
tokens — cyan ring, pink planet — with the word in the pack's ice-white. No
grids: `retrograde-nogrids.html` exists, so the owner has already ruled on
those once.

Logo: the mark on a retrograde tile with the pink bloom in one corner.

## G · Gravity well

`g-logo.svg` · `g-banner.svg` · `g-banner.png`

The year's orbit seen in depth, not from above. One tilted ring around a
blazing sun: the near half glows gold and carries bigger, nearer bodies; the
far half is a thin grey line with smaller, farther ones; the perihelion
threshold is a dashed inner ellipse. The sky spirals slowly in around the
well, borrowed from the 404's infall (`404-infall-spiral.html`), and the
ground has the infall's blue-violet depth. The word sits under it, centred.

This is the only option whose picture is not a screen the app already draws;
it is the gravity-well metaphor drawn literally. The mark on the tile is
unchanged; only the banner tilts the view.

Logo: the mark on a star-chart tile, the glowing ring passing behind it
edge-on.

## Rebuilding

`build.py` imports the text outliner, starfield and mark from
`../round-1/build.py` (round 1 is history and is not changed by this) and
writes the eight SVGs and `index.html`; `render.cjs` exports the PNGs and the
review screenshots with Playwright's Chromium. Same `FONT_DIR` as round 1.
Nothing is wired into the repo README or `public/` yet.

## Questions for the owner

- **D and F zoom and tint the app's own dial** — they show the household
  chart. **E and G do not** show the chart; E is identity, G is metaphor. Does
  the README banner need to show the product, or the brand?
- **Motion.** The banner SVGs drift the planet. If the README should hold
  still, the PNGs are the same picture.

## Verdicts

Awaiting owner
