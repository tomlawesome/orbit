# What the belt is for — round 8 (#1304): a colour per section and type

Round 7's verdict, verbatim in `../round-7/README.md`: "I think we could
make better use of colour to differentiate between options. Over time
users would associate colours with specific type/sections." From this
round on, mockups open in after dark (owner, 2026-10-08).

- `m-colour-per-option.html` — round 7 with a colour for each section
  (Home orange, Vehicles teal, Devices violet, Services magenta) and each
  type (service lime, renewal rose, inspection cyan), as tokens in every
  pack. A tile at rest is glass washed in its colour and edged in it; the
  chosen tile is filled solid. The same colour marks the section and type
  words in the drawer (read and edit) and the section word on every
  manifest row, so the association is learned where it is read. The dial
  is untouched: its colours mean urgency.

Scenes `?scene=`: `editing-section`, `editing-type`, `open`,
`narrow-editing-section` (view at 390x844), plus the rest. Packs by
`?theme=`.

## Notes from the build

- Palettes checked with the dataviz validator on each pack's tile
  surface: sections and types each pass, colour-blind views included.
  Across the two sets some pairs sit close (inspection cyan and Vehicles
  teal); they never share a list.
- Kept apart from the urgency colours (overdue, due soon, upcoming, on
  track); in the light packs the separation is smaller.
- 130 rendered contrast checks, all coloured text and chosen tiles at
  4.5:1 or better, in all five packs.

## Verdicts (owner, 2026-10-08)

> approved.

M is ratified: the editing choosers are settled (owner-decisions §34).
