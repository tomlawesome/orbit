# Home sky · round 4: log distance, permanent labels, driving date, importance colour

Issues: #1464 (log scale), #1461 (permanent labels), #1462 (driving date),
#1463 (colour shows importance); #1471 (the event horizon's name) is used as
the name of the overdue floor. Date: 2026-11-01. Directions G, H, I (letters
run on from round 3's, and from F in the belt rounds).

## The problem

The home sky places a planet by linear lead time, radius = 62 + 0.242 x days,
capped at the rim (166). Everything past about 430 days piles on the rim,
the near items crowd inside a few dial units of each other, names appear only
on hover, the dial always runs off the due date, and the planet colour spends
itself on urgency, which distance and the T-label already say.

## Shared decisions (lane design, for the owner's verdict)

Quoted from the brief. They are the same in all three files.

- The desk home sky as today after dark: sun at the centre, rim at 166,
  drawn in inline SVG from the Harlow Home items. Same items, positions and
  sizes in every file.
- Distance is logarithmic. For an item d days ahead,
  `radius = 62 + (166 - 62) * ln(1 + d/tau) / ln(1 + D/tau)`, close-up (τ) = 30
  days and horizon D = 730 days as the starting values; beyond D the planet
  sits on the rim.
- Overdue items (d < 0) fall inward on the mirror curve toward the event
  horizon at radius 24:
  `radius = 62 - (62 - 24) * ln(1 + |d|/tau_o) / ln(1 + 60/tau_o)`, with
  tau_o = 7 days, clamped at 24. "The event horizon" (#1471) is the r=24 dashed
  line inside the sun clearance. In today's app the dashed ring at r=62 carries
  that name; here that ring is captioned "today" and the name goes to r=24, as
  the brief says. Say if that should be swapped back.
- Size still shows yearly cost, today's power curve (`bodySize`): desk range
  3.5 to 13 dial units, phone range 5 to 12.
- Bearing is today's law: one degree a day from twelve o'clock, clamped
  to -90..430 days.
- Each file also has the phone sky at 390 x 844 as a second scene, same data.

## Data story

Harlow Home from `web/src/lib/data/fixtures/workspace.js`, items as they are,
dates relative to the fixture's pinned today, **2026-08-13**. Active items:

| item | due | days | yearly cost | docs | importance (H, I) |
|---|---|---|---|---|---|
| Gutter clearing | 2026-07-28 | -16 (overdue) | 150.00 | 0 | high |
| Car MOT, Volvo V60 | 2026-08-29 | 16 | 54.85 | 2 | high |
| Boiler service | 2026-09-04 | 22 | 120.00 | 0 | normal |
| Chimney sweep | 2026-10-13 | 61 | 90.00 | 0 | low |
| Roof replacement | 2026-11-21 | 100 | 50,000.00 | 1 | high |
| Smoke alarm batteries | 2026-12-13 | 122 | 24.00 (12 twice a year) | 0 | low |
| Car full service | 2027-01-21 | 161 | 300.00 | 2 | not set |

**Seven planets, all inside the next two years; fewer than the nine the brief
hoped for, and none invented.** Nothing in the fixture sits beyond D = 730
days, so "beyond D sits on the rim" can be seen only by lowering the horizon
slider (G, D down to 180 pushes Car full service and Smoke alarm batteries
toward the rim). The importance column is the mock-up's own: the fixture has
no importance field. Three high, two low and one not set is the brief's split;
with seven items that leaves one normal, so "most normal" could not be met
(see the decisions below). Overdue by due date: only Gutter clearing.

G's panel has a "Demo items" switch (household only / plus far-off extras), off by default; the extras are invented for the scale question only, because seven items none beyond two years cannot show how far-off items crowd the rim. They are, in days from today and yearly cost: Window cleaner -3 d £180, Bike service -20 d £60, TV licence 2 d £170, Water softener salt 4 d £90, Home insurance 12 d £640, Car insurance 18 d £720, Gas safety certificate 45 d £95, Smoke alarm replacement 60 d £40, EICR electrical check 120 d £180, Driving licence (Sam) 200 d £14, Passport (Alex) 280 d £88, Boiler warranty 420 d £0, Roof guarantee 540 d £0, Mortgage fix ends 800 d £0, Passport (Sam) 1100 d £88, Will review 1500 d £250.

## The directions

### G, log tuner (`g-log-tuner.html`): #1464, #1462, #1461 together, interactive
The desk sky with a control panel beside it, not over it. Slider for the close-up
tau (7 to 90 days), slider for the horizon D (180 to 1095 days), a switch
"linear (today) / log", a switch "due date / my warning date" (warning date =
due date minus 30 days for every item in the mock-up, labelled so), and a
three-way label switch "off / near only / all". Readouts show the current tau,
D and the radius of the 7-, 30-, 90- and 365-day marks (dial units, and px at
the desk scale). Faint rings at 7, 30, 90 and 365 days with tiny day labels
move with the sliders. "Near only" labels the planets inside the 30-day ring
(overdue ones are inside it); "all" labels every planet. Labels are 12 px in
the ink-2 tier, set just outside the planet on its radial line away from the
sun; when two would overlap, the outer one shifts along its ring by the
smallest angle that clears, with a 1 px hairline leader if it moved more than
its own height (14 px). The phone scene is the same sky at the starting
values, labels "near only", no panel: the controls are desk-only. Planets are
coloured by urgency band as today, and the band follows the real due date even
when the warning date drives the position, so a planet inside its warning
window is not painted as overdue.

Deep links for reproducing a state: `?tau=14&labels=all`, `?mode=linear`,
`?driver=warn`, `?D=365`, `?scene=phone`, `?extras=on` (the demo items; with them
on, planets that would touch are also nudged apart by angle, smallest shift first;
`shots/g-desk-extras-tau10-d365.png`).

### H, importance as weight (`h-importance-weights.html`): #1463
One hue family. High = the after-dark accent at full strength with a 2 px
outer ring; normal = the accent at 70%; low = the ink-3 tier (muted). An
overdue planet keeps its colour and gains a slow 2 s pulse of its ring; under
`prefers-reduced-motion` there is no pulse and a dashed ring instead
(`shots/h-desk-reduced.png`). A planet with no importance yet is drawn in the
ink-4 tier with a dotted outline and the callout line "importance not set".
Legend under the sky: "Colour shows importance · distance shows time · size
shows yearly cost", with a four-swatch key beside it.

### I, importance as hue (`i-importance-hues.html`): #1463
The same scenes with three distinct hues: high = ember (warm orange-red,
`#ff6a3d`), normal = the accent (`#7dd3fc`), low = slate (`#7b8da6`). No ring
for high; hue alone. The same overdue pulse, the same not-set treatment, the
same legend.

Importance assignment, the same in H and I: **high**: Gutter clearing, Car MOT,
Roof replacement. **normal**: Boiler service. **low**: Chimney sweep, Smoke
alarm batteries. **not set**: Car full service.

Both show, on hover, today's callout (title, "T-minus · cost", documents
chip) plus a fourth line naming the importance (the hovered planet's tier, or
"importance not set"). The shot draws it open on Car full service, so the
not-set line and the chip are both visible. The phone has no hover (two taps
open a planet in the app), so its scene has no callout.

## Scenes

G: desk at defaults, desk at tau = 14 with labels "all", desk linear, phone.
H: desk, phone. I: desk, phone. Also, beyond the required eight: G desk with
the warning date and labels "all", and H desk under reduced motion.

## Tokens

After dark, from `packs.css` `[data-theme=afterdark]`: ground `#05070d`,
ink `#e7e9ee`, accent `#7dd3fc`, overdue `#f87171`, warm `#f0b429`, ok
`#4ade80`. The brief's ink tiers are mapped as ink-2 = `--ink-mid` `#9fa6b2`,
ink-3 = `--ink-faint` `#717c8e`, ink-4 = `#4a5468`, which is the pack's
pre-lift faint tone, not a live token (ink-4 only fills and outlines the not-set
planet, never text). Fonts are the app's own, copied from round 3 (Inter
Variable, JetBrains Mono). The dataviz validator was not run: no categorical
data palette is proposed; H and I are ordinal importance tiers on three
colours, and judging whether ember, accent and slate stay apart for colour-blind
readers is for the owner's eye on the shots.

## Capture notes

`PW=<orbit checkout>/node_modules/.pnpm/playwright@1.63.0/node_modules/playwright node capture.mjs`
(plain `require('playwright')` does not resolve from inside the worktree, so
`PW` points at the main checkout's install, read-only; it needs no
`playwright install`). `python3 build.py` regenerates the three HTML files from
`src/core.css` and `src/core.js`. **10 shots in `shots/`** (eight required, two
extra), desk 1600 x 1000, phone 390 x 844, PNG, kept in git as round 3's were.
Animations are paused at 0.9 s into the pulse so the ring shows mid-expansion;
it is faint by nature, so judge it live.

**All 10 were looked at.** Fixed after looking: the "event horizon" caption sat
on the household name (moved just under the ring); labels pushed radially away
from their planet (now they stay on the planet's ring and only shift along it,
with a leader when moved more than their height); labels touched H's outer ring
(label padding added for H and I); the callout's pointer line missed its planet
because the card is taller than today's (card now centred on the planet); the
pulse was hidden behind H's high ring at the first frame (it now expands to 2.3x);
a wrapping readout line in the linear view; stub leaders under 7 px (dropped).
Known and left: on the phone the Car MOT and Boiler labels stack tightly over
their two planets (they are 6 days apart, and the bearing is a degree a day);
under the warning date the MOT and Boiler planets sit close to touching, and
in linear mode (today's sky) they do touch, which is the problem the log scale
is meant to ease only in distance, not bearing; the desk shots leave the lower
third of the screen empty, as the dial is held at today's 640 px.

## Decisions taken without the owner

- Importance split: the brief says three high, "most" normal, two low, one not
  set, which needs ten or more items; Harlow has seven. Kept the counts for high,
  low and not set and left one normal. Cost if wrong: the 70% accent tier is
  shown by a single small planet; the owner may want a bigger spread.
- Event horizon naming moved to r=24 (see above).
- H and I show labels ("all" on desk, "near only" on phone) so the colours can
  be read against names; the owner may want them off to judge colour alone.
- High gets the 2 px ring in H only; I is hue alone.
- Warning date moves bearing as well as radius, as the date drives the whole
  placement; colour keeps the real due-date band.
- The callout in the shots is open on Car full service, not on a high planet.

## Owner verdicts

Recorded 2026-11-01, from the dialogue on the lane issues; the artifact
copy of the round was shared with a third-party tester the same day.

- **Distance scale (G):** log, close-up 14 days, horizon 365 days, as
  Orbit's defaults ("For the log scale, 14 days/365 days should be the
  default"). #1464; owner decision 37.
- **Importance colouring (H versus I):** neither wins. The owner asked why
  the two cannot both remain user-selectable, so what planet colour means
  becomes a per-user setting with both palettes kept; the default is the
  weight palette (H), a lane call recorded on #1463 for the owner to
  overrule.
- **Planet labels:** not three states but a per-user number of days: a
  planet due in that many days or fewer shows its name, later ones hide
  it; the slider's top end means every name, zero means none. #1461.
- **Categories (#1466):** 6a. The type picker goes; the form asks how the
  item repeats, and sections are the categories.
