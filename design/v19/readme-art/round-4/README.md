# README banner and logo — round 4 (#1177)

Round 3's verdict (owner, 2026-10-01, 28d): "None of your new three are any
good. I want an ultra realistic galactic plane with glorious detail." And:
"give me a version of the original with the fixed ring and planet."

One option, **K**: round 2's E composition as it was — the river crossing the
banner at the plane's angle, the mark over it, the word beside it, "your year,
in orbit", the pack's "lights out, ink up" line — with the two rulings
applied: the standard mark proportion (ring, planet, centre dot; ruling 23)
and the gold planet `#d8b45a` (ruling 24). The mark is flat vector per CON-19
and drifts once per 40s in the SVG.

Open `index.html` for K on a white and a dark page, logo at 132px and 52px;
`screenshots/k-light.png`, `k-dark.png` and `index-full.png` are the same
panes. `screenshots/sky-crop-core.png` and `sky-crop-dust.png` are 1:1 crops
of the plane for close inspection.

## Files

- `k-banner.png` — the deliverable, 1600×840.
- `k-banner@2x.png` — the same at 3200×1680 for high-density screens.
- `k-banner.svg` — the vector composite with the plane embedded as JPEG, so
  it is self-contained; this is where the planet drifts.
- `k-logo.svg` — the mark on an After Dark tile with a 1:1 crop of the real
  plane behind it (`k-sky-tile.jpg`, embedded).
- `k-sky.jpg` — the plane itself at 2×, the output of `sky.py`.

## How the sky was made

`sky.py` renders the plane with numpy at 3200×1680, seeded, in about ten
seconds. In drawing order:

- **Stars, about 240,000.** Three populations: a thin uniform disk (30k), a
  band whose density rises steeply toward the plane (190k, normally
  distributed across it) and a core where it peaks (90k). Magnitudes follow
  a power law, so most are faint and a few are bright; flux is 2.5 per
  magnitude. Colour temperature runs blue-white → white → yellow → orange →
  red from a six-stop ramp, drawn bluer in the disk, yellower in the band
  and more orange at the core. Faint stars are sub-pixel bilinear splats;
  brighter ones get a gaussian point-spread; the brightest ninety a soft
  halo. Stars behind dust are dimmed by up to 85%.
- **Haze.** A cool band in `--plane-cool`, a wide warm bulge and a bright
  warm core in `--plane-warm`, and faint rose nebulosity from low-frequency
  noise, all modulated by a cloud texture so nothing is smooth.
- **Dust.** A main lane that wanders about the plane's centre line, with
  width and offset from 1-D noise, plus ragged patches cut from eight
  octaves of value noise, plus a finer grain on top. Dust attenuates the
  haze by 92% and the stars behind it.
- **Foreground stars.** Twelve bright ones with a soft bloom that is
  windowed to zero at its edge (the first render had visible square halos);
  the brightest five carry faint four-way diffraction spikes.
- **Grain.** Gaussian noise, luminance and a touch per channel.

Tone mapping is `1 − exp(−x)` on the linear sum over the pack's `--bg`, so
bright cores saturate toward white rather than clipping flat, and the ground
stays exactly `#05070d`.

What was fixed on review before this version: square-clipped halos; far too
many large blooming stars that read as bokeh rather than a long exposure; a
band that was a smooth brown smear, which is now granular with faint stars
and cut by lanes with ragged edges.

## Rebuilding

`python3 sky.py` (numpy, Pillow), then `FONT_DIR=... python3 build.py`
(imports round 1's text outliner and mark and round 2's drift; neither round
is changed), then `node render.cjs` for the PNGs and screenshots. Nothing is
wired into the repo README or `public/` yet.

## Verdicts

Owner, 2026-10-01, on #1177: **rejected.** "Looks like a big blob. I'd say
it's worse now." Then 29b: iterate, same composition, more contrast and
visible structure at README size.

Round 5 (`../round-5/`) keeps K's composition and rebuilds the sky
stars-first.
