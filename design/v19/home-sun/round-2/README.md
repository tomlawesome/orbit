# #1250 — the sun at the dial's centre · round 2

Round 1 (three treatments of the name) was dropped: owner, 2026-10-06, "None,
they're all awful. Look at the planets on orbit-site, that's the kind of
fidelity I want for the sun, and the text is then probably fine."

So this round renders the sun itself, the way orbit-site renders the door's
planets (`tools/planets.py`): from real maps, supersampled, lit in linear
light, the film's shoulder `1 − e^(−1.6x)`, light beyond the body carried as
alpha so it adds over the sky. The name stays as today: Inter 10 units in
`--ink-mid` at y=212 on the desk (`+page.svelte:1519`), 15 units at y=218 in
the pocket (`pocket.svelte:830`), lifting to `--ink` on hover; the sun and the
name remain one link (`design/v19/home.html:328`). The long name is broken at
its hyphen into two lines, as the build would measure it; the app today sets
it on one line, which overflows the dial.

## What every page proves

The same crop as round 1: dial units 95–285 × 112–278 of the 380-unit dial,
desk 640 px dial (1.684 px/unit), phone 358 px dial (0.942 px/unit). Danger
ring r=62, inner ring r=106, three static bodies. Packs: star chart, dawn,
retrograde (after dark and clouds follow by token). Names "The Lawsons" and
"The Fitzwilliam-Hargreaves Household". Fonts are the app's own, copied from
`web/node_modules` into `fonts/`.

The sun's disc is r=9.5 units (today: a r=7 core in a r=13 blurred glow;
pocket r=8 in r=16). Each picture is 320 px square with the disc 36 px in
radius, so the page sizes it at 320/72 × the disc (84 units); the light beyond
the disc fades out before the picture's edge.

## The three directions

Every picture is made by `sun.py` (numpy, Pillow, scipy; `python3 sun.py`),
from the frames in `src/`. The pages are written by `build.py` from one
scaffold.

### photosphere.html — the Sun in white light
The disc is SDO/HMI's intensitygram of 2024-05-10 12:10 UTC: its own limb
darkening and the sunspot group AR 3664 (the one that lit that month's
aurorae), graded limb → `--sun` → `--sun-core`. A thin chromosphere at the
rim (`#ff6e3a`; cyan `#4fe3ff` on retrograde). The K-corona and the lens's
bloom are a second picture laid under the disc: Baumbach's two terms with the
outer one lifted as eclipse photographs are stretched, streamers from value
noise in angle × log r (the same construction as `voyage.js`'s star).
Life: the corona layer turns once in 180 s and breathes at the app's 4.2 s
(`.breathe`); the disc never spins. Hover pauses the turn and holds the glow
full. Reduced motion: both still.
Dawn: the sunrise sun — air-reddened amber, no corona (you do not see the
corona at sunrise), a warm haze on the paper, a deeper rim. The disc stays
darker than the paper so the mark holds (`design/v19/home.html:150`, "the
centre is a low ember"), and it is the one thing that glows there
(`dawn-cloudsea.html`).

### chromosphere.html — the Sun in the light of helium
The disc is SDO/AIA 304 Å: the chromosphere's bright network, active regions,
filaments, prominences kept beyond the limb as light; the inner corona's
loops from AIA 171 Å under the streamers. Three frames an hour apart (12:08,
13:07, 14:09 UTC) cross-fade in a 36 s loop (2.2 s fades), so what moves is
the Sun's own motion. Graded gold on the chart (`#b86a14 → #f0b429 →
#fff3dc`), amber ember on dawn, magenta on retrograde. Reduced motion: the
first frame only.

### furnace.html — a star, modelled and alive
No photograph. A physically-based model drawn live by a small WebGL shader:
Pierce & Slaughter's limb darkening at 5500 Å, convective granulation (two
octaves of value noise, cells foreshortened towards the limb, convecting in
time), a spot group with penumbrae, faculae brightening towards the limb, the
chromosphere rim, the streamer corona drifting, the bloom in closed form, the
film's shoulder. `sun.py`'s `furnace()` runs the same formulas once for the
still that stands in under reduced motion or without WebGL. Per frame: one
quad the picture's size (≤ 256 px square at 2×), ~40 noise lookups a pixel.
On dawn the shader draws the paper branch (haze, no corona).

## Sources and licences

NASA/SDO browse images, 1024 px, 2024-05-10 (credit "NASA/SDO and the AIA
and HMI science teams"; NASA imagery is in the public domain, credit
requested, no restriction on commercial use). Exact files, kept in `src/`:

- `20240510_121038_1024_HMII.jpg` — HMI intensitygram (photosphere)
- `20240510_120854_1024_0304.jpg`, `20240510_130730_1024_0304.jpg`,
  `20240510_140930_1024_0304.jpg` — AIA 304 Å (chromosphere), the time-lapse
- `20240510_120710_1024_0171.jpg` — AIA 171 Å (inner corona loops)

all from `https://sdo.gsfc.nasa.gov/assets/img/browse/2024/05/10/`.

Considered and not used: SOHO/LASCO C2 for the outer corona — SOHO is an
ESA/NASA project and its image terms ask consent for commercial use, which
the app's AGPL self-hosting would have to carry; the outer corona here is
modelled instead. The limb-darkening coefficients are Pierce & Slaughter
(1977) as quoted in `voyage.js`; Baumbach (1937) for the corona's fall-off.

## Picture sizes (bytes, as shipped)

| picture | star chart | dawn | retrograde |
|---|---|---|---|
| photosphere disc | 2,958 | 15,112 | 3,132 |
| photosphere corona layer | 15,884 | — (none on paper) | 19,436 |
| chromosphere frame 0 | 17,068 | 15,352 | 19,474 |
| chromosphere frame 1 | 16,880 | 15,408 | 19,368 |
| chromosphere frame 2 | 17,040 | 15,340 | 19,556 |
| furnace still | 15,776 | 15,560 | 19,542 |

Per pack on the wire: photosphere 18,842 B (chart), chromosphere 50,988 B (chart), furnace 15,776 B (chart) plus about 4 KB of shader and glue. All pictures 320 px square, WebP quality 86. Today's sun costs nothing but two circles and a blur filter.

## Screenshots checked (shots/)

`photosphere-desk.png`, `chromosphere-desk.png`, `furnace-desk.png` at 1440
wide, 2×; `*-phone.png` at 390 wide, 3×; `*-desk-still.png` at 1440 with
reduced motion requested (the furnace shows its still, the chromosphere its
first frame, the photosphere's corona stands). Each cell was also shot as an
element at full density and looked at up close. Three passes: the first found
the dark packs' discs blown to near-white (exposure too high for the film's
shoulder), the furnace's granules too fine to read at dial scale, and the
phone's long name crossing the amber body; the second re-exposed, coarsened
the granules, broke the phone's long name at three lines and faded the dawn
haze before the picture's edge; the third is what is here. Known and left: on
the phone the long name's third line touches the danger ring, as it did in
round 1. No data palette is involved, so the dataviz validator does not apply.

## For the owner to rule on

- The disc's size: r=9.5 units here (today's core is r=7). Larger shows more
  of the Sun; the name's clearance on the desk is then about 7 px.
- Which direction, or a cross: the photosphere's real disc with the furnace's
  live corona is a cheap pairing (the furnace shader can take a texture).
- Whether the sun on dawn may keep sunspots: they are the only marks on a
  pale ground and read as blemishes to some eyes.
- The long name wraps at its hyphen here; today it does not wrap at all.
- Noticed, not changed: the pocket's sun is hard-coded `#fff6e6`
  (`pocket.svelte:828`), so a shipped picture per pack replaces that too.

## Owner verdict (2026-10-06)

"Hmm chromosphere but ensure all stay on record as they're all good options."

Chromosphere is chosen and goes into the app (#1250). Photosphere and Furnace are kept here as good options, not dropped.
