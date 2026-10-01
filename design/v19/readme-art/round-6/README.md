# README banner and logo — round 6 (#1177)

Round 5's verdict (owner, 2026-10-01), reviewing L alongside four photograph
candidates: "Photo 2 seems the best... and I quite like this version you did
earlier" — round 4's K composition.

One option, **M**: K's composition exactly — the mark left at its standard
proportion with the gold planet, `orbit`, "your year, in orbit", the mono
line — over a real photograph: ESO's "Majestic Milky Way" over La Silla
(ESO/F. Char, CC BY 4.0). Credit, licence and the exact crop are in
`CREDITS.md`.

Open `index.html` for M on a white and a dark page, logo at 132px and 52px;
`screenshots/m-light.png`, `m-dark.png` and `index-full.png` are the same
panes, taken from the JPEG the README would serve.

## Files

- `m-banner.jpg` — the deliverable, 1600×840 JPEG, under 600 KB.
- `m-banner@2x.jpg` — 3200×1680 JPEG, under 1.5 MB, for high-density screens.
- `m-banner.svg` — the vector composite with the graded crop embedded as
  JPEG; where the planet drifts. Large (2.5 MB); kept as the source.
- `m-logo.svg` — the mark on an After Dark tile over a 600px square crop of
  the same photograph (`m-sky-tile.jpg`).
- `m-sky.jpg` — the graded 2× crop, the output of `prep.py`.

## What was done

- **The crop** (`prep.py`): the photograph's band rises left to right with
  the bulge top centre-right; K's river falls at about 19° with the core on
  the right. So the photograph is rotated 37.4° clockwise (no mirror — that
  would change the sky's handedness), scaled ×1.3 so the window has no empty
  corners, and a 3200×1680 window placed so the bulge lands about 72% along
  the banner, right of the tagline, with the band running behind the word.
- **The grade**, light: channels pulled toward After Dark's cool black-blue
  (R ×0.80, G ×0.88, B ×1.00), a 12% contrast lift, blacks on the pack's
  `--bg`. It stays unmistakably a photograph: nothing is drawn on it.
- **Legibility**: a soft local darkening (a blurred rounded rectangle of the
  background at 50%) sits behind the word, tagline and mono line, plus a
  soft drop shadow under the type. Composition unchanged from K.
- **Credit** bottom-right, small mono in the pack's mid ink: "Photo: ESO/F.
  Char · CC BY 4.0".
- **Sizes** (`jpeg.py`): the Playwright renders are converted to JPEG,
  stepping quality down until each fits its limit; no PNG of a photograph.

## Rebuilding

`MILKYWAY=/path/to/2-majestic.jpg python3 prep.py` (numpy, Pillow), then
`FONT_DIR=... python3 build.py` (imports round 1's text outliner and mark and
round 2's drift; neither round is changed), `node render.cjs`, `python3
jpeg.py`, then retake the index screenshots. Nothing is wired into the repo
README or `public/` yet; when it is, the credit line must go into the README
as well.

## Verdicts

Awaiting owner
