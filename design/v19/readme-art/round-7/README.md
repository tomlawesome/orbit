# README banner and logo — round 7 (#1177)

Round 6's verdict (owner, 2026-10-01): "I like it but I don't think it
really fits with the rest of orbit." Then 37a: keep the photograph, grade it
into Orbit's palette.

One option, **N**: M's crop and composition unchanged — the mark left at its
standard proportion with the gold planet, `orbit`, "your year, in orbit" —
with the photograph (ESO's "Majestic Milky Way", ESO/F. Char, CC BY 4.0;
`CREDITS.md`) graded hard into After Dark. The mono line "lights out, ink up
· after dark" is dropped (coordinator's call: it names a theme the README
reader has not met); the credit stays bottom-right.

Open `index.html` for N on a white and a dark page, logo at 132px and 52px;
`screenshots/n-light.png`, `n-dark.png` and `index-full.png` are the same
panes, taken from the JPEG the README would serve.

## Files

- `n-banner.jpg` — the deliverable, 1600×840 JPEG, under 600 KB.
- `n-banner@2x.jpg` — 3200×1680 JPEG, under 1.5 MB.
- `n-banner.svg` — the vector composite with the graded crop embedded; where
  the planet drifts. Kept as the source.
- `n-logo.svg` — the mark on an After Dark tile over a square crop of the
  graded photograph (`n-sky-tile.jpg`).
- `n-sky.jpg` — the graded 2× crop, the output of `prep.py`.

## The grade (`prep.py`)

The aim was the app's own home sky with a photograph's texture, so the
grade is built from the pack's tokens (`web/src/lib/packs.css`,
`[data-theme=afterdark]`) rather than from colour adjustments:

- **Duotone through the pack's inks.** The photograph's luminance is mapped
  through `--bg` → `--line` → `--ink-faint` → `--ink-mid` → `--ink`, so the
  darkest sky is exactly the pack's ground and the brightest stars are the
  pack's ink. Everything in between is a pack grey-blue.
- **The field darkened** so the mark and word lead: gamma 1.45, ×0.9, and a
  soft knee on the highlights. Stars survive because they are the brightest
  points; the band's haze drops to the mid inks.
- **The bulge calmed**: a soft elliptical mask about the core lowers it by
  up to 45% and tints it toward `--plane-cool`, so the glow is cool, not
  warm.
- **A tenth of the photograph's own chroma kept**, so the dust lanes are
  texture rather than a flat duotone.
- Nothing added or painted: every star and lane is the photograph's.

The local darkening behind the type is lighter than M's (35% rather than
50%) because the field no longer needs it as much.

## Rebuilding

As round 6: `MILKYWAY=/path/to/2-majestic.jpg python3 prep.py`, `FONT_DIR=...
python3 build.py`, `node render.cjs`, `python3 jpeg.py`, then retake the
index screenshots. Nothing is wired into the repo README or `public/` yet;
when it is, the credit line goes into the README as well.

## Verdicts

Awaiting owner
