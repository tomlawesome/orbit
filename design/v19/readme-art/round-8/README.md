# README banner and logo — round 8 (#1177)

Round 7's verdict (owner, 2026-10-01, 40): "Try something totally
different." So three directions that break with "the mark over a star
field". All dark; the standard mark with the gold planet; "your year, in
orbit"; the word plain (CON-19). Each is a different idea, not a variation.

Open `index.html` for each on a white and a dark page, logo at 132px and
52px; `screenshots/{o,p,q}-{light,dark}.png` and `index-full.png` are the
same panes. P's banner in the index is the animated SVG, playing as it would
on GitHub.

## O · Terminator

`o-logo.svg` · `o-banner.svg` · `o-banner.png`

The night side of a planet's limb runs across the lower third — a 3000px
circle whose top edge arcs from y≈670 at the sides to 560 at the centre —
with a thin line of dawn along the edge (a 2px stroke in dawn's `--sun`
ember, brightest at one point to the right, blurred twin behind it), a faint
atmosphere above the limb (a wide blurred stroke, cool `--upcoming` turning
warm near the bright point), and the first light itself: a soft warm ellipse
just under the horizon where the sun is about to rise. The mark and word
rise above it in the dark, with sparse drawn stars. Taken from
`dawn-terminator.html`'s limb and the sign-in's "first light" moment
(owner-decisions §9: "the dawn breaks once on load... horizon low, in the
bottom fifth"), held before the dawn, so it stays dark.

Logo: its own — the mark on an After Dark tile with the limb and its dawn
line along the tile's foot.

## P · The year turns

`p-logo.svg` · `p-banner.svg` (animated) · `p-banner.png` (the still)

The product's rule, shown rather than decorated. On the right, the dial
reduced to its law: the year ring with twelve month ticks and the "now"
marker, the dashed perihelion threshold, the sun; five bodies drifting
slowly inward along the law's spiral (the angle advances as the radius
shrinks — `angle = days − 90`, `radius ∝ days`, home.html's own chart
transform), one of them reaching perihelion and swinging back out to the
ring for next year. One year takes sixty seconds. On the left, the lockup;
beneath everything, the sparse drawn stars the app uses, on the flat After
Dark field.

The motion is CSS only — `@keyframes` on nested groups, one turning and one
translating — with no script, so GitHub's and GitLab's `<img>` sanitisers
let it play. The mark's planet drifts too (CON-19's one motion). Every
body's resting position is also written inline, so `prefers-reduced-motion`
(which switches the animations off) and any renderer without CSS animation
show the same still as the PNG. Verified: two frames four seconds apart
differ across the dial and the mark; with reduced motion they do not.

Logo: the plain After Dark tile with sparse stars — the shipped app-icon
family — since the direction adds nothing to the tile.

## Q · The chart room

`q-logo.svg` (N's tile, unchanged) · `q-banner.svg` · `q-banner.jpg` ·
`q-banner@2x.jpg`

The product itself. **Source: `design/v19/afterdark-plane.html`**, the
ratified after-dark home mockup (§15), captured with Playwright's Chromium at
1760×1000 and device scale 2 once its sky had settled — not the fixture app,
which needs a server and seeded data to reach the same screen; the mockup is
the ratified one. `prep.py` crops the central 3200×1680 so the demo chrome
falls outside (the DEMOS bar, the account avatar, the "degraded" and "key"
edge tabs, the search field) and dims the whole screen to 68% toward the
pack's `--bg`, so the sun stays the brightest point and the mark and word
lead. The lockup is stacked on the quiet left, where only two faint
household backdrops sit. Nothing on the screen is retouched.

Logo: N's tile from round 7, unchanged (copied here as `q-logo.svg`).

## Questions for the owner

- **Q shows the sample household's name** ("Lawson Home" under the sun) and
  the four sample backdrop names, because they are on the ratified screen.
  On a public README banner, is that fine, or should the capture be taken
  from a screen with a neutral household name?

## Rebuilding

`ROOM=/path/to/capture.png python3 prep.py` (the 2× capture of
`afterdark-plane.html`), `FONT_DIR=... python3 build.py` (imports round 1's
text outliner, starfield and mark and round 2's drift; neither round is
changed), `node render.cjs` (banners, reduced motion for the stills),
`python3 jpeg.py` (Q to JPEG under 600 KB / 1.5 MB), `node panes.cjs`.
Nothing is wired into the repo README or `public/` yet.

## Verdicts

Owner, 2026-10-01 (42a): O, Terminator. Wired into the README as
docs/images/orbit-mark.svg and docs/images/orbit-banner.png.
