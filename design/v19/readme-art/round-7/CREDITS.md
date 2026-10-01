# Credits — round 7 (#1177)

## The sky

- **Work:** "Majestic Milky Way" — the Milky Way over ESO's La Silla
  Observatory, Chile.
- **Author / credit line:** ESO/F. Char
- **Source:** https://www.eso.org/public/images/milkywaylasilla-cc/
- **Licence:** Creative Commons Attribution 4.0 International (CC BY 4.0),
  https://creativecommons.org/licenses/by/4.0/
- **Attribution carried:** on the banner itself, bottom-right, in small mono
  ("Photo: ESO/F. Char · CC BY 4.0"); in this file; and to be repeated in
  the repository README's credits when the art is wired in.
- **Source file used:** the full-resolution JPEG from ESO, 5000×3333
  (`/tmp/milkyway/2-majestic.jpg` on the build host; not committed).

## What was done to it (`prep.py`)

- Scaled ×1.3 (Lanczos) so a 3200×1680 window fits inside the rotated frame
  with no empty corners.
- Rotated 37.4° clockwise, so the band falls left-to-right at K's angle
  (about 19°) with the galactic bulge on the right. Astrophotographs have
  no fixed "up"; the image was not mirrored, so the sky's handedness is
  unchanged.
- Cropped to the window at (1861, 886)–(5061, 2566) of the rotated
  6500×4333 frame — about 2460×1290 pixels of the original — placed so the
  bulge sits about 72% along the banner.
- Graded hard into After Dark (owner 37a): luminance mapped through a
  duotone of the pack's own inks (`--bg` → `--line` → `--ink-faint` →
  `--ink-mid` → `--ink`), the field darkened (gamma 1.45, ×0.9, soft knee
  on highlights), the bulge calmed by a soft mask and tinted toward
  `--plane-cool`, a tenth of the photograph's own chroma kept.
- Nothing added, removed or painted: no synthetic stars, no retouching.

## Everything else on the banner

The mark, word and tagline are the project's own (CON-19;
`design/owner-decisions.md`). Type is outlined from Space Grotesk, Inter and
JetBrains Mono (all SIL OFL 1.1).
