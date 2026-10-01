# README banner and logo — round 5 (#1177)

Round 4's verdict (owner, 2026-10-01): rejected — "Looks like a big blob. I'd
say it's worse now." Then 29b: iterate, same composition, more contrast and
visible structure at README size.

One option, **L**: K's composition exactly — mark at its standard proportion
with the gold planet, the word beside, "your year, in orbit", the river at
the plane's angle — over a sky rebuilt stars-first.

Open `index.html` for L on a white and a dark page, logo at 132px and 52px;
`screenshots/l-light.png`, `l-dark.png` and `index-full.png` are the same
panes, taken from the shrunk PNG the README would serve.

## Files

- `l-banner.png` — the deliverable, 1600×840, 0.8 MB (256-colour palette,
  dithered; see `shrink.py`).
- `l-banner.svg` — the vector composite with the plane embedded as JPEG
  (quality 86); where the planet drifts. 1.3 MB.
- `l-logo.svg` — the mark on an After Dark tile over a 1:1 crop of the plane.
- `l-sky.jpg` — the plane at 2× (3200×1680), the output of `sky.py`.

## What changed from K

K drew the band as haze with sub-pixel stars summed into it; at README width
that is a smear. L draws the band **out of stars** sized to register at the
banner's own 1600px — 2–4px there, so 4–8px at 2× — with almost no haze, and
cuts it with a crisp rift. Judged on the index screenshot, as asked.

- **Stars, about 120,000, on an unnormalised gaussian** so a faint star is a
  visible dot rather than a fraction of a pixel. Three populations: a sparse
  field; a band whose density and width peak at the core and fall to 28% and
  half-width away from it; a core. Peak brightness on a power law (most
  faint, few bright); colour temperature blue-white → red, bluer in the
  field, yellower in the band, orange at the core.
- **The rift** is a hard-edged mask: a main lane that wanders about the
  plane's centre line, plus four small rifts beside the core, each cut from
  fractal noise with a smoothstep so the edge is resolved and ragged. Stars
  inside are removed, not dimmed, so the dark is the background's own
  `#05070d` black-blue, never brown.
- **Haze** is a thin warm glow (`--plane-warm`) at the core only, cut by the
  rift. No band haze, no bulge.
- **Foreground**: forty bright stars with a small, tight bloom (14px at 2×,
  windowed to zero); three with short spikes.
- **Contrast**: deep ground, the band clearly brighter than the field; light
  grain only (heavy grain doubled the PNG).
- **Type**: a soft drop shadow under the word, tagline and mono line so they
  read over the dense field. The composition itself is unchanged.

## Structural reference

The ESO 360° Milky Way panorama (Serge Brunier, 2009), the stretch around
the galactic centre — described here, not copied:

- the **bulge** at the centre is the broadest, densest, warmest part of the
  band; L's core sits at 74% along the river, to the right of the tagline;
- the **Great Rift** runs lengthwise along the band from Cygnus through
  Aquila to Sagittarius, a dark river that splits the band in two with
  ragged edges; L's main lane wanders about the centre line the same way;
- the **small dark nebulae** beside the bulge (the Pipe, and the Coalsack's
  kind further along) are L's four small rifts;
- the band **narrows and fades** away from the core on both sides.

## Rebuilding

`python3 sky.py` (numpy, Pillow; about twelve seconds), `FONT_DIR=...
python3 build.py` (imports round 1's text outliner and mark and round 2's
drift; neither round is changed), `node render.cjs`, then `python3 shrink.py`
and retake the index screenshots. Nothing is wired into the repo README or
`public/` yet.

## Verdicts

Owner, 2026-10-01, on #1177, reviewing L alongside four photograph
candidates: "Photo 2 seems the best... and I quite like this version you did
earlier" (round 4's K composition).

L is dropped. Round 6 (`../round-6/`) is K's composition over photo 2 —
ESO's "Majestic Milky Way" (ESO/F. Char, CC BY 4.0).
