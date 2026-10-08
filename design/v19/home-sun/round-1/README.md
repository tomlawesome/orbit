# #1250 — the household's name under the sun · round 1

Owner, 2026-10-06: "I hate the styling of this. It's so plain." Today the name is
Inter at 10 dial units (16.8px desk, `+page.svelte:1519`) / 15 units (14.1px
phone, `pocket.svelte:830`) in `--ink-mid`, under the sun. The sun and its name
are one identity and one hit target (`+page.svelte:1494–1508`).

Scope (owner change, same day): three directions, the dial centre only — sun,
name, and just enough dial to read in context. No sky, manifest or chrome.

## What every page proves

Same crop in every cell: dial units 95–285 × 112–278 of the app's 380-unit
dial, at the app's real scales — desk 640px dial (1.684 px/unit), phone 358px
dial (0.942 px/unit, the pocket's full-width column on a 390 phone). Danger
ring r=62, inner ring r=106, three static bodies, the sun's bloom breathing
(`pocket-sun`, 4.2s). Packs: star chart, dawn, retrograde (after dark and
clouds follow star chart and dawn respectively by token). Names: "The
Lawsons" and "The Fitzwilliam-Hargreaves Household". Line breaks are hand-set
for the data story; the build would measure and break at spaces and hyphens
inside a ~140-unit fit box.

Fonts are the app's own, copied from `web/node_modules` into `fonts/`: Space
Grotesk 500/600, Inter Variable, JetBrains Mono Variable (`packs.css:16–19`,
`+layout.svelte:33–36`). Nothing else is loaded.

Rulings respected: the 12px floor, 12px only for tracked caps
(`pocket/tokens.css:8`); words carry 4.5:1 via the text-grade companions
(#491, "accessibility wins in all cases", `owner-decisions.md:595`); on the
light packs the sun is the one thing allowed to glow and paper has no
specular (`home.css:15–26`, `1164–1170`); the identity is one link.

## Directions

### sunlit.html — the name in the sun's own light
Space Grotesk 600, sentence case, filled with `--sun`; on the dark packs a
blurred copy of the text breathes behind the letters at the sun's own rhythm.
On dawn/clouds no glow: plain warm ink. Desk 12 units (20px), phone 16 units
(15px); long name wraps to three lines inside the danger ring. Hover lifts the
fill to `--sun-core` (dark) / `--ink` (light). Retrograde takes its bloom
drop-shadow as the accent already does (`home.css:879–884`).
Borrows: the sun tokens, `.breathe`/`pocket-sun`, the display face from
`.adrift h2`.

### catalogue.html — the star's designation, in the chart's voice
JetBrains Mono tracked caps in `--accent-text`, with a hairline accent rule
either side of the first line, drawn in on arrival (1.1s, dashoffset).
Desk 8.5 units / .18em (14.3px), phone 13 units / .16em (12.2px — the tracked
caps floor). The rule stops inside the danger ring and only appears when the
name leaves at least 10 units of room, so the long name and the phone's short
name stand without it. Borrows: the manifest TODAY line (`home.css:782–783`,
11px mono, .18em, 40% accent rule), the month marks, the comet draw-in.

### masthead.html — a crest with the family name large
"THE" and "HOUSEHOLD" demoted to tracked mono eyebrows in `--ink-quiet`
(desk 7.5 units = 12.6px, phone 13 = 12.2px); the name itself in Space Grotesk
600 `--ink` (desk 15 = 25px, phone 18 = 17px), breaking at its hyphen. Hover
turns the eyebrows to `--accent-text`. Borrows: the pocket's caps/title pair
(`--p-type-caps` + `--p-type-title`), the chart's quiet ink.

## Contrast (WCAG, name colour on the crop's ground)

| direction | star chart | dawn (sky-2, the cool stop) | retrograde |
|---|---|---|---|
| sunlit | 16.5:1 | 5.2:1 ¹ | 6.9:1 |
| catalogue | 9.9:1 | 5.7:1 | 6.9:1 |
| masthead name / eyebrow | 16.7 / 6.6:1 | 9.9 / 5.2:1 | 18.1 / 12.8:1 |

¹ The app's `--warm-text` (70/30 with black, #854) measures 4.25:1 on sky-2,
where the dial sits; the mock uses a 60/40 cut (#73400b). Proposed as the
text-grade companion for this surface if sunlit is chosen. No data palette is
involved, so the dataviz validator does not apply.

## Screenshots checked (shots/)

`sunlit-desk.png`, `catalogue-desk.png`, `masthead-desk.png` at 1440 wide;
`sunlit-phone.png`, `catalogue-phone.png`, `masthead-phone.png` at 390 wide,
3× density. Two passes: the first found masthead's phone long case clipped at
the crop edge and its eyebrow touching the sun, and catalogue's rule crossing
the dashed ring (and racing the screenshot); all fixed, re-shot, re-checked.

## For the owner to rule on

- Masthead needs one rule for which words are eyebrows: exact leading "The "
  and trailing " Household" only, everything else is the name. A name without
  them (e.g. "Flat 3b") shows as a single large line.
- Sunlit on the light packs is warm ink without glow (the engraving law);
  say if the light packs should instead keep `--ink` and lose the sun colour.
- Noticed, not changed: the pocket sun is hard-coded `#fff6e6`
  (`pocket.svelte:828–829`), so on dawn the phone's sun is cream, not the
  desk's amber. The mocks use `--sun`/`--sun-core` on both.
- Long names spill past the danger ring on the phone in every direction
  (three lines at the floor need ~56 units of height); the overdue bodies
  that orbit inside r=62 already share that space with today's name.

## Owner verdict (2026-10-06)

"None, they're all awful. Look at the planets on orbit-site, that's the kind of fidelity I want for the sun, and the text is then probably fine."

All three directions dropped. Round 2 renders the sun itself at the fidelity of orbit-site's planets; the name's styling stays as today unless the new sun needs it to change.
