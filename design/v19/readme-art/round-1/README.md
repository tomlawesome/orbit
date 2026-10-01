# README banner and logo — round 1 (#1177)

The README's header logo (132px), full-width banner and footer logo (52px)
pointed at `public/orbit-mark.svg` and `public/og.png`, both deleted with the
Next.js removal and both drawn for the old UI (owner decision 5b, 2026-10-01:
not to be restored). This round draws replacements in the v19 look.

Open `index.html` to see every option as the README would show it, on a white
page and a dark page, with the logo at both sizes. `screenshots/` holds the
same panes as PNGs (`a-light.png` … `c-dark.png`, `index-full.png`).

What every option shares, so they compare fairly:

- The mark is the ratified CON-19 glyph, unchanged: ring, planet at its −30°
  station, plain filled centre. Three flat shapes, no glow, no gradient on the
  mark, the word set plain beside or under it, nothing inside the ring.
- The word is Space Grotesk 600 with the brand page's `.015em` tracking; the
  tagline is Inter 400; the one line of mission vocabulary ("orbital period ·
  1 year", the manifest's own phrase) is JetBrains Mono. All text is outlined
  in the SVGs, so GitLab and GitHub render them without any web font.
- Tagline kept as "Everything in your orbit, on track." — see the question at
  the end: CON-11 records a different strapline for the README.
- Every colour is a pack token (`web/src/lib/packs.css`) or a value from the
  ratified brand page (`design/mockups-brand-decision.html`).
- Banners are 1600×840, as SVG and as a PNG export.
- The logo must read on a white page and a dark page from one file, because
  the README cannot know which theme the reader uses. Each option answers that
  differently (below) — none relies on `<picture>` / `prefers-color-scheme`,
  which GitHub supports but is not guaranteed on every GitLab renderer.

## A · Chart-room

`a-logo.svg` · `a-banner.svg` · `a-banner.png`

The product is the picture. The banner is the home screen's gravity-well dial
— the graticule, the twelve month ticks, the dashed perihelion threshold, the
sun and the ratified sample bodies — carried verbatim from
`design/v19/home.html` and set on the star-chart void with the product's own
seeded starfield (`sky.js`, seed 17170812). The horizontal lockup (the brand
page's "app chrome, README" cut) sits to the left with the tagline and the
mono mission line beneath it.

The logo is the mark on a rounded star-chart tile — the same family as the
shipped app icon (`web/static/icon.svg`), with the centre restored because 52px
and 132px can carry it. The tile brings its own ground, so it reads the same on
white and dark pages.

Why it fits v19: star-chart is the primary identity and the dial *is* the
identity ("the same drawing is the mark, the dashboard hero, and the
explanation of the product"). The bodies keep their POL-14 materials because
this is a depiction of the chart, not of the mark; the dial's own palette was
ratified with the home screen, so no new data palette was introduced or
validated here. The dial does not carry the sample household's name under the
sun — the README is public, and that choice is the owner's (question below).

## B · One ink

`b-logo.svg` · `b-banner.svg` · `b-banner.png`

The printed plate. One navy ink on the brand page's atlas paper, the mark large
and the word beside it, with the quiet furniture of a chart sheet: an inset
hairline frame, three concentric hairline circles about the mark's centre, and
twelve ticks on the outermost — the month ring, drawn as ruling rather than as
a chart. The mission line is set upper-case mono, the way a plate caption is.

The logo is the bare mark, no plate, in a single ink: `#737e9e`, star-chart's
lifted faint ink — the ink the dial's graticule and month labels are drawn in.
It is a mid-tone on purpose: about 4.0:1 on white and 4.6:1 on GitHub's dark
page, so one transparent file reads on both.

Why it fits v19: the brand page ratifies both the one-ink reduction ("print,
embroidery") and the light "atlas paper, invoices, email" treatment; this is
those two, unchanged, at banner scale. It is the option that proves the mark
survives with no sky at all.

## C · Daybreak

`c-logo.svg` · `c-banner.svg` · `c-banner.png`

The horizon. The dawn pack's temperature story as a banner: cool overhead
warming to the pale amber horizon (the pack's five sky stops, top to bottom),
the ember sun blooming below the bottom edge, the dark-ink stars thinning out as
the sky warms. The lockup is stacked — mark over word over tagline — the
sign-in's composition, but with the centre filled and the word *under* the ring
rather than inside it, because the sign-in's exemption to CON-19 applies to the
sign-in only.

The mark takes dawn's tokens: ring in `--ink-faint`, centre in `--sun` (the
ember), planet in `--accent`. The logo is the same mark on a round disc of the
same sky gradient — the gradient is the pack's sky, not the mark, which stays
flat. On a white page the disc reads as a soft sky; on a dark page it reads as
a bright disc.

Why it fits v19: dawn is a shipped, ratified pack with its own identity (the
terminator treatment, §15), and this is the one option that shows the README
reader the product has a daylight face. It is also the warmest of the three.

## Rebuilding

`build.py` generates the six SVGs and `index.html` (needs fonttools, brotli and
uharfbuzz; `FONT_DIR` must hold `SpaceGrotesk-wght.ttf`,
`inter-latin-wght-normal.woff2` and `jetbrains-mono-latin-wght-normal.woff2`
— the files already in the project's pnpm store and `tmp/fonts`).
`render.cjs` exports the PNGs and the review screenshots with Playwright's
Chromium. Nothing here is wired into the repo README or `public/` — that waits
for the pick.

## Questions for the owner

- **Strapline.** The brief says keep "Everything in your orbit, on track."
  CON-11 (approved 2026-08-13) records *"your year, in orbit"* for "surfaces
  that want words (README, launcher splash)". Which line does the README carry?
- **The sample household's name** (A only). `home.html` prints "Lawson Home"
  under the sun. Left off the banner as it is public; say if it should go back.
- **Motion.** CON-19 allows the planet to drift once per 40s on live surfaces.
  An SVG in a README `<img>` can animate. Is the README a live surface?

## Verdicts

Owner, 2026-10-01, recorded on #1177:

- **9d — none of A, B or C.** "These are all super boring."
- **13a — the light looks (B One ink, C Daybreak) don't fit the dark brand.**
  Round 2 is dark only, like the app.
- **12a — the tagline is "your year, in orbit"** (CON-11).

Nothing survives as a feature idea from this round; round 2 starts again,
bolder, in `../round-2/`.
