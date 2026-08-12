# Design polish register

Every polish behaviour in the mockups (and later the product) is a named,
individually-removable unit. In mockup code each is delimited by
`/* POL-n: name */ ... /* /POL-n */` blocks (CSS and JS) and
`data-polish="POL-n"` attributes (markup), so removing one is deleting its
blocks — nothing else touches it. Status changes are recorded here, never
silently.

| ID | Name | What it does | Status |
| --- | --- | --- | --- |
| POL-1 | Arrival | Mark glyph expands into the dial on first load; once per session; reduced-motion skips | queued for v9 |
| POL-2 | Perihelion ping | Faint radar-ripple per breath once a body crosses T−7d | queued for v9 |
| POL-3 | Current-month glow | The present month's label reads a shade brighter | queued for v9 |
| POL-4 | Bidirectional highlight | Hover a manifest row ↔ its dial body lights up | queued for v9 |
| POL-5 | Constellations | Hovering a section header draws its bodies' constellation lines | queued for v9 |
| POL-6 | Chart callout | Glass-backed, 13.5px, quadrant-aware placement so the leader never crosses the cluster | revised in v10 |
| POL-7 | Restored orbit | Completing an item drifts its body outward with a brief comet trail | queued for v9 |
| POL-8 | The quiet state | Rewritten in v10: no words — danger fades, sun warms, stars thicken and twinkle, slow meteors | in v10 |
| POL-9 | Command palette | explore-your-world field focuses on ⌘K; matches items and actions | queued for v9 |

| POL-10 | Storm state | Heavy load un-calms the sky: faster turbulent drift, deepened danger well, pulsing threshold, cooled sun | added in v10 |


## Concepts (captured, not yet product scope)

| ID | Name | Concept | Status |
| --- | --- | --- | --- |
| CON-1 | Belts = documents | A belted planet carries attached documents; clicking the belt opens the document view from the dial | ratified by owner 2026-08-13; in v11 |
| CON-2 | Sub-systems & zoom | Assets (a car, a boiler, a property) as small orbital systems with their own centre; clicking the centre zooms into that asset's own dial | captured; strongest use = per-asset drill-down |
| CON-3 | Shape = type | ● routine service · ◆ renewal/contract · ▲ inspection/certification; hollow = suggestion in any shape | in v11 |
| CON-4 | Ambient count | The urgent count lives in the tab title and PWA app badge, never on the sky | recorded for implementation |

Removal procedure: delete the POL-n blocks from the current mockup/product
code, flip the row to `removed (date, reason)`. Keep the row — the register
is the memory of what was tried.
